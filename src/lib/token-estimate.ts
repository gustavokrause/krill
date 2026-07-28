// Price weights relative to 1 input token (Anthropic published ratios).
// cache_read at 0.1x kills the raw-volume inflation (~90% of tokens, ~10% of price).
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { stageUsage } from "@/db/schema";

export const PRICE_WEIGHTS = {
  input: 1,
  output: 5,
  cache_creation: 1.25,
  cache_read: 0.1,
} as const;

const MIN_PROJECT_SAMPLES = 5;

export type Stage = "planning" | "implementing" | "ai_review" | "verify";

export function stagesForTask(flags: {
  skip_plan: boolean;
  skip_ai_review: boolean;
  skip_verify?: boolean | null;
  mode: string;
}): Stage[] {
  const stages: Stage[] = ["implementing"];
  if (!flags.skip_plan) stages.push("planning");
  if (!flags.skip_ai_review) stages.push("ai_review");
  const skipVerify = flags.skip_verify ?? flags.mode !== "dev";
  if (!skipVerify) stages.push("verify");
  return stages;
}

function medianOf(arr: number[]): number {
  const sorted = arr.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

const WEIGHTED_TOTAL = sql<number>`
  ${stageUsage.input_tokens} * 1.0
  + ${stageUsage.output_tokens} * 5.0
  + ${stageUsage.cache_creation_tokens} * 1.25
  + ${stageUsage.cache_read_tokens} * 0.1
`;

/** Per-stage median of price-weighted token totals. */
export function getStagePriceWeightedMedians(
  scope: "fleet" | { projectId: string },
): Record<string, number> {
  const base = db
    .select({ stage: stageUsage.stage, weighted: WEIGHTED_TOTAL })
    .from(stageUsage);

  const rows =
    scope === "fleet"
      ? base.all()
      : base.where(eq(stageUsage.project_id, scope.projectId)).all();

  const byStage = new Map<string, number[]>();
  for (const r of rows) {
    const a = byStage.get(r.stage) ?? [];
    a.push(Number(r.weighted));
    byStage.set(r.stage, a);
  }

  const out: Record<string, number> = {};
  for (const [stage, arr] of byStage) {
    out[stage] = Math.round(medianOf(arr));
  }
  return out;
}

/**
 * Estimate total price-weighted tokens for a new task.
 * Prefers per-project medians when the project has >= MIN_PROJECT_SAMPLES rows
 * for a stage; falls back to fleet. Returns null if no data exists for any stage.
 */
export function estimateTaskTokens(opts: {
  projectId: string;
  stages: Stage[];
}): number | null {
  if (opts.stages.length === 0) return null;

  const rows = db
    .select({
      stage: stageUsage.stage,
      project_id: stageUsage.project_id,
      weighted: WEIGHTED_TOTAL,
    })
    .from(stageUsage)
    .where(inArray(stageUsage.stage, opts.stages))
    .all();

  const fleet = new Map<string, number[]>();
  const project = new Map<string, number[]>();

  for (const r of rows) {
    const w = Number(r.weighted);
    const fa = fleet.get(r.stage) ?? [];
    fa.push(w);
    fleet.set(r.stage, fa);
    if (r.project_id === opts.projectId) {
      const pa = project.get(r.stage) ?? [];
      pa.push(w);
      project.set(r.stage, pa);
    }
  }

  let total = 0;
  let anyData = false;

  for (const stage of opts.stages) {
    const proj = project.get(stage) ?? [];
    const fl = fleet.get(stage) ?? [];
    const samples = proj.length >= MIN_PROJECT_SAMPLES ? proj : fl;
    if (samples.length === 0) continue;
    total += medianOf(samples);
    anyData = true;
  }

  return anyData ? Math.round(total) : null;
}
