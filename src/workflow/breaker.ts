import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects, tasks } from "@/db/schema";
import { now } from "./types";
import { appendAiComment } from "./comment";

const TERMINAL = new Set(["DONE", "CANCELED"]);

// Circuit-breaker thresholds (A3): halt a project's auto-finish on systemic failure.
export const BREAKER_MIN_FAILS = 2;
export const BREAKER_FAIL_RATE = 0.3;
export const BREAKER_WINDOW_SEC = 60 * 60; // 1h

/**
 * Decline → cancel subtree (A3). Transitively cancel the non-terminal tasks that
 * depend on `taskId`. Dependents are normally upstream-blocked (BACKLOG/TODO,
 * never started) since their dep isn't DONE, so this is a force-cancel, not a
 * mid-run abort. Independent tasks are untouched. Returns count canceled.
 */
export function cancelDependentsCascade(
  taskId: string,
  reason = "upstream task canceled",
): number {
  const queue = [taskId];
  const seen = new Set([taskId]);
  let count = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    const all = db.select().from(tasks).all();
    for (const t of all) {
      if (seen.has(t.id) || TERMINAL.has(t.status)) continue;
      if ((t.depends_on ?? []).includes(cur)) {
        db.update(tasks)
          .set({ status: "CANCELED", pending_review_kind: null, ended_at: now(), updated_at: now() })
          .where(eq(tasks.id, t.id))
          .run();
        appendAiComment(t.id, `auto-canceled: ${reason} (${cur})`);
        seen.add(t.id);
        queue.push(t.id);
        count++;
      }
    }
  }
  return count;
}

/**
 * Circuit breaker (A3): scoped to auto-finish. If recent auto_publish tasks in a
 * project fail (CANCELED or NEEDS_REVIEW) past the threshold — 2 failures OR 30%
 * of recent auto-finish tasks — pause the project so a bad batch can't snowball.
 * Returns true if it tripped.
 */
export function tripAutoFinishBreaker(projectId: string, triggerTaskId?: string): boolean {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project || project.paused) return false;

  const since = now() - BREAKER_WINDOW_SEC;
  const recent = db
    .select({ status: tasks.status, updated_at: tasks.updated_at, auto_publish: tasks.auto_publish })
    .from(tasks)
    .where(eq(tasks.project_id, projectId))
    .all()
    .filter((t) => t.auto_publish && t.updated_at >= since);

  const fails = recent.filter(
    (t) => t.status === "CANCELED" || t.status === "NEEDS_REVIEW",
  ).length;
  const tripped =
    fails >= BREAKER_MIN_FAILS ||
    (recent.length >= 3 && fails / recent.length >= BREAKER_FAIL_RATE);
  if (!tripped) return false;

  db.update(projects).set({ paused: true, updated_at: now() }).where(eq(projects.id, projectId)).run();
  if (triggerTaskId) {
    appendAiComment(
      triggerTaskId,
      `circuit breaker tripped: ${fails} auto-finish failure(s) in project — project paused, escalating to human`,
      "NEEDS_REVIEW",
    );
  }
  return true;
}
