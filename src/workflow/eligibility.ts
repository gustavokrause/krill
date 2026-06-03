import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  CONFLICTS_BLOCKING_STATUSES,
  PARALLEL_SLOT_STATUSES,
  projects,
  tasks,
  type Task,
} from "@/db/schema";

export type EligibilityReason =
  | "ok"
  | "deps_not_done"
  | "conflict_active"
  | "max_parallel_reached"
  | "project_paused";

export type EligibilityResult = {
  eligible: boolean;
  reason: EligibilityReason;
};

/**
 * Check whether a TODO task is eligible to be picked.
 *  - all depends_on tasks must be DONE
 *  - no conflicts_with task in active states
 *  - project active count < max_parallel_tasks
 *  - project not paused
 */
export function checkEligibility(task: Task): EligibilityResult {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, task.project_id))
    .get();

  if (!project) return { eligible: false, reason: "project_paused" };
  if (project.paused) return { eligible: false, reason: "project_paused" };

  if (task.depends_on.length > 0) {
    const rows = db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, task.depends_on))
      .all();
    const allDone =
      rows.length === task.depends_on.length &&
      rows.every((r) => r.status === "DONE");
    if (!allDone) return { eligible: false, reason: "deps_not_done" };
  }

  if (task.conflicts_with.length > 0) {
    const activeConflict = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          inArray(tasks.id, task.conflicts_with),
          inArray(tasks.status, CONFLICTS_BLOCKING_STATUSES),
        ),
      )
      .get();
    if (activeConflict) return { eligible: false, reason: "conflict_active" };
  }

  const activeCountRow = db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.project_id, project.id),
        inArray(tasks.status, PARALLEL_SLOT_STATUSES),
      ),
    )
    .get();
  const activeCount = activeCountRow?.n ?? 0;
  if (activeCount >= project.max_parallel_tasks) {
    return { eligible: false, reason: "max_parallel_reached" };
  }

  return { eligible: true, reason: "ok" };
}
