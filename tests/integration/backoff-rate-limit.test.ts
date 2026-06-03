import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { cleanData, createProject, createTask, db, tables } from "../helpers/setup";
import {
  bumpBackoff,
  isBackoffActive,
  resetBackoff,
  snapshotBackoff,
} from "@/workflow/backoff";
import { tick } from "@/workflow/tick";
import { setRunner, getRunner } from "@/claude";
import { RateLimitError } from "@/claude/errors";
import { DEFAULT_API_ERROR_BACKOFF } from "@/db/defaults";
import { now, type Stage } from "@/workflow/types";

const STAGES: Stage[] = [
  "todo_picker",
  "planning",
  "implementing",
  "ai_review",
  "publishing",
];

function clearAllBackoff(): void {
  for (const s of STAGES) resetBackoff(s);
}

function restoreBackoffDefaults(): void {
  db.update(tables.globalConfig)
    .set({ api_error_backoff: DEFAULT_API_ERROR_BACKOFF })
    .where(eq(tables.globalConfig.id, 1))
    .run();
}

const originalRunner = getRunner();

before(() => {
  cleanData();
  clearAllBackoff();
  restoreBackoffDefaults();
});

beforeEach(() => {
  cleanData();
  clearAllBackoff();
  restoreBackoffDefaults();
});

after(() => {
  setRunner(originalRunner);
  clearAllBackoff();
  restoreBackoffDefaults();
});

test("default config: 4 consecutive bumps yield delays [30, 60, 120, 120] (sequence saturates at last entry)", () => {
  const t0 = now();
  const e1 = bumpBackoff("planning");
  const e2 = bumpBackoff("planning");
  const e3 = bumpBackoff("planning");
  const e4 = bumpBackoff("planning");

  const d1 = e1.nextAttemptAt - t0;
  const d2 = e2.nextAttemptAt - t0;
  const d3 = e3.nextAttemptAt - t0;
  const d4 = e4.nextAttemptAt - t0;

  // Allow ±1s for clock drift inside bumpBackoff (it calls now() internally).
  assert.ok(d1 >= 30 && d1 <= 31, `bump 1 expected ~30s, got ${d1}`);
  assert.ok(d2 >= 60 && d2 <= 61, `bump 2 expected ~60s, got ${d2}`);
  assert.ok(d3 >= 120 && d3 <= 121, `bump 3 expected ~120s, got ${d3}`);
  assert.ok(d4 >= 120 && d4 <= 121, `bump 4 expected ~120s (saturated), got ${d4}`);

  assert.equal(e1.attempts, 1);
  assert.equal(e4.attempts, 4);
});

test("cap clamps when sequence values exceed it", () => {
  db.update(tables.globalConfig)
    .set({ api_error_backoff: { sequence: [100, 400, 800], cap: 300 } })
    .where(eq(tables.globalConfig.id, 1))
    .run();

  const t0 = now();
  const e1 = bumpBackoff("planning"); // 100
  const e2 = bumpBackoff("planning"); // 400 → clamped to 300
  const e3 = bumpBackoff("planning"); // 800 → clamped to 300

  const d1 = e1.nextAttemptAt - t0;
  const d2 = e2.nextAttemptAt - t0;
  const d3 = e3.nextAttemptAt - t0;

  assert.ok(d1 >= 100 && d1 <= 101, `bump 1 expected ~100s, got ${d1}`);
  assert.ok(d2 >= 300 && d2 <= 301, `bump 2 expected ~300s (capped), got ${d2}`);
  assert.ok(d3 >= 300 && d3 <= 301, `bump 3 expected ~300s (capped), got ${d3}`);
});

test("resetBackoff clears state; subsequent bump restarts at first sequence entry", () => {
  bumpBackoff("planning");
  bumpBackoff("planning");
  assert.ok(isBackoffActive("planning"));

  resetBackoff("planning");
  assert.equal(isBackoffActive("planning"), false);
  assert.equal(snapshotBackoff().planning, undefined);

  const t0 = now();
  const restart = bumpBackoff("planning");
  const delay = restart.nextAttemptAt - t0;
  assert.ok(delay >= 30 && delay <= 31, `restart expected ~30s, got ${delay}`);
  assert.equal(restart.attempts, 1);
});

test("per-stage isolation: bumping planning does not affect implementing", () => {
  bumpBackoff("planning");
  bumpBackoff("planning");
  assert.ok(isBackoffActive("planning"));
  assert.equal(isBackoffActive("implementing"), false);
  assert.equal(snapshotBackoff().implementing, undefined);
});

test("tick wires RateLimitError from runner into bumpBackoff", async () => {
  class RateLimitedRunner {
    async run(): Promise<never> {
      throw new RateLimitError("test rate limit");
    }
  }
  setRunner(new RateLimitedRunner() as never);

  const project = createProject({ slug: "RL", has_repo: false });
  createTask(project, { name: "plan me", status: "PLANNING", mode: "non-dev" });

  const result = await tick("planning");
  assert.equal(result.ran, false);
  assert.ok(result.ran === false && result.reason === "rate_limited");
  if (result.ran === false && result.reason === "rate_limited") {
    assert.ok(result.until > now(), "expected future nextAttemptAt");
  }

  const entry = snapshotBackoff().planning;
  assert.ok(entry, "expected planning backoff to be set");
  assert.equal(entry!.attempts, 1);

  // Subsequent tick while backoff is active returns reason="backoff_active".
  const result2 = await tick("planning");
  assert.equal(result2.ran, false);
  assert.ok(result2.ran === false && result2.reason === "backoff_active");
});

test("tick resets backoff on a successful runner call", async () => {
  // Zero-delay config so bump produces an entry that's immediately expired
  // (isBackoffActive returns false), letting tick proceed.
  db.update(tables.globalConfig)
    .set({ api_error_backoff: { sequence: [0], cap: 0 } })
    .where(eq(tables.globalConfig.id, 1))
    .run();

  class OkRunner {
    async run(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
  }
  setRunner(new OkRunner() as never);

  const project = createProject({ slug: "OK", has_repo: false });
  createTask(project, {
    name: "succeed me",
    status: "PLANNING",
    mode: "non-dev",
    skip_plan: true,
    skip_plan_review: true,
  });

  // Prime backoff state with attempts > 0; nextAttemptAt = now (immediately
  // expired, since isBackoffActive uses `>`).
  bumpBackoff("planning");
  assert.ok(snapshotBackoff().planning, "expected backoff entry before tick");
  assert.equal(isBackoffActive("planning"), false, "zero-delay must not block");

  const result = await tick("planning");
  assert.equal(result.ran, true);
  assert.equal(snapshotBackoff().planning, undefined, "success must clear backoff");
});
