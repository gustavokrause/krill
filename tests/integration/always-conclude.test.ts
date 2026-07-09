import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  cleanData,
  createProject,
  createTask,
  db,
  tables,
} from "../helpers/setup";
import { task_decide, task_escalate, task_resolve } from "@/claude/mcp-tools";
import { listBlockers } from "@/workflow/blockers";
import { StubClaudeRunner } from "@/claude/stub-runner";
import type { ClaudeRunner } from "@/claude/runner";
import { setRunner } from "@/claude";
import { runAiReview } from "@/workflow/stages/ai-review";
import { getBootId } from "@/workflow/boot-id";
import { releaseOrphanedClaims, runStuckScanner } from "@/workflow/stuck";

let sandbox: string;

before(() => {
  setRunner(new StubClaudeRunner());
  cleanData();
});

beforeEach(() => {
  cleanData();
  sandbox = mkdtempSync(join(tmpdir(), "ai-conclude-"));
});

after(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

const row = (id: string) =>
  db.select().from(tables.tasks).where(eq(tables.tasks.id, id)).get()!;

const nowSec = () => Math.floor(Date.now() / 1000);

function ctx(taskId: string, stage: "implementing" | "ai_review") {
  return {
    token: "test-token",
    taskId,
    stage: stage as never,
    expiresAt: nowSec() + 60,
  };
}

// A runner that succeeds but never calls task_decide — the "no verdict" case.
// The task stays AI-REVIEW, which used to retry forever at review-model cost.
class NoVerdictRunner implements ClaudeRunner {
  async run() {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

test("runAiReview parks at NEEDS_REVIEW(stuck) after max no-verdict runs", async () => {
  setRunner(new NoVerdictRunner());
  try {
    const project = createProject({ slug: "AC", has_repo: false, folder_path: sandbox });
    const t = createTask(project, {
      name: "no verdict",
      status: "AI-REVIEW",
      mode: "non-dev",
      workspace_path: sandbox,
    });

    // Default max_ai_decline_cycles=3 → first two runs retry, third parks.
    await runAiReview("worker-r1");
    assert.equal(row(t.id).status, "AI-REVIEW", "1st incomplete run retries");
    assert.equal(row(t.id).claimed_by, null, "claim released for retry");

    await runAiReview("worker-r2");
    assert.equal(row(t.id).status, "AI-REVIEW", "2nd incomplete run retries");

    await runAiReview("worker-r3");
    const r = row(t.id);
    assert.equal(r.status, "NEEDS_REVIEW", "3rd incomplete run parks");
    assert.equal(r.pending_review_kind, "stuck");
    assert.equal(r.claimed_by, null, "claim cleared on park");
    assert.ok(
      listBlockers("open").some((b) => b.task_id === t.id),
      "brake filed an open blocker",
    );
  } finally {
    setRunner(new StubClaudeRunner());
  }
});

test("stuck scanner force-concludes past the hard cap, spares fresh and claimed tasks", () => {
  const project = createProject({ slug: "AC", has_repo: false, folder_path: sandbox });
  const limit = 900; // planning default max_stage_duration

  // Way past the hard cap (3×limit) and unclaimed → must park.
  const dead = createTask(project, {
    name: "dead",
    status: "PLANNING",
    stage_entered_at: nowSec() - (limit * 3 + 120),
  });
  // Past the soft limit but under the hard cap → notify only, stays put.
  const slow = createTask(project, {
    name: "slow",
    status: "PLANNING",
    stage_entered_at: nowSec() - (limit + 120),
  });
  // Same age as dead but held by a live claim of THIS process → in-flight,
  // must not be touched (the claimed_until bug the scanner used to have).
  const claimed = createTask(project, {
    name: "claimed",
    status: "PLANNING",
    stage_entered_at: nowSec() - (limit * 3 + 120),
    claimed_by: "worker-x",
    claimed_until: nowSec() + 600,
  });
  db.update(tables.tasks)
    .set({ claim_gen: getBootId() })
    .where(eq(tables.tasks.id, claimed.id))
    .run();

  runStuckScanner();

  assert.equal(row(dead.id).status, "NEEDS_REVIEW", "hard-cap task parks");
  assert.equal(row(dead.id).pending_review_kind, "stuck");
  assert.ok(
    listBlockers("open").some((b) => b.task_id === dead.id),
    "force-conclude filed a blocker",
  );
  assert.equal(row(slow.id).status, "PLANNING", "soft-limit task only notified");
  assert.equal(row(claimed.id).status, "PLANNING", "live-claimed task untouched");
  assert.equal(row(claimed.id).claimed_by, "worker-x", "live claim not released");
});

test("orphaned claims from a dead process are force-released", () => {
  const project = createProject({ slug: "AC", has_repo: false, folder_path: sandbox });

  const orphan = createTask(project, {
    name: "orphan",
    status: "IMPLEMENTING",
    claimed_by: "worker-dead",
    claimed_until: nowSec() + 1200,
  });
  db.update(tables.tasks)
    .set({ claim_gen: "pid-0-not-us" })
    .where(eq(tables.tasks.id, orphan.id))
    .run();

  const mine = createTask(project, {
    name: "mine",
    status: "IMPLEMENTING",
    claimed_by: "worker-live",
    claimed_until: nowSec() + 1200,
  });
  db.update(tables.tasks)
    .set({ claim_gen: getBootId() })
    .where(eq(tables.tasks.id, mine.id))
    .run();

  releaseOrphanedClaims();

  const o = row(orphan.id);
  assert.equal(o.claimed_by, null, "dead-process claim released");
  assert.equal(o.status, "IMPLEMENTING", "status untouched — next tick re-picks");
  assert.equal(row(mine.id).claimed_by, "worker-live", "own claim kept");
});

test("static-sufficient approve skips verify; explicit human choice untouched", () => {
  const project = createProject({ slug: "AC", has_repo: false, folder_path: sandbox });

  // Default-verify task + static_sufficient approve → verify skipped.
  const t1 = createTask(project, { name: "static", status: "AI-REVIEW", skip_verify: false });
  const r1 = task_decide(ctx(t1.id, "ai_review"), "approve", "types only", true) as {
    status: string;
  };
  assert.equal(r1.status, "PUBLISHING", "static-sufficient approve skips VERIFYING");
  assert.equal(row(t1.id).skip_verify, true);

  // Plain approve → verify still runs.
  const t2 = createTask(project, { name: "runtime", status: "AI-REVIEW", skip_verify: false });
  const r2 = task_decide(ctx(t2.id, "ai_review"), "approve", "logic change") as {
    status: string;
  };
  assert.equal(r2.status, "VERIFYING", "plain approve keeps VERIFYING");
  assert.equal(row(t2.id).skip_verify, false);
});

test("escalation past the lifetime cap skips the resolver and needs a human", () => {
  const project = createProject({ slug: "AC", has_repo: false, folder_path: sandbox });
  const t = createTask(project, { name: "forky", status: "IMPLEMENTING" });

  const esc = () =>
    JSON.parse(row(t.id).escalation!) as {
      resolver_tried: boolean;
      needs_human?: boolean;
      escalation_count?: number;
    };

  // Cycles 1..3 (max=3): escalate arms the resolver, resolve sends it back.
  for (let i = 1; i <= 3; i++) {
    task_escalate(ctx(t.id, "implementing"), `fork ${i}`, ["a", "b"]);
    assert.equal(row(t.id).status, "NEEDS_REVIEW");
    assert.equal(esc().resolver_tried, false, `escalation ${i} still gets the resolver`);
    assert.equal(esc().escalation_count, i);
    task_resolve(ctx(t.id, "ai_review"), "decided", `pick a (${i})`);
    assert.equal(row(t.id).status, "IMPLEMENTING", "resolver sent it back to work");
  }

  // Cycle 4 crosses the cap: resolver skipped, human required, line paused.
  task_escalate(ctx(t.id, "implementing"), "fork 4", ["a", "b"]);
  const e = esc();
  assert.equal(e.escalation_count, 4);
  assert.equal(e.resolver_tried, true, "resolver latched off past the cap");
  assert.equal(e.needs_human, true);
  assert.ok(
    listBlockers("open").some((b) => b.task_id === t.id),
    "cap escalation paused the line for a human",
  );
});
