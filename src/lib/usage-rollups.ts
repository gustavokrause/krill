// Read-side rollups over the append-only stage_usage table (the write side lives
// in claude/usage.ts). Stage is the leaf; everything here is a SUM/GROUP BY over
// it. Total tokens = input + output + cache_creation + cache_read.
import { eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { stageUsage } from "@/db/schema";

const TOTAL = sql<number>`coalesce(sum(${stageUsage.input_tokens} + ${stageUsage.output_tokens} + ${stageUsage.cache_creation_tokens} + ${stageUsage.cache_read_tokens}), 0)`;

export type StageUsageRollup = {
  stage: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
};

/** Per-stage breakdown for one task (re-runs of a stage summed into one row). */
export function getTaskStageUsage(taskId: string): StageUsageRollup[] {
  return db
    .select({
      stage: stageUsage.stage,
      runs: sql<number>`count(*)`,
      input_tokens: sql<number>`coalesce(sum(${stageUsage.input_tokens}), 0)`,
      output_tokens: sql<number>`coalesce(sum(${stageUsage.output_tokens}), 0)`,
      cache_creation_tokens: sql<number>`coalesce(sum(${stageUsage.cache_creation_tokens}), 0)`,
      cache_read_tokens: sql<number>`coalesce(sum(${stageUsage.cache_read_tokens}), 0)`,
      total_tokens: TOTAL,
      cost_usd: sql<number>`coalesce(sum(${stageUsage.cost_usd}), 0)`,
      num_turns: sql<number>`coalesce(sum(${stageUsage.num_turns}), 0)`,
      duration_ms: sql<number>`coalesce(sum(${stageUsage.duration_ms}), 0)`,
    })
    .from(stageUsage)
    .where(eq(stageUsage.task_id, taskId))
    .groupBy(stageUsage.stage)
    .all();
}

/** Total tokens metered since local midnight — the global footer number. */
export function getTokensToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const start = Math.floor(d.getTime() / 1000);
  return (
    db
      .select({ total: TOTAL })
      .from(stageUsage)
      .where(gte(stageUsage.created_at, start))
      .get()?.total ?? 0
  );
}

/**
 * Cost + split since local midnight. Raw token sums read ~10× scarier than
 * reality — ~90% of a task's "tokens" are the same cached prefix re-read every
 * agent turn at cache-read rates. Cost is the honest scalar; the split lets
 * the UI say why the raw number is big without lying about it.
 */
export function getSpendToday(): {
  cost_usd: number;
  new_tokens: number; // input + output + cache writes — tokenized once
  cache_read_tokens: number; // prefix re-reads, ~0.1× weight
} {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const start = Math.floor(d.getTime() / 1000);
  const row = db
    .select({
      cost_usd: sql<number>`coalesce(sum(${stageUsage.cost_usd}), 0)`,
      new_tokens: sql<number>`coalesce(sum(${stageUsage.input_tokens} + ${stageUsage.output_tokens} + ${stageUsage.cache_creation_tokens}), 0)`,
      cache_read_tokens: sql<number>`coalesce(sum(${stageUsage.cache_read_tokens}), 0)`,
    })
    .from(stageUsage)
    .where(gte(stageUsage.created_at, start))
    .get();
  return {
    cost_usd: row?.cost_usd ?? 0,
    new_tokens: row?.new_tokens ?? 0,
    cache_read_tokens: row?.cache_read_tokens ?? 0,
  };
}

/**
 * Per-stage median of per-spawn total tokens — whale's estimation basis. SQLite
 * has no median fn, so pull totals and compute in JS. Empty until runs accrue;
 * whale treats a missing stage as 0 (degrades to a low estimate, not a crash).
 */
export function getStageMedians(): Record<string, number> {
  const rows = db
    .select({
      stage: stageUsage.stage,
      total: sql<number>`${stageUsage.input_tokens} + ${stageUsage.output_tokens} + ${stageUsage.cache_creation_tokens} + ${stageUsage.cache_read_tokens}`,
    })
    .from(stageUsage)
    .all();

  const byStage = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byStage.get(r.stage) ?? [];
    arr.push(Number(r.total));
    byStage.set(r.stage, arr);
  }

  const out: Record<string, number> = {};
  for (const [stage, arr] of byStage) {
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    out[stage] =
      arr.length % 2
        ? arr[mid]
        : Math.round((arr[mid - 1] + arr[mid]) / 2);
  }
  return out;
}

/** project_id → total tokens, for the projects page. */
export function getProjectTokenTotals(projectIds?: string[]): Map<string, number> {
  const base = db
    .select({ project_id: stageUsage.project_id, total: TOTAL })
    .from(stageUsage);
  const rows = (
    projectIds && projectIds.length
      ? base.where(inArray(stageUsage.project_id, projectIds))
      : base
  )
    .groupBy(stageUsage.project_id)
    .all();
  return new Map(rows.map((r) => [r.project_id, Number(r.total)]));
}
