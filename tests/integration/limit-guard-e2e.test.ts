import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { setRunner, getRunner, StubClaudeRunner } from "@/claude";
import type { ClaudeRunner } from "@/claude";
import { __setProviders } from "@/claude/limits";
import type { LimitProvider } from "@/claude/limits";
import {
  handleLimitsSnapshot,
  restoreIfGuardOwned,
  bootRecoverLimitGuard,
  startLimitGuard,
} from "@/workflow/limit-guard";
import { addBlocker, listBlockers } from "@/workflow/blockers";
import { tick } from "@/workflow/tick";

const ALL_STAGES_ENABLED = {
  todo_picker: true,
  planning: true,
  implementing: true,
  ai_review: true,
  verify: true,
  publishing: true,
};

const ALL_STAGES_DISABLED = {
  todo_picker: false,
  planning: false,
  implementing: false,
  ai_review: false,
  verify: false,
  publishing: false,
};

function makeRow(used_pct: number, resets_at: number | null = null) {
  return {
    scope: "session_5h" as const,
    model_bucket: null as string | null,
    used_pct,
    resets_at,
    source: "cli" as const,
  };
}

function getCfg() {
  return db.select().from(tables.globalConfig).where(eq(tables.globalConfig.id, 1)).get()!;
}

function openGuardBlockers() {
  return listBlockers("open").filter(
    (b) => b.kind === "usage_limit_soft" || b.kind === "usage_limit_hard",
  );
}

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

const NULL_PROVIDER: LimitProvider = {
  name: "cli",
  async probe() {
    return null;
  },
};

let savedRunner: ClaudeRunner;
let unsubGuard: (() => void) | null = null;

before(() => {
  savedRunner = getRunner();
  setRunner(new StubClaudeRunner());
  __setProviders([NULL_PROVIDER]);
  cleanData();
});

beforeEach(() => {
  cleanData();
  resetGuardConfig();
  if (unsubGuard) {
    unsubGuard();
    unsubGuard = null;
  }
  unsubGuard = startLimitGuard();
});

afterEach(() => {
  if (unsubGuard) {
    unsubGuard();
    unsubGuard = null;
  }
});

after(() => {
  setRunner(savedRunner);
});

