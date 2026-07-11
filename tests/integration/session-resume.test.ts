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
import {
  RESUME_MAX_AGE_S,
  parseSessionMap,
  pickResumeSession,
  recordStageSession,
} from "@/claude/resume";
import { StubClaudeRunner } from "@/claude/stub-runner";
import type { ClaudeRunner, RunnerInput, RunnerOutput } from "@/claude/runner";
import { setRunner } from "@/claude";
import { runVerify } from "@/workflow/stages/verify";

let sandbox: string;

before(() => {
  setRunner(new StubClaudeRunner());
  cleanData();
});

beforeEach(() => {
  cleanData();
  sandbox = mkdtempSync(join(tmpdir(), "ai-resume-"));
});

after(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

const nowSec = () => Math.floor(Date.now() / 1000);
const SONNET = "claude-sonnet-4-6";

function mapWith(entries: Record<string, { id: string; model: string; at: number }>) {
  return { session_map: JSON.stringify(entries) };
}

test("pickResumeSession: fresh same-model session resumes; guards hold", () => {
  const t = nowSec();
  const fresh = mapWith({ implementing: { id: "s-impl", model: SONNET, at: t - 30 } });

  // V2: verify inherits the fresh implementing session.
  assert.equal(pickResumeSession(fresh, "verify", SONNET, t), "s-impl");
  // V1: an implementing retry resumes its own prior session.
  assert.equal(pickResumeSession(fresh, "implementing", SONNET, t), "s-impl");

  // Stale (past cache TTL) → cold.
  const stale = mapWith({ implementing: { id: "s-old", model: SONNET, at: t - RESUME_MAX_AGE_S - 10 } });
  assert.equal(pickResumeSession(stale, "verify", SONNET, t), undefined);

  // Model boundary → cold (per-model prompt cache).
  assert.equal(pickResumeSession(fresh, "verify", "claude-opus-4-7", t), undefined);

  // AI-REVIEW never resumes — fresh-eyes review is deliberate architecture.
  assert.equal(pickResumeSession(fresh, "ai_review", SONNET, t), undefined);

  // Freshest candidate wins when several qualify.
  const both = mapWith({
    implementing: { id: "s-impl", model: SONNET, at: t - 120 },
    verify: { id: "s-verify", model: SONNET, at: t - 10 },
  });
  assert.equal(pickResumeSession(both, "verify", SONNET, t), "s-verify");

  // Kill switch: KRILL_RESUME=0 → always cold.
  process.env.KRILL_RESUME = "0";
  try {
    assert.equal(pickResumeSession(fresh, "verify", SONNET, t), undefined);
  } finally {
    delete process.env.KRILL_RESUME;
  }

  // Garbage session_map → cold, no throw.
  assert.equal(pickResumeSession({ session_map: "{not json" }, "verify", SONNET, t), undefined);
});

test("recordStageSession round-trips into the task row", () => {
  const project = createProject({ slug: "SR", has_repo: false, folder_path: sandbox });
  const t = createTask(project, { name: "s", status: "VERIFYING" });

  recordStageSession(t.id, "implementing", "sess-123", SONNET);
  recordStageSession(t.id, "verify", "sess-456", SONNET);

  const row = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get()!;
  const map = parseSessionMap(row);
  assert.equal(map.implementing?.id, "sess-123");
  assert.equal(map.verify?.id, "sess-456");
  assert.equal(map.implementing?.model, SONNET);
});

// Captures what the stage handler actually passes to the runner.
class CapturingRunner implements ClaudeRunner {
  inputs: RunnerInput[] = [];
  async run(input: RunnerInput): Promise<RunnerOutput> {
    this.inputs.push(input);
    return { stdout: "", stderr: "", exitCode: 0, sessionId: "sess-new" };
  }
}

test("runVerify passes a fresh implementing session as resumeSessionId and persists its own", async () => {
  const runner = new CapturingRunner();
  setRunner(runner);
  try {
    const project = createProject({ slug: "SR", has_repo: false, folder_path: sandbox });
    const t = createTask(project, {
      name: "warm verify",
      status: "VERIFYING",
      mode: "non-dev",
      skip_verify: false,
      workspace_path: sandbox,
      session_map: JSON.stringify({
        implementing: { id: "sess-impl", model: SONNET, at: nowSec() - 20 },
      }),
    });

    await runVerify("worker-sr");

    assert.equal(runner.inputs.length, 1);
    assert.equal(runner.inputs[0].resumeSessionId, "sess-impl", "verify resumed the impl session");

    // The run's own session id was persisted under its stage for V1 retries,
    // and the usage row (none here — no usage envelope) is not required for it.
    const row = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get()!;
    assert.equal(parseSessionMap(row).verify?.id, "sess-new");
  } finally {
    setRunner(new StubClaudeRunner());
  }
});
