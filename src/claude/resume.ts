import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks, type Task } from "@/db/schema";
import { now, type Stage } from "@/workflow/types";
import { MODEL_BY_STAGE, type ModelStage } from "./model-map";

/**
 * Session-continuity policy (V1 retry-resume + V2 impl→verify).
 *
 * A stage run may resume a prior session when the transcript's context is
 * still an asset: same model (prompt cache is per-model — a cross-model
 * resume re-tokenizes everything at full price) and fresh enough that the
 * cache is plausibly warm (event-driven chaining keeps eligible hops in the
 * seconds range; past the TTL a resume pays cache-WRITE on the accumulated
 * transcript and can cost more than a cold spawn).
 *
 * Deliberately NEVER resumes:
 * - AI-REVIEW: a reviewer inheriting the implementer's session is
 *   self-review — cold fresh-eyes is quality architecture, and the contested
 *   re-review is an intentional cold Opus fork (see model-map ladder).
 * - PLANNING: first stage; nothing worth inheriting.
 *
 * Kill switch: KRILL_RESUME=0 (cold spawns everywhere, the pre-continuity
 * behavior). The stage_usage `resumed` column is the A/B marker either way.
 */
export type SessionMap = Partial<
  Record<ModelStage, { id: string; model: string; at: number }>
>;

// Which prior stages' sessions a stage may inherit, in preference order
// (most useful context first — a verify retry prefers the newest of impl or
// its own prior attempt, resolved by freshness below).
const RESUME_SOURCES: Partial<Record<ModelStage, ModelStage[]>> = {
  implementing: ["implementing"], // V1: retry after decline / verify-fail
  verify: ["implementing", "verify"], // V2 + V1: impl context or prior attempt
};

// Past this age the prompt cache (5-min TTL) is stale and a resume pays
// cache-write on the whole accumulated transcript — worse than cold.
export const RESUME_MAX_AGE_S = 300;

export function parseSessionMap(task: Pick<Task, "session_map">): SessionMap {
  if (!task.session_map) return {};
  try {
    const m = JSON.parse(task.session_map) as SessionMap;
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

/**
 * Pick the session a run of `stage` (on `model`) should resume, or undefined
 * for a cold spawn. Pure given (task row, stage, model, now) — tested offline.
 */
export function pickResumeSession(
  task: Pick<Task, "session_map">,
  stage: ModelStage,
  model: string,
  nowSec: number = now(),
): string | undefined {
  if (process.env.KRILL_RESUME === "0") return undefined;
  const sources = RESUME_SOURCES[stage];
  if (!sources) return undefined;

  const map = parseSessionMap(task);
  const candidates = sources
    .map((s) => map[s])
    .filter((e): e is NonNullable<typeof e> => !!e?.id)
    .filter((e) => e.model === model)
    .filter((e) => nowSec - e.at <= RESUME_MAX_AGE_S)
    .sort((a, b) => b.at - a.at);
  return candidates[0]?.id;
}

/** Persist a finished run's session under its stage (best-effort). */
export function recordStageSession(
  taskId: string,
  stage: ModelStage,
  sessionId: string,
  model: string,
): void {
  try {
    const row = db
      .select({ session_map: tasks.session_map })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    const map = parseSessionMap({ session_map: row?.session_map ?? null });
    map[stage] = { id: sessionId, model, at: now() };
    db.update(tasks)
      .set({ session_map: JSON.stringify(map), updated_at: now() })
      .where(eq(tasks.id, taskId))
      .run();
  } catch (err) {
    console.warn(`session_map update failed for ${taskId}:`, err);
  }
}

/** Effective model for a stage run (mirrors the runner's fallback). */
export function effectiveModel(stage: ModelStage, override?: string): string {
  return override ?? MODEL_BY_STAGE[stage];
}

// Re-exported for the workflow layer without importing model-map everywhere.
export type { ModelStage, Stage };