// Test 1 — Ladder walk 60 → 76 → 82 → past reset (headline test)
//
// One TODO task is picked at 60%. A second TODO stays unpicked at 76% (soft
// pause gates the picker). A manually-seeded IMPLEMENTING task proves the
// in-flight stages keep running at 76%. A live-claim task at 82% proves drain
// mode (automation stays on). Once the claim is cleared and the guard owns
// automation_enabled=false, a future snapshot below soft restores everything
// and the queued second task is picked.
test("Ladder walk 60 → 76 → 82 → past reset", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const resetsAt = nowSec + 3600;
  const folderPath = mkdtempSync(join(tmpdir(), "lg-e2e-"));

  const project = createProject({
    slug: "LG-LADDER",
    has_repo: false,
    folder_path: folderPath,
    max_parallel_tasks: 5,
  });
  const T1 = createTask(project, {
    name: "T1",
    status: "TODO",
    skip_plan: true,
    skip_ai_review: true,
    skip_verify: true,
  });
  const T2 = createTask(project, {
    name: "T2",
    status: "TODO",
    skip_plan: true,
    skip_ai_review: true,
    skip_verify: true,
  });

  // ── Step 1: 60% — below soft threshold, all clear ─────────────────────────
  handleLimitsSnapshot([makeRow(60)], nowSec);
  {
    const cfg = getCfg();
    assert.equal(cfg.paused_by_limit, false);
    assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED);
    assert.equal(cfg.automation_enabled, true);
    assert.equal(openGuardBlockers().length, 0);
  }

  const r1 = await tick("todo_picker");
  assert.equal(r1.ran, true, "todo_picker should pick T1 at 60%");
  if (!r1.ran) throw new Error("unreachable");
  assert.equal(r1.taskId, T1.id);

  const r2 = await tick("implementing");
  assert.equal(r2.ran, true, "implementing should run T1 at 60%");

  // ── Step 2: 76% — soft pause: todo_picker off, in-flight stages on ────────
  handleLimitsSnapshot([makeRow(76, resetsAt)], nowSec);
  {
    const cfg = getCfg();
    const se = cfg.stage_enabled as typeof ALL_STAGES_ENABLED;
    assert.equal(cfg.paused_by_limit, true);
    assert.equal(se.todo_picker, false, "todo_picker disabled at soft");
    assert.equal(se.planning, true, "planning stays on at soft");
    assert.equal(se.implementing, true, "implementing stays on at soft");
    assert.equal(se.ai_review, true, "ai_review stays on at soft");
    assert.equal(se.verify, true, "verify stays on at soft");
    assert.equal(se.publishing, true, "publishing stays on at soft");
    assert.equal(cfg.automation_enabled, true);
    const guards = openGuardBlockers();
    assert.equal(guards.length, 1);
    assert.equal(guards[0].kind, "usage_limit_soft");
  }

  // todo_picker is gated — T2 stays TODO
  const r3 = await tick("todo_picker");
  assert.equal(r3.ran, false);
  if (r3.ran) throw new Error("unreachable");
  assert.equal(r3.reason, "stage_disabled", "picker must be gated at soft pause");

  // Seed T3 directly in IMPLEMENTING — implementing stage is still active
  const ws3 = mkdtempSync(join(tmpdir(), "lg-ws3-"));
  const T3 = createTask(project, {
    name: "T3",
    status: "IMPLEMENTING",
    skip_plan: true,
    skip_ai_review: true,
    skip_verify: true,
    workspace_path: ws3,
  });

  const r4 = await tick("implementing");
  assert.equal(r4.ran, true, "implementing should run T3 despite soft pause");
  if (!r4.ran) throw new Error("unreachable");
  assert.equal(r4.taskId, T3.id);

  // ── Step 3: 82% — hard pause, drain mode ─────────────────────────────────
  // T4 has a live claim → automation stays on (drain mode)
  const T4 = createTask(project, {
    name: "T4",
    status: "IMPLEMENTING",
    skip_plan: true,
    skip_ai_review: true,
    skip_verify: true,
    claimed_until: nowSec + 300,
    claimed_by: "in-flight",
  });

  handleLimitsSnapshot([makeRow(82, resetsAt)], nowSec);
  {
    const cfg = getCfg();
    const se = cfg.stage_enabled as typeof ALL_STAGES_ENABLED;
    assert.equal(cfg.paused_by_limit, true);
    assert.equal(se.todo_picker, false, "all stages off at hard");
    assert.equal(se.planning, false);
    assert.equal(se.implementing, false);
    assert.equal(cfg.automation_enabled, true, "automation stays on while live claim exists");
    const guards = openGuardBlockers();
    assert.equal(guards.length, 1);
    assert.equal(guards[0].kind, "usage_limit_hard", "soft blocker must escalate to hard");
  }

  const r5 = await tick("todo_picker");
  assert.equal(r5.ran, false);
  if (r5.ran) throw new Error("unreachable");
  assert.equal(r5.reason, "stage_disabled");

  const r6 = await tick("implementing");
  assert.equal(r6.ran, false);
  if (r6.ran) throw new Error("unreachable");
  assert.equal(r6.reason, "stage_disabled");

  // Drain: clear T4's live claim (simulates the in-flight task finishing)
  db.update(tables.tasks)
    .set({ claimed_until: null, claimed_by: null })
    .where(eq(tables.tasks.id, T4.id))
    .run();

  // Re-snapshot at 82% with no live claims → automation is cut
  handleLimitsSnapshot([makeRow(82, resetsAt)], nowSec);
  {
    const cfg = getCfg();
    assert.equal(cfg.automation_enabled, false, "automation must be cut once claims drain");
    assert.equal(cfg.paused_by_limit, true);
  }

  // ── Step 4: past reset — restore ─────────────────────────────────────────
  const futureNow = resetsAt + 61; // past limit_resume_at (resetsAt + grace 60s)
  handleLimitsSnapshot([makeRow(40)], futureNow);
  {
    const cfg = getCfg();
    assert.equal(cfg.paused_by_limit, false);
    assert.equal(cfg.limit_resume_at, null);
    assert.equal(cfg.automation_enabled, true);
    assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED);
    assert.equal(openGuardBlockers().length, 0, "all guard blockers must be resolved");
  }

  // T2 (the queued TODO) is now pickable
  const r7 = await tick("todo_picker");
  assert.equal(r7.ran, true, "todo_picker must resume after full restore");
  if (!r7.ran) throw new Error("unreachable");
  assert.equal(r7.taskId, T2.id);
});

