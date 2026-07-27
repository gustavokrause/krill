import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { UsageLimitError } from "@/claude/errors";
import {
  isFleetRelevant,
  handleLimitsSnapshot,
  handleUsageLimitError,
  restoreIfGuardOwned,
  bootRecoverLimitGuard,
} from "@/workflow/limit-guard";
import { addBlocker, listBlockers } from "@/workflow/blockers";
import type { LimitSnapshot } from "@/lib/events";

const ALL_STAGES_ENABLED = {
  todo_picker: true,
  planning: true,
  implementing: true,
  ai_review: true,
  verify: true,
  publishing: true,
};

function resetGuardConfig() {
  db.update(tables.globalConfig)
    .set({
      automation_enabled: true,
      stage_enabled: ALL_STAGES_ENABLED,
      paused_by_limit: false,
      limit_resume_at: null,
    })
    .where(eq(tables.globalConfig.id, 1))
    .run();
}

function getCfg() {
  return db
    .select()
    .from(tables.globalConfig)
    .where(eq(tables.globalConfig.id, 1))
    .get()!;
}

function openGuardBlockers() {
  return listBlockers("open").filter(
    (b) => b.kind === "usage_limit_soft" || b.kind === "usage_limit_hard",
  );
}

function makeRow(opts: {
  used_pct: number;
  model_bucket?: string | null;
  resets_at?: number | null;
  scope?: string;
}): LimitSnapshot[number] {
  return {
    scope: opts.scope ?? "session_5h",
    model_bucket: opts.model_bucket ?? null,
    used_pct: opts.used_pct,
    resets_at: opts.resets_at ?? null,
    source: "cli",
    raw: null,
  };
}

beforeEach(() => {
  cleanData();
  resetGuardConfig();
});

test("74% — nothing changes", () => {
  handleLimitsSnapshot([makeRow({ used_pct: 74 })]);

  const cfg = getCfg();
  assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED);
  assert.equal(cfg.automation_enabled, true);
  assert.equal(cfg.paused_by_limit, false);
  assert.equal(openGuardBlockers().length, 0);
});

test("75% — soft pause: todo_picker off, other stages on, automation on", () => {
  handleLimitsSnapshot([makeRow({ used_pct: 75 })]);

  const cfg = getCfg();
  assert.equal((cfg.stage_enabled as typeof ALL_STAGES_ENABLED).todo_picker, false, "todo_picker disabled");
  assert.equal((cfg.stage_enabled as typeof ALL_STAGES_ENABLED).planning, true, "planning stays on");
  assert.equal((cfg.stage_enabled as typeof ALL_STAGES_ENABLED).implementing, true, "implementing stays on");
  assert.equal((cfg.stage_enabled as typeof ALL_STAGES_ENABLED).ai_review, true, "ai_review stays on");
  assert.equal((cfg.stage_enabled as typeof ALL_STAGES_ENABLED).verify, true, "verify stays on");
  assert.equal((cfg.stage_enabled as typeof ALL_STAGES_ENABLED).publishing, true, "publishing stays on");
  assert.equal(cfg.automation_enabled, true);
  assert.equal(cfg.paused_by_limit, true);

  const guards = openGuardBlockers();
  assert.equal(guards.length, 1);
  assert.equal(guards[0].kind, "usage_limit_soft");
});

test("80% with live claim — all stages off, automation still on (drain mode)", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const project = createProject({ slug: "LG1" });
  createTask(project, {
    name: "in-flight",
    status: "IMPLEMENTING",
    claimed_until: nowSec + 300,
    claimed_by: "worker-test",
  });

  handleLimitsSnapshot([makeRow({ used_pct: 80 })], nowSec);

  const cfg = getCfg();
  const se = cfg.stage_enabled as typeof ALL_STAGES_ENABLED;
  assert.equal(se.todo_picker, false);
  assert.equal(se.planning, false);
  assert.equal(se.implementing, false);
  assert.equal(se.ai_review, false);
  assert.equal(se.verify, false);
  assert.equal(se.publishing, false);
  assert.equal(cfg.automation_enabled, true, "automation stays on while claim live");
  assert.equal(cfg.paused_by_limit, true);

  const guards = openGuardBlockers();
  assert.equal(guards.length, 1);
  assert.equal(guards[0].kind, "usage_limit_hard");
});

