import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { projects, tasks, type Task, type TaskStatus } from "@/db/schema";
import { checkEligibility } from "./eligibility";
import { STAGE_TO_PICK_STATUS, type Stage, now } from "./types";

export type ClaimInput = {
  stage: Stage;
  workerId: string;
  /** Claim TTL in seconds (defaults read from caller). */
  ttlSeconds: number;
};

/**
 * Atomically claim the next task for `stage`. Returns the claimed task or
 * null if no eligible task is available.
 *
 * Uses an IMMEDIATE transaction so concurrent claim() callers serialize on
 * write — at most one wins per task. Stale claims (claimed_until < now())
 * are reclaimable. For todo_picker stage, the eligibility filter is applied
 * (depends_on / conflicts_with / max_parallel_tasks / paused).
 */
export function claim(input: ClaimInput): Task | null {
  const status: TaskStatus = STAGE_TO_PICK_STATUS[input.stage];
  const ts = now();
  const expiry = ts + input.ttlSeconds;

  return db.transaction(
    (tx) => {
      const activeProjectIds = tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.paused, false))
        .all()
        .map((r) => r.id);

      if (activeProjectIds.length === 0) return null;

      const candidates = tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.status, status),
            eq(tasks.blocked, false), // paused on an interactive block — skip
            or(isNull(tasks.claimed_until), lt(tasks.claimed_until, ts)),
            inArray(tasks.project_id, activeProjectIds),
          ),
        )
        .orderBy(asc(tasks.priority), asc(tasks.created_at))
        .all();

      for (const task of candidates) {
        if (input.stage === "todo_picker") {
          const elig = checkEligibility(task);
          if (!elig.eligible) continue;
        }

        const updated = tx
          .update(tasks)
          .set({
            claimed_until: expiry,
            claimed_by: input.workerId,
            updated_at: ts,
          })
          .where(
            and(
              eq(tasks.id, task.id),
              eq(tasks.status, status),
              or(isNull(tasks.claimed_until), lt(tasks.claimed_until, ts)),
            ),
          )
          .returning()
          .all();

        if (updated.length === 1) return updated[0];
      }

      return null;
    },
    { behavior: "immediate" },
  );
}

export const _claimExpiryNow = sql<number>`(unixepoch())`;