// Test 2 — In-flight task never killed or left with a dangling claim/worktree
//
// T is seeded directly in IMPLEMENTING with a live claim and a pre-created
// workspace. The guard walks 60 → 76 → 82 without touching T. At 82%, drain
// mode keeps automation on. Once the claim is manually cleared and the guard
// cuts automation, a restore lets tick("implementing") pick up T and complete
// it without orphaning a claim or worktree path.
test("In-flight task survives ladder crossing without dangling claim or worktree", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const resetsAt = nowSec + 3600;
  const folderPath = mkdtempSync(join(tmpdir(), "lg-t2-"));
  const workspace = mkdtempSync(join(tmpdir(), "lg-ws-t2-"));

  const project = createProject({
    slug: "LG-INFLIGHT",
    has_repo: false,
    folder_path: folderPath,
  });
  const T = createTask(project, {
    name: "T-in-flight",
    status: "IMPLEMENTING",
    skip_plan: true,
    skip_ai_review: true,
    skip_verify: true,
    workspace_path: workspace,
    claimed_until: nowSec + 300,
    claimed_by: "in-flight-worker",
  });

  // Walk 60 → 76 → 82 — T's row must be untouched at each rung
  for (const pct of [60, 76, 82]) {
    handleLimitsSnapshot([makeRow(pct, resetsAt)], nowSec);
    const t = db.select().from(tables.tasks).where(eq(tables.tasks.id, T.id)).get()!;
    assert.equal(t.status, "IMPLEMENTING", `T.status unchanged at ${pct}%`);
    assert.equal(t.claimed_by, "in-flight-worker", `T.claimed_by unchanged at ${pct}%`);
    assert.ok(
      t.claimed_until !== null && t.claimed_until > nowSec,
      `T.claimed_until unchanged at ${pct}%`,
    );
    assert.equal(t.workspace_path, workspace, `T.workspace_path unchanged at ${pct}%`);
  }
  // At 82% with live claim: automation stays on (drain mode), stages off
  assert.equal(getCfg().automation_enabled, true, "drain mode: automation stays on while claim live");
  assert.equal(
    (getCfg().stage_enabled as typeof ALL_STAGES_ENABLED).implementing,
    false,
    "implementing stage gated at 82%",
  );

  // tick("implementing") in drain mode → stage_disabled
  const r1 = await tick("implementing");
  assert.equal(r1.ran, false);
  if (r1.ran) throw new Error("unreachable");
  assert.equal(r1.reason, "stage_disabled");

  // Drain: clear T's claim (the in-flight task has finished)
  db.update(tables.tasks)
    .set({ claimed_until: null, claimed_by: null })
    .where(eq(tables.tasks.id, T.id))
    .run();
  handleLimitsSnapshot([makeRow(82, resetsAt)], nowSec);
  assert.equal(getCfg().automation_enabled, false, "automation cut after drain");

  // Past reset → restore
  const futureNow = resetsAt + 61;
  handleLimitsSnapshot([makeRow(40)], futureNow);
  {
    const cfg = getCfg();
    assert.equal(cfg.paused_by_limit, false);
    assert.equal(cfg.automation_enabled, true);
    assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED);
  }

  // T is still IMPLEMENTING, claim cleared — pick and run it
  const r2 = await tick("implementing");
  assert.equal(r2.ran, true, "implementing must resume T after restore");
  if (!r2.ran) throw new Error("unreachable");
  assert.equal(r2.taskId, T.id);

  // T advanced to PUBLISHING; no dangling claim, no orphan worktree path
  const tFinal = db.select().from(tables.tasks).where(eq(tables.tasks.id, T.id)).get()!;
  assert.equal(tFinal.status, "PUBLISHING", "T must advance to PUBLISHING");
  assert.equal(tFinal.claimed_until, null, "no dangling claim after stage completion");
  assert.equal(tFinal.worktree_path, null, "no orphan worktree path");
});

