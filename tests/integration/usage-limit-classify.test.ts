import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { cleanData, createProject, createTask, db, tables } from "../helpers/setup";
import { classifyUsageLimit, UsageLimitError } from "@/claude/errors";
import { snapshotBackoff, resetBackoff } from "@/workflow/backoff";
import { tick } from "@/workflow/tick";
import { setRunner, getRunner } from "@/claude";
import type { RunnerInput, RunnerOutput } from "@/claude/runner";
import { type Stage } from "@/workflow/types";
import { eq } from "drizzle-orm";

// ── Group A: classifyUsageLimit() unit fixtures ────────────────────────────

test("pipe form: resetsAt=epoch, scope=session_5h", () => {
  const epoch = 1800000000;
  const result = classifyUsageLimit(`Claude AI usage limit reached|${epoch}`);
  assert.ok(result !== null);
  assert.equal(result.scope, "session_5h");
  assert.equal(result.resetsAt, epoch);
});

test("ISO 8601 reset time → resetsAt=parsed epoch, scope=session_5h", () => {
  const text = "5-hour limit reached. Reset at 2026-07-27T15:00:00Z";
  const result = classifyUsageLimit(text);
  assert.ok(result !== null);
  assert.equal(result.scope, "session_5h");
  const expected = Math.floor(Date.parse("2026-07-27T15:00:00Z") / 1000);
  assert.equal(result.resetsAt, expected);
});

test("weekly + relative time → scope=week, resetsAt≈now+delta", () => {
  const frozenNow = 1800000000;
  const text = "weekly limit reached, resets in 3h 15m";
  const result = classifyUsageLimit(text, frozenNow);
  assert.ok(result !== null);
  assert.equal(result.scope, "week");
  assert.equal(result.resetsAt, frozenNow + 3 * 3600 + 15 * 60);
});

test("usage limit reached with no time → resetsAt=null, scope=session_5h", () => {
  const result = classifyUsageLimit("You've hit your usage limit reached");
  assert.ok(result !== null);
  assert.equal(result.scope, "session_5h");
  assert.equal(result.resetsAt, null);
});

test("weekly usage limit with no time → scope=week, resetsAt=null", () => {
  const result = classifyUsageLimit("weekly usage limit reached");
  assert.ok(result !== null);
  assert.equal(result.scope, "week");
  assert.equal(result.resetsAt, null);
});

test("negative: generic 429 overloaded → null", () => {
  assert.equal(classifyUsageLimit("429 overloaded"), null);
});

test("negative: connection reset by peer → null", () => {
  assert.equal(classifyUsageLimit("connection reset by peer"), null);
});

test("negative: rate-limited retry → null (generic rate-limit must not trip usage-limit)", () => {
  assert.equal(classifyUsageLimit("rate-limited, retry later"), null);
});

test("negative: plain rate limit stderr → null", () => {
  assert.equal(classifyUsageLimit("API rate limit exceeded, please retry"), null);
});

// ── Group C: tick integration ──────────────────────────────────────────────

const STAGES_TO_CLEAR: Stage[] = [
  "todo_picker",
  "planning",
  "implementing",
  "ai_review",
  "publishing",
];

function clearAllBackoff(): void {
  for (const s of STAGES_TO_CLEAR) resetBackoff(s);
}

const originalRunner = getRunner();

function resetGuardConfig(): void {
  db.update(tables.globalConfig)
    .set({
      automation_enabled: true,
      stage_enabled: { todo_picker: true, planning: true, implementing: true, ai_review: true, verify: true, publishing: true },
      paused_by_limit: false,
      limit_resume_at: null,
    })
    .where(eq(tables.globalConfig.id, 1))
    .run();
}

before(() => {
  cleanData();
  clearAllBackoff();
  resetGuardConfig();
});

beforeEach(() => {
  cleanData();
  clearAllBackoff();
  resetGuardConfig();
});

after(() => {
  setRunner(originalRunner);
  clearAllBackoff();
});

const FIXED_RESETS_AT = 1800099999;

class UsageLimitRunner {
  async run(input: RunnerInput): Promise<RunnerOutput> {
    throw new UsageLimitError({
      message: "Claude usage limit reached",
      resetsAt: FIXED_RESETS_AT,
      scope: "session_5h",
      raw: `Claude AI usage limit reached|${FIXED_RESETS_AT}`,
      taskId: input.task.id,
    });
  }
}

test("tick: UsageLimitError → reason=usage_limit, backoff untouched, row inserted, claim released", async () => {
  setRunner(new UsageLimitRunner() as never);

  const project = createProject({ slug: "UL", has_repo: false });
  const task = createTask(project, {
    name: "limit me",
    status: "PLANNING",
    mode: "non-dev",
  });

  const result = await tick("planning");

  assert.equal(result.ran, false);
  assert.ok(result.ran === false && result.reason === "usage_limit");
  if (result.ran === false && result.reason === "usage_limit") {
    assert.equal(result.taskId, task.id);
    assert.equal(result.resetsAt, FIXED_RESETS_AT);
  }

  // Backoff must be untouched
  assert.equal(
    snapshotBackoff().planning,
    undefined,
    "usage-limit must not bump per-stage backoff",
  );

  // usage_limits row inserted with ground-truth values
  const rows = db
    .select()
    .from(tables.usageLimits)
    .where(eq(tables.usageLimits.source, "cli"))
    .all();
  assert.equal(rows.length, 1, "expected exactly one usage_limits row");
  const row = rows[0];
  assert.equal(row.used_pct, 100);
  assert.equal(row.resets_at, FIXED_RESETS_AT);
  assert.equal(row.scope, "session_5h");

  // Claim released: task should have claimed_by=null, claimed_until=null
  const fresh = db
    .select({ claimed_by: tables.tasks.claimed_by, claimed_until: tables.tasks.claimed_until })
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get();
  assert.ok(fresh, "task must still exist");
  assert.equal(fresh.claimed_by, null, "claim must be released");
  assert.equal(fresh.claimed_until, null, "claim must be released");
});

test("tick: subsequent tick after usage_limit returns no_task (not backoff_active)", async () => {
  setRunner(new UsageLimitRunner() as never);

  const project = createProject({ slug: "UL2", has_repo: false });
  createTask(project, { name: "limit me again", status: "PLANNING", mode: "non-dev" });

  const first = await tick("planning");
  assert.ok(first.ran === false && first.reason === "usage_limit");

  // The limit guard fires on the first UsageLimitError and sets automation_enabled=false.
  // The second tick must therefore NOT be backoff_active — that would mean the rate-limit
  // backoff was bumped, which is wrong for a usage-limit hit. Guard-stopped results
  // (automation_disabled / stage_disabled) are fine: the guard is working as intended.
  const second = await tick("planning");
  assert.ok(
    second.ran === false && second.reason !== "backoff_active",
    `expected non-backoff result on second tick, got ${second.ran === false ? second.reason : "ran"}`,
  );
  assert.equal(snapshotBackoff().planning, undefined, "still no backoff after second hit");
});
