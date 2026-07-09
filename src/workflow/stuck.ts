import { and, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  STUCK_WATCHED_STATUSES,
  globalConfig,
  tasks,
  type Task,
  type TaskStatus,
} from "@/db/schema";
import { DEFAULT_MAX_STAGE_DURATION } from "@/db/defaults";
import { broadcast } from "@/lib/sse";
import { pauseLineForHuman } from "./blockers";
import { getBootId } from "./boot-id";
import { appendAiComment } from "./comment";
import { forceReleaseClaim, transitionStatus } from "./transition";
import { now, type Stage } from "./types";

const STATUS_TO_STAGE: Record<TaskStatus, Stage | null> = {
  BACKLOG: null,
  TODO: null,
  PLANNING: "planning",
  IMPLEMENTING: "implementing",
  "AI-REVIEW": "ai_review",
  VERIFYING: "verify",
  PUBLISHING: "publishing",
  NEEDS_REVIEW: null,
  DONE: null,
  CANCELED: null,
};

// Past this multiple of max_stage_duration the scanner stops notifying and
// force-concludes: a task that has sat in one stage this long is not slow, it
// is not progressing, and every path that could conclude it has already had
// several full stage windows to do so. Parking at NEEDS_REVIEW(stuck) is the
// "always conclude" backstop — escalate to a human, never loop forever.
const FORCE_CONCLUDE_FACTOR = 3;

export type StuckTask = {
  task: Task;
  stage: Stage;
  ageSec: number;
  maxSec: number;
};

/**
 * Find active, currently-unclaimed tasks whose stage_entered_at exceeds
 * max_stage_duration[stage].
 *
 * "Unclaimed" is enforced (claimed_until IS NULL or lapsed): a live claim means
 * a worker is legitimately inside the stage right now — long-running but
 * in-flight work must not be flagged, per the OVERVIEW.md stuck definition.
 * An expired claim is treated as unclaimed (the orphaned-worker case).
 */
export function findStuckTasks(): StuckTask[] {
  const cfg = db
    .select({ max: globalConfig.max_stage_duration })
    .from(globalConfig)
    .where(sql`id = 1`)
    .get();
  const maxByStage = cfg?.max ?? DEFAULT_MAX_STAGE_DURATION;

  const ts = now();
  const candidates = db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, STUCK_WATCHED_STATUSES),
        lt(tasks.stage_entered_at, ts),
        or(isNull(tasks.claimed_until), lt(tasks.claimed_until, ts)),
      ),
    )
    .all();

  const stuck: StuckTask[] = [];
  for (const t of candidates) {
    const stage = STATUS_TO_STAGE[t.status];
    if (!stage) continue;
    const limit = (maxByStage as Record<string, number>)[stage];
    if (!limit) continue;
    const age = ts - t.stage_entered_at;
    if (age > limit) {
      stuck.push({ task: t, stage, ageSec: age, maxSec: limit });
    }
  }
  return stuck;
}

/**
 * Notify on stuck tasks; force-conclude the ones stuck past
 * FORCE_CONCLUDE_FACTOR × max_stage_duration.
 *
 * Below the hard cap: warn + SSE, recovery is claim-TTL lapse → re-pick (the
 * task may still self-resolve). Past it: park at NEEDS_REVIEW(stuck) and pause
 * the line — the backstop that guarantees every task eventually concludes at a
 * human gate instead of looping through pick → hang → TTL → re-pick forever.
 */
export function runStuckScanner(): void {
  releaseOrphanedClaims();
  const stuck = findStuckTasks();
  for (const s of stuck) {
    if (s.ageSec > s.maxSec * FORCE_CONCLUDE_FACTOR) {
      forceConcludeStuck(s);
      continue;
    }
    console.warn(
      `[stuck] task=${s.task.id} status=${s.task.status} age=${s.ageSec}s limit=${s.maxSec}s`,
    );
    broadcast({
      type: "task.stuck",
      taskId: s.task.id,
      stage: s.stage,
      ageSec: s.ageSec,
      maxSec: s.maxSec,
    });
  }
}

/**
 * Auto-release claims held by a dead process. `claim_gen` records the boot id
 * of the process that claimed; a live claim whose gen differs from ours was
 * made by a process that no longer exists — its worker died with it, and the
 * task would otherwise strand until the claim TTL (up to 30 min) or a manual
 * Recover click. Runs every scanner tick, so a restart's orphans are re-picked
 * within a minute instead.
 */
export function releaseOrphanedClaims(): void {
  const ts = now();
  const orphans = db
    .select({ id: tasks.id, status: tasks.status, gen: tasks.claim_gen })
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.claimed_by),
        gt(tasks.claimed_until, ts),
        isNotNull(tasks.claim_gen),
        ne(tasks.claim_gen, getBootId()),
      ),
    )
    .all();
  for (const o of orphans) {
    console.warn(
      `[stuck] releasing orphaned claim task=${o.id} status=${o.status} claim_gen=${o.gen} (worker dead)`,
    );
    forceReleaseClaim(o.id);
  }
}

function forceConcludeStuck(s: StuckTask): void {
  // transitionStatus is atomic on (id, from) and clears the claim itself; if
  // the task moved concurrently we simply lost the race and there is nothing
  // to conclude.
  const parked = transitionStatus({
    taskId: s.task.id,
    from: s.task.status,
    to: "NEEDS_REVIEW",
    pendingReviewKind: "stuck",
  });
  if (!parked) return;

  appendAiComment(
    s.task.id,
    `[stuck-force-conclude] ${s.task.status} made no progress for ${s.ageSec}s ` +
      `(limit ${s.maxSec}s, hard cap ${s.maxSec * FORCE_CONCLUDE_FACTOR}s). ` +
      `Parked for human review — investigate why the stage never concluded, then ` +
      `move the task back to retry the stage.`,
    s.task.status,
  );
  console.warn(
    `[stuck] force-concluded task=${s.task.id} status=${s.task.status} age=${s.ageSec}s`,
  );
  pauseLineForHuman({
    taskId: s.task.id,
    stage: s.stage,
    summary: `${s.task.id} stuck in ${s.task.status} for ${Math.round(s.ageSec / 60)} min — force-parked`,
    detail: `stage limit ${s.maxSec}s, hard cap ${s.maxSec * FORCE_CONCLUDE_FACTOR}s exceeded`,
  });
}
