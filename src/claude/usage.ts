import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { stageUsage, tasks, type Task } from "@/db/schema";
import { broadcast } from "@/lib/sse";
import { now } from "@/workflow/types";
import { getRunner } from "./index";
import { MODEL_BY_STAGE, type ModelStage } from "./model-map";
import type { RunnerInput, RunnerOutput, RunUsage } from "./runner";

/**
 * Append one stage_usage row (the leaf) and bump the task's denormalized
 * tokens_used rollup. Best-effort: usage is only ever passed when the runner
 * produced a parseable json envelope, so a missing/garbled run records nothing.
 */
export function recordStageUsage(
  task: Task,
  stage: ModelStage,
  projectId: string,
  usage: RunUsage,
  model?: string,
): void {
  const total =
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_tokens +
    usage.cache_read_tokens;

  db.insert(stageUsage)
    .values({
      id: randomUUID(),
      task_id: task.id,
      project_id: projectId,
      stage,
      // Record the model that actually ran (ladder overrides), not the stage
      // default — the decline-flip metering keys on this column.
      model: model ?? MODEL_BY_STAGE[stage],
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_tokens: usage.cache_creation_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cost_usd: usage.cost_usd,
      num_turns: usage.num_turns,
      duration_ms: usage.duration_ms,
      created_at: now(),
    })
    .run();

  const updated = db
    .update(tasks)
    .set({
      tokens_used: sql`${tasks.tokens_used} + ${total}`,
      updated_at: now(),
    })
    .where(eq(tasks.id, task.id))
    .returning()
    .all();

  // Push the new tokens_used to the board (reuses the existing task.updated SSE).
  if (updated[0]) broadcast({ type: "task.updated", task: updated[0] });
}

/**
 * Run a stage through the active runner and meter its token usage. Drop-in for
 * `getRunner().run(input)` — same signature, same throw behavior; the only
 * addition is the usage row recorded on a successful, parseable run.
 */
export async function runStage(input: RunnerInput): Promise<RunnerOutput> {
  const out = await getRunner().run(input);
  if (out.usage) {
    recordStageUsage(
      input.task,
      input.stage,
      input.project.id,
      out.usage,
      input.model,
    );
  }
  return out;
}
