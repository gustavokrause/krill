import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { blockers, globalConfig, tasks, type Blocker, type StageEnabled } from "@/db/schema";
import { broadcast } from "@/lib/sse";
import { now } from "./types";

/**
 * Flip the global todo-picker on/off and broadcast config.changed. Idempotent.
 * Auto-pauses auto-picking when a task surfaces a follow-up (so a human reviews
 * it first); re-enabled when the follow-up blocker is resolved.
 */
export function setTodoPickerEnabled(enabled: boolean): void {
  const cur = db.select().from(globalConfig).where(eq(globalConfig.id, 1)).get();
  if (!cur) return;
  const se = cur.stage_enabled as StageEnabled;
  if (se.todo_picker === enabled) return;
  const updated = db
    .update(globalConfig)
    .set({ stage_enabled: { ...se, todo_picker: enabled } })
    .where(eq(globalConfig.id, 1))
    .returning()
    .all();
  if (updated[0]) broadcast({ type: "config.changed", config: updated[0] });
}

export function listBlockers(status?: string): Blocker[] {
  const rows = db.select().from(blockers).orderBy(desc(blockers.created_at)).all();
  return status ? rows.filter((b) => b.status === status) : rows;
}

export function getBlocker(id: string): Blocker | undefined {
  return db.select().from(blockers).where(eq(blockers.id, id)).get();
}

/** Flag/unflag a task as paused on a block; claim() skips blocked tasks.
 *  Broadcasts task.updated so the board's blocked badge appears/clears live. */
export function setTaskBlocked(taskId: string, blocked: boolean): void {
  const updated = db
    .update(tasks)
    .set({ blocked, updated_at: now() })
    .where(eq(tasks.id, taskId))
    .returning()
    .all();
  if (updated[0]) broadcast({ type: "task.updated", task: updated[0] });
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
  /** Refresh an existing open row on (kind, task_id, stage). Off → always a new
   *  row (e.g. follow-ups: each surfaces distinct content worth keeping). */
  dedupe?: boolean;
}): Blocker {
  const open = b.dedupe === false ? undefined : listBlockers("open").find(
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
 * Stop the line for a human: file a persistent warning AND pause the global
 * todo-picker. For NEEDS_REVIEW landings that happen because the AI/pipeline
 * tapped out (a deferred escalation, a verify-brake) — not for a happy-path
 * deliverable awaiting approval. Resolving the blocker re-enables picking.
 */
export function pauseLineForHuman(opts: {
  taskId: string;
  stage?: string | null;
  summary: string;
  detail?: string;
}): void {
  addBlocker({
    kind: "escalation",
    task_id: opts.taskId,
    stage: opts.stage ?? null,
    summary: opts.summary,
    detail: opts.detail ?? "",
    dedupe: true,
  });
  setTodoPickerEnabled(false);
}

// Kinds that pause the global todo-picker when filed (follow-ups for scope
// review; interactive auth walls so the picker doesn't pull more same-MCP tasks
// into the same wall; escalations the pipeline couldn't resolve). Resolving any
// of them re-enables picking.
const PICKER_PAUSING_KINDS = new Set(["followup", "mcp_auth", "cli_login", "escalation"]);

/**
 * Resolve a blocker. On "resolved": re-enable the todo-picker for any kind that
 * paused it, and unblock its task so the next tick re-runs the paused stage.
 * "dismissed" clears the blocker without either (a dismiss leaves the picker
 * paused — a follow-up still needs review; an auth wall still isn't cleared).
 */
export function resolveBlocker(id: string, status: "resolved" | "dismissed" = "resolved"): Blocker | undefined {
  const b = getBlocker(id);
  if (!b) return undefined;
  db.update(blockers).set({ status, resolved_at: now() }).where(eq(blockers.id, id)).run();
  if (status === "resolved") {
    if (PICKER_PAUSING_KINDS.has(b.kind)) setTodoPickerEnabled(true);
    if (b.task_id) setTaskBlocked(b.task_id, false);
  }
  return getBlocker(id);
}

/**
 * Resolve every open blocker for a task. Called when a human moves a task out of
 * NEEDS_REVIEW (retry/redo/override/cancel) so the line doesn't stay paused
 * behind a stale brake blocker (verify-brake, deferred escalation) the human has
 * just acted on. No-op for happy-path reviews that filed no blocker.
 */
export function resolveTaskBlockers(taskId: string): void {
  for (const b of listBlockers("open")) {
    if (b.task_id === taskId) resolveBlocker(b.id, "resolved");
  }
}
