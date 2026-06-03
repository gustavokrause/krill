import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks, type ReviewKind, type TaskStatus } from "@/db/schema";
import { broadcast } from "@/lib/sse";
import { now } from "./types";

type TransitionInput = {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  pendingReviewKind?: ReviewKind;
  startedAt?: number;
  endedAt?: number;
};

/**
 * Atomic status transition. Returns true if the row moved, false if the
 * caller's expected `from` no longer matches (another worker raced ahead).
 * Clears claim and resets stage_entered_at on success.
 *
 * Always rewrites `pending_review_kind`: set to `pendingReviewKind` when
 * `to === "NEEDS_REVIEW"` (caller must pass it), cleared to NULL otherwise.
 */
export function transitionStatus(input: TransitionInput): boolean {
  if (input.to === "NEEDS_REVIEW" && !input.pendingReviewKind) {
    throw new Error(
      `transitionStatus: pendingReviewKind required when to='NEEDS_REVIEW' (task ${input.taskId})`,
    );
  }
  const ts = now();
  const result = db
    .update(tasks)
    .set({
      status: input.to,
      pending_review_kind:
        input.to === "NEEDS_REVIEW" ? input.pendingReviewKind! : null,
      stage_entered_at: ts,
      updated_at: ts,
      claimed_until: null,
      claimed_by: null,
      ...(input.startedAt !== undefined ? { started_at: input.startedAt } : {}),
      ...(input.endedAt !== undefined ? { ended_at: input.endedAt } : {}),
    })
    .where(and(eq(tasks.id, input.taskId), eq(tasks.status, input.from)))
    .run();

  if (result.changes !== 1) return false;

  const task = db.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
  if (task) {
    broadcast({
      type: "task.transitioned",
      task,
      from: input.from,
      to: input.to,
    });
  }
  return true;
}

/**
 * Release a claim without changing status. Used when a worker exits the
 * stage without making progress (e.g., crash recovery or noop tick).
 */
export function releaseClaim(taskId: string, workerId: string): boolean {
  const ts = now();
  const result = db
    .update(tasks)
    .set({ claimed_until: null, claimed_by: null, updated_at: ts })
    .where(and(eq(tasks.id, taskId), eq(tasks.claimed_by, workerId)))
    .run();
  if (result.changes !== 1) return false;
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (task) broadcast({ type: "task.updated", task });
  return true;
}

/**
 * Touch updated_at without other changes. Useful for SSE wakeups.
 */
export function touchTask(taskId: string): void {
  db.update(tasks)
    .set({ updated_at: now() })
    .where(eq(tasks.id, taskId))
    .run();
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (task) broadcast({ type: "task.updated", task });
}