test("80% after claims drain — automation_enabled flips to false", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const project = createProject({ slug: "LG2" });
  const task = createTask(project, {
    name: "in-flight",
    status: "IMPLEMENTING",
    claimed_until: nowSec + 300,
    claimed_by: "worker-test",
  });

  // First trigger: live claim → automation stays on
  handleLimitsSnapshot([makeRow({ used_pct: 80 })], nowSec);
  assert.equal(getCfg().automation_enabled, true);

  // Drain: clear the claim
  db.update(tables.tasks)
    .set({ claimed_until: null, claimed_by: null })
    .where(eq(tables.tasks.id, task.id))
    .run();

  // Second trigger: no live claims → automation cut
  handleLimitsSnapshot([makeRow({ used_pct: 80 })], nowSec);
  assert.equal(getCfg().automation_enabled, false);
  assert.equal(getCfg().paused_by_limit, true);
});

test("time past limit_resume_at — restore fires, prior config fully recovered", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const resetsAt = nowSec + 3600;

  // Trigger soft pause with a known resets_at
  handleLimitsSnapshot([makeRow({ used_pct: 75, resets_at: resetsAt })], nowSec);

  const cfgAfterPause = getCfg();
  assert.equal(cfgAfterPause.paused_by_limit, true);
  assert.ok(cfgAfterPause.limit_resume_at !== null);

  // Advance time past limit_resume_at (resetsAt + grace = resetsAt + 60)
  const futureNow = resetsAt + 61;
  const restored = restoreIfGuardOwned(futureNow);

  assert.equal(restored, true);
  const cfg = getCfg();
  assert.equal(cfg.paused_by_limit, false);
  assert.equal(cfg.limit_resume_at, null);
  assert.equal(cfg.automation_enabled, true);
  assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED);
  assert.equal(openGuardBlockers().length, 0, "guard blocker resolved");
});

test("human-set pause (paused_by_limit=false) is never re-enabled by a sub-soft snapshot", () => {
  // Simulate a human manually disabling automation
  db.update(tables.globalConfig)
    .set({ automation_enabled: false, paused_by_limit: false })
    .where(eq(tables.globalConfig.id, 1))
    .run();

  // Fresh snapshot well below soft threshold
  handleLimitsSnapshot([makeRow({ used_pct: 30 })]);

  const cfg = getCfg();
  assert.equal(cfg.automation_enabled, false, "human pause must not be cleared");
  assert.equal(cfg.paused_by_limit, false);
  assert.equal(openGuardBlockers().length, 0);
});

test("Fable-only bucket ignored — opus at 40% determines worst, no pause", () => {
  handleLimitsSnapshot([
    makeRow({ used_pct: 99, model_bucket: "fable" }),
    makeRow({ used_pct: 40, model_bucket: "opus" }),
  ]);

  const cfg = getCfg();
  assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED, "no pause for Fable-only high pct");
  assert.equal(cfg.paused_by_limit, false);
  assert.equal(openGuardBlockers().length, 0);
});

test("isFleetRelevant: session buckets and fleet families pass; fable fails", () => {
  assert.equal(isFleetRelevant(makeRow({ used_pct: 50, model_bucket: null })), true, "null bucket = session-level, always relevant");
  assert.equal(isFleetRelevant(makeRow({ used_pct: 50, model_bucket: "opus" })), true);
  assert.equal(isFleetRelevant(makeRow({ used_pct: 50, model_bucket: "sonnet" })), true);
  assert.equal(isFleetRelevant(makeRow({ used_pct: 50, model_bucket: "fable" })), false);
  assert.equal(isFleetRelevant(makeRow({ used_pct: 50, model_bucket: "haiku" })), false, "haiku not in fleet unless MODEL_BY_STAGE adds it");
});

