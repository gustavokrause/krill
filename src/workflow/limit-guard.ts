import { eq, gt } from "drizzle-orm";
import { db } from "@/db/client";
import { blockers, globalConfig, tasks, type StageEnabled } from "@/db/schema";
import type { UsageLimitError } from "@/claude/errors";
import { MODEL_BY_STAGE } from "@/claude/model-map";
import { broadcast } from "@/lib/sse";
import { subscribe } from "@/lib/sse";
import type { LimitSnapshot } from "@/lib/events";
import { addBlocker, listBlockers, resolveBlocker } from "./blockers";
import { now as nowFn } from "./types";

// Fleet model families derived from MODEL_BY_STAGE values. Fable never appears
// there so it is excluded automatically. New families are picked up without
// manual edits when MODEL_BY_STAGE gains them.
const FLEET_FAMILIES: Set<string> = new Set(
  Object.values(MODEL_BY_STAGE).map((m) => {
    const lower = m.toLowerCase();
    if (lower.includes("opus")) return "opus";
    if (lower.includes("sonnet")) return "sonnet";
    if (lower.includes("haiku")) return "haiku";
    return lower.split("-")[1] ?? lower;
  }),
);

type LimitRow = LimitSnapshot[number];

/** A row is fleet-relevant if model_bucket is null (session-level bucket) or
 *  its value contains a family present in MODEL_BY_STAGE. */
export function isFleetRelevant(row: LimitRow): boolean {
  if (row.model_bucket === null) return true;
  const bucket = row.model_bucket.toLowerCase();
  for (const family of FLEET_FAMILIES) {
    if (bucket.includes(family)) return true;
  }
  return false;
}

function worstBucket(rows: LimitRow[]): { pct: number; resetsAt: number | null } {
  const maxPct = Math.max(...rows.map((r) => r.used_pct));
  const atMax = rows.filter((r) => r.used_pct === maxPct);

  // Prefer resets_at from the worst-pct rows; fall back to any non-null in the set.
  let resetsAt: number | null = null;
  for (const r of atMax) {
    if (r.resets_at !== null && (resetsAt === null || r.resets_at > resetsAt)) {
      resetsAt = r.resets_at;
    }
  }
  if (resetsAt === null) {
    for (const r of rows) {
      if (r.resets_at !== null && (resetsAt === null || r.resets_at > resetsAt)) {
        resetsAt = r.resets_at;
      }
    }
  }
  return { pct: maxPct, resetsAt };
}

function readConfig() {
  return db.select().from(globalConfig).where(eq(globalConfig.id, 1)).get();
}

function activeClaimsCount(nowSec: number): number {
  return db
    .select({ id: tasks.id })
    .from(tasks)
    .where(gt(tasks.claimed_until, nowSec))
    .all().length;
}

type GuardDetail = {
  prior_stage_enabled: StageEnabled;
  prior_automation_enabled: boolean;
  worst_pct: number;
  resets_at: number | null;
  source: string;
  scope: string;
};

type GuardKind = "usage_limit_soft" | "usage_limit_hard";

function findOpenGuardBlocker() {
  return listBlockers("open").find(
    (b) => b.kind === "usage_limit_soft" || b.kind === "usage_limit_hard",
  );
}

function parseGuardDetail(detail: string): Partial<GuardDetail> {
  try {
    return JSON.parse(detail) as Partial<GuardDetail>;
  } catch {
    return {};
  }
}

/**
 * Apply a guard-owned config change. Soft: only disables todo_picker. Hard:
 * disables all stages. Prior state is stashed in the blocker detail so restore
 * is exact even after a process restart.
 *
 * immediateStop = true skips the drain-wait: automation_enabled is cut now
 * (UsageLimitError path). false = drain mode: automation stays on until
 * activeClaimsCount drops to zero.
 */
