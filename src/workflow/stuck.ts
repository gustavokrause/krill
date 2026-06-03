import { and, inArray, isNull, lt, sql } from "drizzle-orm";
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
import { now, type Stage } from "./types";

const STATUS_TO_STAGE: Record<TaskStatus, Stage | null> = {
  BACKLOG: null,
  TODO: null,
  PLANNING: "planning",
  IMPLEMENTING: "implementing",
  "AI-REVIEW": "ai_review",
  PUBLISHING: "publishing",
  NEEDS_REVIEW: null,
  DONE: null,
  CANCELED: null,
};

export type StuckTask = {
  task: Task;
  stage: Stage;
  ageSec: number;
  maxSec: number;
};

/**
 * Find active, currently-unclaimed tasks whose stage_entered_at exceeds
 * max_stage_duration[stage]. Returns an array; no auto-recovery.
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
        isNull(tasks.claimed_until),
        lt(tasks.stage_entered_at, ts),
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

export function runStuckScanner(): void {
  const stuck = findStuckTasks();
  for (const s of stuck) {
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
