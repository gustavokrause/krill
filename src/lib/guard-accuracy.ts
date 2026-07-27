import { and, eq, gte, inArray, like, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { blockers, globalConfig, usageLimits } from "@/db/schema";
import { isFleetRelevant } from "@/lib/limits-view";

export type DriftBucket = {
  scope: string;
  model_bucket: string | null;
  measured_avg_pct: number | null;
  estimate_avg_pct: number | null;
  delta_pct: number | null;
  n_measured: number;
  n_estimate: number;
};

export type GuardAccuracy = {
  window_days: number;
  drift: DriftBucket[];
  pause_count: number;
  peak_pct: number | null;
  guard_miss_count: number;
  false_pause_count: number;
  false_pause_denom: number;
};

function avg(nums: number[]): number | null {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

export function computeGuardAccuracy(nowSec?: number, windowDays = 7): GuardAccuracy {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const windowStart = now - windowDays * 86400;

  // -- Drift: aggregate usage_limits by (scope, model_bucket) over the window --
  const limitRows = db
    .select()
    .from(usageLimits)
    .where(gte(usageLimits.observed_at, windowStart))
    .all();

  type BucketAgg = {
    scope: string;
    model_bucket: string | null;
    estimateSamples: number[];
    measuredSamples: number[];
  };
  const bucketMap = new Map<string, BucketAgg>();

  for (const r of limitRows) {
    if (!isFleetRelevant(r)) continue;
    const key = `${r.scope}|${r.model_bucket ?? ""}`;
    if (!bucketMap.has(key)) {
      bucketMap.set(key, {
        scope: r.scope,
        model_bucket: r.model_bucket,
        estimateSamples: [],
        measuredSamples: [],
      });
    }
    const agg = bucketMap.get(key)!;
    if (r.source === "estimate") {
      agg.estimateSamples.push(r.used_pct);
    } else {
      agg.measuredSamples.push(r.used_pct);
    }
  }

  const drift: DriftBucket[] = Array.from(bucketMap.values())
    .sort((a, b) => a.scope.localeCompare(b.scope))
    .map((agg) => {
      const measured_avg_pct = avg(agg.measuredSamples);
      const estimate_avg_pct = avg(agg.estimateSamples);
      const delta_pct =
        measured_avg_pct !== null && estimate_avg_pct !== null
          ? measured_avg_pct - estimate_avg_pct
          : null;
      return {
        scope: agg.scope,
        model_bucket: agg.model_bucket,
        measured_avg_pct,
        estimate_avg_pct,
        delta_pct,
        n_measured: agg.measuredSamples.length,
        n_estimate: agg.estimateSamples.length,
      };
    });

  // -- Pauses / peak / misses: guard blockers in window --
  const guardBlockers = db
    .select()
    .from(blockers)
    .where(
      and(
        like(blockers.kind, "usage_limit_%"),
        gte(blockers.created_at, windowStart),
      ),
    )
    .all();

  const pause_count = guardBlockers.length;
  let peak_pct: number | null = null;
  let guard_miss_count = 0;

  for (const b of guardBlockers) {
    let detail: { worst_pct?: number; source?: string } = {};
    try {
      detail = JSON.parse(b.detail) as typeof detail;
    } catch {
      // malformed detail — skip
    }
    if (typeof detail.worst_pct === "number") {
      if (peak_pct === null || detail.worst_pct > peak_pct) {
        peak_pct = detail.worst_pct;
      }
    }
    if (detail.source === "error") guard_miss_count++;
  }

  // -- False pauses: blockers ≥1h old where measured max never crossed soft_pct --
  const cfg = db.select().from(globalConfig).where(eq(globalConfig.id, 1)).get();
  // Using current soft_pct as proxy — pause detail doesn't preserve threshold at pause time
  const softPct = cfg?.limit_soft_pct ?? 75;

  const judgeableCutoff = now - 3600;
  const judgeableBlockers = guardBlockers.filter(
    (b) => b.created_at <= judgeableCutoff,
  );
  const false_pause_denom = judgeableBlockers.length;

  let false_pause_count = 0;
  for (const b of judgeableBlockers) {
    const measuredRows = db
      .select({ used_pct: usageLimits.used_pct, model_bucket: usageLimits.model_bucket })
      .from(usageLimits)
      .where(
        and(
          gte(usageLimits.observed_at, b.created_at),
          lte(usageLimits.observed_at, b.created_at + 3600),
          inArray(usageLimits.source, ["cli", "oauth"]),
        ),
      )
      .all();

    const relevant = measuredRows.filter(isFleetRelevant);
    const maxMeasured =
      relevant.length > 0
        ? Math.max(...relevant.map((r) => r.used_pct))
        : null;

    if (maxMeasured === null || maxMeasured < softPct) {
      false_pause_count++;
    }
  }

  return {
    window_days: windowDays,
    drift,
    pause_count,
    peak_pct,
    guard_miss_count,
    false_pause_count,
    false_pause_denom,
  };
}