function applyGuardPause(
  kind: GuardKind,
  worst: { pct: number; resetsAt: number | null },
  source: string,
  cfg: NonNullable<ReturnType<typeof readConfig>>,
  nowSec: number,
  immediateStop = false,
): void {
  const existing = findOpenGuardBlocker();

  // Preserve the ORIGINAL (pre-first-guard) prior state so escalation chains
  // (soft → hard) still restore all the way back to the original config.
  const priorDetail = existing ? parseGuardDetail(existing.detail) : {};
  const priorStageEnabled =
    (priorDetail.prior_stage_enabled as StageEnabled | undefined) ??
    (cfg.stage_enabled as StageEnabled);
  const priorAutomationEnabled =
    priorDetail.prior_automation_enabled ?? cfg.automation_enabled;

  // Escalation: resolve old blocker before filing the new kind.
  if (existing && existing.kind !== kind) {
    resolveBlocker(existing.id, "resolved");
  }

  const resumeAt =
    worst.resetsAt !== null
      ? worst.resetsAt + (cfg.limit_resume_grace_sec ?? 60)
      : null;

  const detail: GuardDetail = {
    prior_stage_enabled: priorStageEnabled,
    prior_automation_enabled: priorAutomationEnabled,
    worst_pct: worst.pct,
    resets_at: worst.resetsAt,
    source,
    scope: "fleet",
  };

  if (kind === "usage_limit_soft") {
    const se = { ...(cfg.stage_enabled as StageEnabled), todo_picker: false };
    const updated = db
      .update(globalConfig)
      .set({ stage_enabled: se, paused_by_limit: true, limit_resume_at: resumeAt })
      .where(eq(globalConfig.id, 1))
      .returning()
      .all();
    if (updated[0]) broadcast({ type: "config.changed", config: updated[0] });
  } else {
    const se: StageEnabled = {
      todo_picker: false,
      planning: false,
      implementing: false,
      ai_review: false,
      verify: false,
      publishing: false,
    };
    const autoEnabled = immediateStop ? false : cfg.automation_enabled;
    const updated = db
      .update(globalConfig)
      .set({
        stage_enabled: se,
        automation_enabled: autoEnabled,
        paused_by_limit: true,
        limit_resume_at: resumeAt,
      })
      .where(eq(globalConfig.id, 1))
      .returning()
      .all();
    if (updated[0]) broadcast({ type: "config.changed", config: updated[0] });

    // Drain mode: once all in-flight claims land, cut automation.
    if (!immediateStop && activeClaimsCount(nowSec) === 0) {
      const updated2 = db
        .update(globalConfig)
        .set({ automation_enabled: false })
        .where(eq(globalConfig.id, 1))
        .returning()
        .all();
      if (updated2[0]) broadcast({ type: "config.changed", config: updated2[0] });
    }
  }

  addBlocker({
    kind,
    task_id: null,
    stage: null,
    summary:
      kind === "usage_limit_soft"
        ? `Usage at ${Math.round(worst.pct)}% — new tasks paused, in-flight continue`
        : `Usage at ${Math.round(worst.pct)}% — draining in-flight, automation halted`,
    detail: JSON.stringify(detail),
    dedupe: true,
  });
}

/**
 * Main ladder dispatcher. Called by the SSE subscription on every limits.changed
 * event. Also directly callable from tests (nowSec is injectable for time-freezing).
 *
 * Cases:
 *   pct < soft    → normal; restore if guard owns the current pause.
 *   soft ≤ pct < hard → soft pause: todo_picker off, in-flight tasks keep running.
 *   pct ≥ hard    → drain mode: all stages off, automation off once claims clear.
 */
