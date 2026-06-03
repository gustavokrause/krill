import { statSync } from "node:fs";
import { resolve } from "node:path";
import { count, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  globalConfig,
  PARALLEL_SLOT_STATUSES,
  projects,
  tasks,
  TASK_STATUSES,
  type TaskStatus,
} from "@/db/schema";
import { snapshotBackoff } from "@/workflow/backoff";
import { findStuckTasks } from "@/workflow/stuck";
import { listenerCount } from "@/lib/sse";

export type HealthSnapshot = {
  db: { path: string; size_bytes: number | null };
  automation_enabled: boolean;
  stage_enabled: Record<string, boolean>;
  backoff: ReturnType<typeof snapshotBackoff>;
  projects: { total: number; paused: number };
  tasks_by_status: Record<TaskStatus, number>;
  active_tasks: number;
  stuck: Array<{ taskId: string; stage: string; ageSec: number; maxSec: number }>;
  sse_listeners: number;
  pinned_claude_version: string | null;
};

export function getHealth(): HealthSnapshot {
  const cfg = db
    .select()
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();

  const totalProjects = db
    .select({ n: count() })
    .from(projects)
    .get()?.n ?? 0;
  const pausedProjects = db
    .select({ n: count() })
    .from(projects)
    .where(eq(projects.paused, true))
    .get()?.n ?? 0;

  const rows = db
    .select({ status: tasks.status, n: count() })
    .from(tasks)
    .groupBy(tasks.status)
    .all();
  const byStatus = Object.fromEntries(
    TASK_STATUSES.map((s) => [s, 0]),
  ) as Record<TaskStatus, number>;
  for (const r of rows) byStatus[r.status as TaskStatus] = Number(r.n);
  const active = PARALLEL_SLOT_STATUSES.reduce((n, s) => n + byStatus[s], 0);

  const dbPath = resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.DB_PATH ?? "data/tasks.db");
  let size: number | null = null;
  try {
    size = statSync(dbPath).size;
  } catch {}

  const stuck = findStuckTasks().map((s) => ({
    taskId: s.task.id,
    stage: s.stage,
    ageSec: s.ageSec,
    maxSec: s.maxSec,
  }));

  return {
    db: { path: dbPath, size_bytes: size },
    automation_enabled: cfg?.automation_enabled ?? false,
    stage_enabled: cfg?.stage_enabled ?? {},
    backoff: snapshotBackoff(),
    projects: { total: Number(totalProjects), paused: Number(pausedProjects) },
    tasks_by_status: byStatus,
    active_tasks: active,
    stuck,
    sse_listeners: listenerCount(),
    pinned_claude_version: process.env.CLAUDE_CODE_VERSION ?? null,
  };
}

