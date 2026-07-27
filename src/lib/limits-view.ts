import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { usageLimits, globalConfig, type StageEnabled, type UsageLimitSource } from "@/db/schema";
import { MODEL_BY_STAGE } from "@/claude/model-map";

// Fleet model families derived from MODEL_BY_STAGE. Fable never appears there
// so it is excluded automatically. New families are picked up without manual edits.
const FLEET_FAMILIES: Set<string> = new Set(
  Object.values(MODEL_BY_STAGE).map((m) => {
    const lower = m.toLowerCase();
    if (lower.includes("opus")) return "opus";
    if (lower.includes("sonnet")) return "sonnet";
    if (lower.includes("haiku")) return "haiku";
    return lower.split("-")[1] ?? lower;
  }),
);

export type LimitsViewBucket = {
  scope: string;
  model_bucket: string | null;
  used_pct: number;
  resets_at: number | null;
  source: UsageLimitSource;
};

export type GuardState = "normal" | "soft_paused" | "draining" | "stopped";

export type LimitsView = {
  buckets: LimitsViewBucket[];
  worst_pct: number | null;
  session_pct: number | null;
  weekly_pct: number | null;
  guard_state: GuardState;
  paused_by_limit: boolean;
  limit_resume_at: number | null;
  source: UsageLimitSource | null;
  observed_at: number | null;
  stale: boolean;
};

export function scopeCategory(scope: string): "session" | "weekly" | "other" {
  if (scope === "session_5h") return "session";
  if (scope.startsWith("week")) return "weekly";
  return "other";
}

/** A row is fleet-relevant if model_bucket is null (session-level) or its
 *  value contains a family present in MODEL_BY_STAGE. */
export function isFleetRelevant(row: { model_bucket: string | null }): boolean {
  if (row.model_bucket === null) return true;
  const bucket = row.model_bucket.toLowerCase();
  for (const family of FLEET_FAMILIES) {
    if (bucket.includes(family)) return true;
  }
  return false;
}

export function deriveGuardState(cfg: {
  paused_by_limit: boolean;
  automation_enabled: boolean;
  stage_enabled: StageEnabled;
}): GuardState {
  if (!cfg.paused_by_limit) return "normal";
  if (!cfg.automation_enabled) return "stopped";
  if ((cfg.stage_enabled as StageEnabled).planning === false) return "draining";
  return "soft_paused";
}

/** Derive a full LimitsView from the latest usage_limits snapshot + global_config. */
export function computeLimitsView(nowSec?: number): LimitsView {
  const now = nowSec ?? Math.floor(Date.now() / 1000);

  const cfg = db.select().from(globalConfig).where(eq(globalConfig.id, 1)).get();

  // Latest observed_at group only.
  const latestAt = db
    .select({ observed_at: sql<number>`MAX(${usageLimits.observed_at})` })
    .from(usageLimits)
    .get();

  const rows =
    latestAt?.observed_at != null
      ? db
          .select()
          .from(usageLimits)
          .where(eq(usageLimits.observed_at, latestAt.observed_at))
          .all()
      : [];

  const observed_at = rows.length > 0 ? (rows[0].observed_at ?? null) : null;
  const source: UsageLimitSource | null = rows.length > 0 ? rows[0].source : null;

  const relevant = rows.filter(isFleetRelevant);
  let worst_pct: number | null = null;
  if (relevant.length > 0) {
    worst_pct = Math.max(...relevant.map((r) => r.used_pct));
  }

  const sessionRows = relevant.filter((r) => scopeCategory(r.scope) === "session");
  const weeklyRows = relevant.filter((r) => scopeCategory(r.scope) === "weekly");
  const session_pct =
    sessionRows.length > 0
      ? Math.max(...sessionRows.map((r) => r.used_pct))
      : null;
  const weekly_pct =
    weeklyRows.length > 0
      ? Math.max(...weeklyRows.map((r) => r.used_pct))
      : null;

  const limitPollSec = cfg?.limit_poll_sec ?? 120;
  const stale =
    observed_at === null || now - observed_at > 2 * limitPollSec;

  const guard_state = cfg
    ? deriveGuardState({
        paused_by_limit: cfg.paused_by_limit,
        automation_enabled: cfg.automation_enabled,
        stage_enabled: cfg.stage_enabled as StageEnabled,
      })
    : "normal";

  return {
    buckets: rows.map((r) => ({
      scope: r.scope,
      model_bucket: r.model_bucket,
      used_pct: r.used_pct,
      resets_at: r.resets_at,
      source: r.source,
    })),
    worst_pct,
    session_pct,
    weekly_pct,
    guard_state,
    paused_by_limit: cfg?.paused_by_limit ?? false,
    limit_resume_at: cfg?.limit_resume_at ?? null,
    source,
    observed_at,
    stale,
  };
}