// Test 3 — Restart recovery: elapsed reset restores on boot
//
// Simulate a prior process that was paused and died: db has paused_by_limit=true,
// all stages off, limit_resume_at already elapsed. The stale guard blocker stores
// the prior-all-enabled state. bootRecoverLimitGuard(nowSec) restores the config,
// resolves the blocker, and the todo_picker can run again.
test("Restart recovery: elapsed reset restores on boot", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const folderPath = mkdtempSync(join(tmpdir(), "lg-t3-"));

  // Seed state left by a prior paused process
  db.update(tables.globalConfig)
    .set({
      automation_enabled: false,
      stage_enabled: ALL_STAGES_DISABLED,
      paused_by_limit: true,
      limit_resume_at: nowSec - 10, // already elapsed
    })
    .where(eq(tables.globalConfig.id, 1))
    .run();

  addBlocker({
    kind: "usage_limit_hard",
    task_id: null,
    stage: null,
    summary: "stale guard blocker from prior process",
    detail: JSON.stringify({
      prior_stage_enabled: ALL_STAGES_ENABLED,
      prior_automation_enabled: true,
      worst_pct: 82,
      resets_at: nowSec - 70,
      source: "snapshot",
      scope: "fleet",
    }),
  });

  // Simulate fresh cron register
  bootRecoverLimitGuard(nowSec);

  {
    const cfg = getCfg();
    assert.equal(cfg.paused_by_limit, false);
    assert.equal(cfg.limit_resume_at, null);
    assert.equal(cfg.automation_enabled, true);
    assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED);
    assert.equal(openGuardBlockers().length, 0, "stale blocker must be resolved on boot");
  }

  // A queued TODO is now pickable
  const project = createProject({ slug: "LG-BOOT", has_repo: false, folder_path: folderPath });
  createTask(project, {
    name: "queued-task",
    status: "TODO",
    skip_plan: true,
    skip_ai_review: true,
    skip_verify: true,
  });

  const r = await tick("todo_picker");
  assert.equal(r.ran, true, "todo_picker must run after boot recovery");
});

// Test 4 — Restart recovery: not-yet-elapsed pause survives boot, time-advance restores
//
// Same seeding as Test 3 but limit_resume_at is in the future. bootRecoverLimitGuard
// leaves the pause intact (the timer hasn't cleared yet). After manually advancing time
// via restoreIfGuardOwned(future), the full restore fires and the picker can run.
test("Restart recovery: not-yet-elapsed pause survives boot, time-advance restores", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const resetsAt = nowSec + 3600;
  const folderPath = mkdtempSync(join(tmpdir(), "lg-t4-"));

  // Seed state left by a prior paused process — reset time not yet elapsed
  db.update(tables.globalConfig)
    .set({
      automation_enabled: false,
      stage_enabled: ALL_STAGES_DISABLED,
      paused_by_limit: true,
      limit_resume_at: resetsAt + 60, // grace already added; still future
    })
    .where(eq(tables.globalConfig.id, 1))
    .run();

  addBlocker({
    kind: "usage_limit_hard",
    task_id: null,
    stage: null,
    summary: "stale guard blocker",
    detail: JSON.stringify({
      prior_stage_enabled: ALL_STAGES_ENABLED,
      prior_automation_enabled: true,
      worst_pct: 82,
      resets_at: resetsAt,
      source: "snapshot",
      scope: "fleet",
    }),
  });

  // Boot: limit_resume_at is still in the future — pause must survive
  bootRecoverLimitGuard(nowSec);
  {
    const cfg = getCfg();
    assert.equal(cfg.paused_by_limit, true, "pause must survive when reset not yet elapsed");
    assert.deepEqual(cfg.stage_enabled, ALL_STAGES_DISABLED);
  }

  const project = createProject({ slug: "LG-NOTYET", has_repo: false, folder_path: folderPath });
  createTask(project, {
    name: "queued-task",
    status: "TODO",
    skip_plan: true,
    skip_ai_review: true,
    skip_verify: true,
  });

  // automation_enabled=false → automation_disabled (not stage_disabled)
  const r1 = await tick("todo_picker");
  assert.equal(r1.ran, false);
  if (r1.ran) throw new Error("unreachable");
  assert.equal(r1.reason, "automation_disabled", "automation cut by guard stop");

  // Periodic-poll fallback: advance time past limit_resume_at
  const futureNow = resetsAt + 61;
  const restored = restoreIfGuardOwned(futureNow);
  assert.equal(restored, true);
  {
    const cfg = getCfg();
    assert.equal(cfg.paused_by_limit, false);
    assert.equal(cfg.limit_resume_at, null);
    assert.equal(cfg.automation_enabled, true);
    assert.deepEqual(cfg.stage_enabled, ALL_STAGES_ENABLED);
    assert.equal(openGuardBlockers().length, 0, "guard blocker resolved after time-advance");
  }

  // Now the picker can run
  const r2 = await tick("todo_picker");
  assert.equal(r2.ran, true, "todo_picker must resume after time-advance restore");
});
