import { claim } from "../claim";
import { transitionStatus } from "../transition";
import { now } from "../types";

/**
 * TODO picker. claim() already filters by eligibility (deps DONE / no active
 * conflict / under max_parallel / project not paused). Picking is therefore
 * a deterministic atomic transition — we do not spawn a model here.
 *
 * Routes `skip_plan=true` tasks straight to IMPLEMENTING (the implementing
 * handler does the worktree/workspace setup that PLANNING would have done).
 * Without this shortcut, skip_plan tasks would burn one PLANNING cron tick
 * just to do setup and immediately advance.
 */
export async function runTodoPicker(workerId: string): Promise<string | null> {
  const task = claim({
    stage: "todo_picker",
    workerId,
    ttlSeconds: 60,
  });
  if (!task) return null;

  const startedAt = task.started_at ?? now();
  const target = task.skip_plan ? "IMPLEMENTING" : "PLANNING";
  const moved = transitionStatus({
    taskId: task.id,
    from: "TODO",
    to: target,
    startedAt,
  });
  if (!moved) return null;
  return task.id;
}
