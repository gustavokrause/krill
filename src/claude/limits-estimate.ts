import { gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { stageUsage } from "@/db/schema";
import type { LimitProvider, LimitRow } from "./limits";

// Seed budget estimates for Claude Pro/Team. Rough baselines — update when
// Anthropic publishes exact per-tier numbers. rows are always source='estimate'
// and clearly flagged as a local guess, never presented as authoritative.
const SESSION_5H_USD = 20.0; // ~5M tokens @ opus-class pricing
const WEEK_USD = 150.0; // ~40M tokens over 7 days

function costInWindow(windowSec: number, nowEpoch: number): number {
  const cutoff = nowEpoch - windowSec;
  return (
    db
      .select({ v: sql<number>`coalesce(sum(${stageUsage.cost_usd}), 0)` })
      .from(stageUsage)
      .where(gte(stageUsage.created_at, cutoff))
      .get()?.v ?? 0
  );
}

export const estimateProvider: LimitProvider = {
  name: "estimate",
  probe(now: number): Promise<LimitRow[]> {
    const cost5h = costInWindow(18_000, now);
    const cost7d = costInWindow(604_800, now);
    return Promise.resolve([
      {
        scope: "session_5h",
        model_bucket: null,
        used_pct: Math.min(100, (cost5h / SESSION_5H_USD) * 100),
        resets_at: null,
        source: "estimate",
        raw: null,
      },
      {
        scope: "week",
        model_bucket: null,
        used_pct: Math.min(100, (cost7d / WEEK_USD) * 100),
        resets_at: null,
        source: "estimate",
        raw: null,
      },
    ]);
  },
};