export function handleLimitsSnapshot(snap: LimitSnapshot, nowSec = nowFn()): void {
  const cfg = readConfig();
  if (!cfg || !cfg.limit_guard_enabled) return;

  const relevant = snap.filter(isFleetRelevant);
  if (relevant.length === 0) return;

  const worst = worstBucket(relevant);
  const soft = cfg.limit_soft_pct;
  const hard = cfg.limit_hard_pct;

  if (worst.pct < soft) {
    if (cfg.paused_by_limit) restoreIfGuardOwned(nowSec, true);
  } else if (worst.pct < hard) {
    applyGuardPause("usage_limit_soft", worst, "snapshot", cfg, nowSec);
  } else {
    applyGuardPause("usage_limit_hard", worst, "snapshot", cfg, nowSec);
  }
}

/**
 * Case 4: immediate hard stop triggered by a UsageLimitError thrown from tick.ts.
 * The throwing task already released its claim; automation is cut immediately
 * rather than waiting for other in-flight claims to drain.
 */
export function handleUsageLimitError(err: UsageLimitError, nowSec = nowFn()): void {
  const cfg = readConfig();
  if (!cfg || !cfg.limit_guard_enabled) return;

  applyGuardPause(
    "usage_limit_hard",
    { pct: 100, resetsAt: err.resetsAt },
    "error",
    cfg,
    nowSec,
    true, // immediateStop — no drain wait
  );
}

/**
 * Restore the config the guard changed. Returns true if a restore happened.
 *
 * Two resume triggers:
 *   1. freshUnderSoft = true  — caller observed pct < soft in a fresh snapshot.
 *   2. nowSec ≥ limit_resume_at — the reset timer elapsed.
 *
 * Invariant: only clears a guard-owned pause (paused_by_limit = true). A
 * human-set automation_enabled=false with paused_by_limit=false is never touched.
 */
export function restoreIfGuardOwned(nowSec = nowFn(), freshUnderSoft = false): boolean {
  const cfg = readConfig();
  if (!cfg || !cfg.paused_by_limit) return false;

  const timeElapsed =
    cfg.limit_resume_at !== null && nowSec >= cfg.limit_resume_at;
  if (!timeElapsed && !freshUnderSoft) return false;

  const guardBlocker = findOpenGuardBlocker();
  const priorDetail = guardBlocker ? parseGuardDetail(guardBlocker.detail) : {};

  const priorStageEnabled: StageEnabled = (priorDetail.prior_stage_enabled as StageEnabled | undefined) ?? {
    todo_picker: true,
    planning: true,
    implementing: true,
    ai_review: true,
    verify: true,
    publishing: true,
  };
  const priorAutomationEnabled: boolean = priorDetail.prior_automation_enabled ?? true;

  const updated = db
    .update(globalConfig)
    .set({
      stage_enabled: priorStageEnabled,
      automation_enabled: priorAutomationEnabled,
      paused_by_limit: false,
      limit_resume_at: null,
    })
    .where(eq(globalConfig.id, 1))
    .returning()
    .all();
  if (updated[0]) broadcast({ type: "config.changed", config: updated[0] });

  // Resolve all open guard blockers (normally just one).
  for (const b of listBlockers("open")) {
    if (b.kind === "usage_limit_soft" || b.kind === "usage_limit_hard") {
      resolveBlocker(b.id, "resolved");
    }
  }

  return true;
}

/**
 * Called once at cron registration before the first poll fires. Recovers a
 * stale guard pause left over from a prior process if the reset time has elapsed.
 * If not yet elapsed, the existing pause is left intact; the periodic poll fires
 * the same restore path once the timer clears.
 */
export function bootRecoverLimitGuard(nowSec = nowFn()): void {
  const cfg = readConfig();
  if (!cfg || !cfg.paused_by_limit) return;

  const timeElapsed =
    cfg.limit_resume_at !== null && nowSec >= cfg.limit_resume_at;
  if (timeElapsed) restoreIfGuardOwned(nowSec);
}

/** Subscribe to limits.changed SSE events. Returns an unsubscribe function. */
export function startLimitGuard(): () => void {
  return subscribe((event) => {
    if (event.type === "limits.changed") {
      handleLimitsSnapshot(event.snapshot);
    }
  });
}
