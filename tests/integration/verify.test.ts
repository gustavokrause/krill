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
import { task_decide, task_set_acceptance, task_verify } from "@/claude/mcp-tools";
import { StubClaudeRunner } from "@/claude/stub-runner";
import { setRunner } from "@/claude";
import { runImplementing } from "@/workflow/stages/implementing";
import { runPlanning } from "@/workflow/stages/planning";
import { runVerify } from "@/workflow/stages/verify";

let sandbox: string;

before(() => {
  setRunner(new StubClaudeRunner());
  cleanData();
});

beforeEach(() => {
  cleanData();
  sandbox = mkdtempSync(join(tmpdir(), "ai-verify-"));
});

after(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

function verifyCtx(taskId: string) {
  return {
    token: "test-token",
    taskId,
    stage: "verify" as const,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  };
}

function aiReviewCtx(taskId: string) {
  return {
    token: "test-token",
    taskId,
    stage: "ai_review" as const,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  };
}

const row = (id: string) =>
  db.select().from(tables.tasks).where(eq(tables.tasks.id, id)).get()!;

test("AI-REVIEW approve routes to VERIFYING when not skipped", () => {
  const p = createProject({ slug: "VF" });
  const t = createTask(p, { name: "t1", status: "AI-REVIEW", skip_verify: false });

  const res = task_decide(aiReviewCtx(t.id), "approve", "looks good") as {
    status: string;
  };
  assert.equal(res.status, "VERIFYING");
  assert.equal(row(t.id).status, "VERIFYING");
});

test("AI-REVIEW approve skips straight to PUBLISHING when skip_verify", () => {
  const p = createProject({ slug: "VF" });
  const t = createTask(p, { name: "t1", status: "AI-REVIEW", skip_verify: true });

  const res = task_decide(aiReviewCtx(t.id), "approve", "ok") as { status: string };
  assert.equal(res.status, "PUBLISHING");
  assert.equal(row(t.id).status, "PUBLISHING");
});

test("task_verify pass → PUBLISHING", () => {
  const p = createProject({ slug: "VF" });
  const t = createTask(p, { name: "t1", status: "VERIFYING", skip_verify: false });

  const res = task_verify(verifyCtx(t.id), "pass", "built + tests green", "npm test → 0 fail") as {
    status: string;
  };
  assert.equal(res.status, "PUBLISHING");
  assert.equal(row(t.id).status, "PUBLISHING");
});

test("task_verify fail → IMPLEMENTING", () => {
  const p = createProject({ slug: "VF" });
  const t = createTask(p, { name: "t1", status: "VERIFYING", skip_verify: false });

  const res = task_verify(verifyCtx(t.id), "fail", "tenants.plan not persisted", "checkout → plan=null") as {
    status: string;
  };
  assert.equal(res.status, "IMPLEMENTING");
  assert.equal(row(t.id).status, "IMPLEMENTING");
});

test("task_verify rejects outside VERIFYING", () => {
  const p = createProject({ slug: "VF" });
  const t = createTask(p, { name: "t1", status: "IMPLEMENTING" });
  assert.throws(() => task_verify(verifyCtx(t.id), "pass", "x"), /VERIFYING/);
});

test("decline-brake parks at NEEDS_REVIEW(verify) after max verify cycles", () => {
  const p = createProject({ slug: "VF" });
  const t = createTask(p, { name: "t1", status: "VERIFYING", skip_verify: false });

  // Default max_ai_decline_cycles=3. Three fails should park at NEEDS_REVIEW.
  for (let i = 0; i < 3; i++) {
    task_verify(verifyCtx(t.id), "fail", `attempt ${i + 1}`);
    if (i < 2) {
      db.update(tables.tasks)
        .set({ status: "VERIFYING" })
        .where(eq(tables.tasks.id, t.id))
        .run();
    }
  }

  const r = row(t.id);
  assert.equal(r.status, "NEEDS_REVIEW");
  assert.equal(r.pending_review_kind, "verify");
});

test("IMPLEMENTING routes to VERIFYING when skip_ai_review and not skip_verify", async () => {
  const project = createProject({ slug: "VF", has_repo: false, folder_path: sandbox });
  const t = createTask(project, {
    name: "doc",
    status: "IMPLEMENTING",
    mode: "non-dev",
    skip_ai_review: true,
    skip_verify: false,
  });

  const out = await runImplementing("worker-impl");
  assert.equal(out, t.id);
  assert.equal(row(t.id).status, "VERIFYING");
});

test("IMPLEMENTING skips to PUBLISHING when skip_ai_review and skip_verify", async () => {
  const project = createProject({ slug: "VF", has_repo: false, folder_path: sandbox });
  const t = createTask(project, {
    name: "doc",
    status: "IMPLEMENTING",
    mode: "non-dev",
    skip_ai_review: true,
    skip_verify: true,
  });

  const out = await runImplementing("worker-impl");
  assert.equal(out, t.id);
  assert.equal(row(t.id).status, "PUBLISHING");
});

function planningCtx(taskId: string) {
  return {
    token: "test-token",
    taskId,
    stage: "planning" as const,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  };
}

test("task_set_acceptance is gated to PLANNING", () => {
  const p = createProject({ slug: "VF" });
  const t = createTask(p, { name: "t1", status: "PLANNING" });
  task_set_acceptance(planningCtx(t.id), "x must equal y");
  assert.equal(row(t.id).acceptance, "x must equal y");
});

test("PLANNING authors acceptance when absent, preserves an existing one", async () => {
  const project = createProject({ slug: "VF", has_repo: false, folder_path: sandbox });

  // No acceptance → the planning stub writes one.
  const a = createTask(project, {
    name: "needs DoD",
    status: "PLANNING",
    mode: "non-dev",
    skip_plan_review: true,
  });
  await runPlanning("worker-plan-a");
  assert.ok((row(a.id).acceptance ?? "").length > 0, "acceptance authored when absent");

  // Pre-set (whale/human) acceptance → planning leaves it untouched.
  const preset = "after checkout, tenants.plan = the bought tier";
  const b = createTask(project, {
    name: "has DoD",
    status: "PLANNING",
    mode: "non-dev",
    skip_plan_review: true,
    acceptance: preset,
  });
  await runPlanning("worker-plan-b");
  assert.equal(row(b.id).acceptance, preset, "existing acceptance preserved");
});

test("runVerify drives VERIFYING → PUBLISHING via the stub", async () => {
  const project = createProject({ slug: "VF", has_repo: false, folder_path: sandbox });
  const t = createTask(project, {
    name: "doc",
    status: "VERIFYING",
    mode: "non-dev",
    skip_verify: false,
    workspace_path: sandbox,
  });

  const out = await runVerify("worker-verify");
  assert.equal(out, t.id);
  assert.equal(row(t.id).status, "PUBLISHING");
});