test("UsageLimitError path — immediate hard stop (both flag groups off, no drain wait)", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const project = createProject({ slug: "LG3" });
  createTask(project, {
    name: "in-flight",
    status: "IMPLEMENTING",
    claimed_until: nowSec + 300,
    claimed_by: "worker-test",
  });

  const err = new UsageLimitError({
    message: "5-hour limit reached",
    resetsAt: nowSec + 3600,
    scope: "session_5h",
    raw: "Claude AI usage limit reached|" + (nowSec + 3600),
    taskId: "LG3-1",
  });

  handleUsageLimitError(err, nowSec);

  const cfg = getCfg();
  const se = cfg.stage_enabled as typeof ALL_STAGES_ENABLED;
  assert.equal(se.todo_picker, false);
  assert.equal(se.planning, false);
  assert.equal(se.implementing, false);
  assert.equal(se.ai_review, false);
  assert.equal(se.verify, false);
  assert.equal(se.publishing, false);
  // Immediate stop — automation off even though live claim exists
  assert.equal(cfg.automation_enabled, false, "immediate stop despite live claim");
  assert.equal(cfg.paused_by_limit, true);

  const guards = openGuardBlockers();
  assert.equal(guards.length, 1);
  assert.equal(guards[0].kind, "usage_limit_hard");
});

test("boot recovery — restores when limit_resume_at already elapsed", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  // Simulate a prior process that left the guard paused
  db.update(tables.globalConfig)
    .set({
      automation_enabled: false,
      stage_enabled: {
        todo_picker: false,
        planning: false,
        implementing: false,
        ai_review: false,
        verify: false,
        publishing: false,
      },
      paused_by_limit: true,
      limit_resume_at: nowSec - 10,
    })
    .where(eq(tables.globalConfig.id, 1))
    .run();

  // File the stale guard blocker with prior state
  addBlocker({
    kind: "usage_limit_hard",
    task_id: null,
    stage: null,
    summary: "stale blocker from prior process",
    detail: JSON.stringify({
      prior_stage_enabled: ALL_STAGES_ENABLED,
      prior_automation_enabled: true,
      worst_pct: 80,
      resets_at: nowSec - 70,
      source: "snapshot",
      scope: "fleet",
    }),
  });

  bootRecoverLimitGuard(nowSec);

  const cfg = getCfg();
  assert.equal(cfg.paused_by_limit, false);
  assert.equal(cfg.limit_resume_at, null);
  assert.equal(cfg.automation_enabled, true);
  assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED);
  assert.equal(openGuardBlockers().length, 0, "stale blocker resolved");
});

test("boot recovery — leaves pause intact when reset time not yet elapsed", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  db.update(tables.globalConfig)
    .set({ paused_by_limit: true, limit_resume_at: nowSec + 3600 })
    .where(eq(tables.globalConfig.id, 1))
    .run();

  bootRecoverLimitGuard(nowSec);

  const cfg = getCfg();
  assert.equal(cfg.paused_by_limit, true, "pause must stay until reset time elapses");
});

test("soft → hard escalation preserves the original prior_stage_enabled in the new blocker", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  // Soft pause — prior is all-enabled
  handleLimitsSnapshot([makeRow({ used_pct: 75 })], nowSec);
  const softCfg = getCfg();
  assert.equal(softCfg.paused_by_limit, true);

  // Escalate to hard
  handleLimitsSnapshot([makeRow({ used_pct: 80 })], nowSec);

  // Only one guard blocker should be open and it must be the hard kind
  const guards = openGuardBlockers();
  assert.equal(guards.length, 1);
  assert.equal(guards[0].kind, "usage_limit_hard");

  // prior state in the hard blocker must still reflect all-enabled (not the soft-paused state)
  const detail = JSON.parse(guards[0].detail) as { prior_stage_enabled: typeof ALL_STAGES_ENABLED };
  assert.deepEqual(detail.prior_stage_enabled, ALL_STAGES_ENABLED);

  // Restore should recover all-enabled
  restoreIfGuardOwned(nowSec, true);
  const cfg = getCfg();
  assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED);
  assert.equal(cfg.paused_by_limit, false);
});
