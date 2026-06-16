import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { blockers, tasks, type Blocker } from "@/db/schema";
import { now } from "./types";

export function listBlockers(status?: string): Blocker[] {
  const rows = db.select().from(blockers).orderBy(desc(blockers.created_at)).all();
  return status ? rows.filter((b) => b.status === status) : rows;
}

export function getBlocker(id: string): Blocker | undefined {
  return db.select().from(blockers).where(eq(blockers.id, id)).get();
}

/** Flag/unflag a task as paused on a block; claim() skips blocked tasks. */
export function setTaskBlocked(taskId: string, blocked: boolean): void {
  db.update(tasks).set({ blocked, updated_at: now() }).where(eq(tasks.id, taskId)).run();
}

/**
 * File a blocker. Deduped on (kind, task_id, stage) while open — a task that
 * keeps re-blocking refreshes one row instead of piling up.
 */
export function addBlocker(b: {
  kind: string;
  task_id?: string | null;
  stage?: string | null;
  summary: string;
  detail?: string;
  action_url?: string | null;
}): Blocker {
  const open = listBlockers("open").find(
    (x) => x.kind === b.kind && x.task_id === (b.task_id ?? null) && x.stage === (b.stage ?? null),
  );
  if (open) {
    db.update(blockers)
      .set({ summary: b.summary, detail: b.detail ?? "", action_url: b.action_url ?? null, created_at: now() })
      .where(eq(blockers.id, open.id))
      .run();
    return getBlocker(open.id)!;
  }
  const row = {
    id: randomUUID(),
    source: "krill",
    kind: b.kind,
    status: "open",
    task_id: b.task_id ?? null,
    stage: b.stage ?? null,
    summary: b.summary,
    detail: b.detail ?? "",
    action_url: b.action_url ?? null,
    created_at: now(),
    resolved_at: null,
  };
  db.insert(blockers).values(row).run();
  return row as Blocker;
}

/**
 * Resolve a blocker. On "resolved", unblock its task so the next tick re-runs
 * the paused stage. "dismissed" clears the blocker but leaves the task blocked.
 */
export function resolveBlocker(id: string, status: "resolved" | "dismissed" = "resolved"): Blocker | undefined {
  const b = getBlocker(id);
  if (!b) return undefined;
  db.update(blockers).set({ status, resolved_at: now() }).where(eq(blockers.id, id)).run();
  if (status === "resolved" && b.task_id) setTaskBlocked(b.task_id, false);
  return getBlocker(id);
}
