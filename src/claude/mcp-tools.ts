import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { posix as posixPath, relative } from "node:path";
import { db } from "@/db/client";
import {
  CONFLICTS_BLOCKING_STATUSES,
  comments,
  globalConfig,
  projects,
  tasks,
  type Comment,
  type Project,
  type Task,
} from "@/db/schema";
import { resolveProjectPath } from "@/lib/api/util";
import { broadcast } from "@/lib/sse";
import { transitionStatus } from "@/workflow/transition";
import { countAiAutoActions } from "@/workflow/loop-brake";
import { now, type Stage } from "@/workflow/types";
import { McpAuthError } from "./errors";
import type { McpAuthContext } from "./mcp-auth";

const STAGE_GATES: Record<string, Stage[]> = {
  task_set_plan: ["planning"],
  task_set_checklist: ["planning", "implementing"],
  task_set_affected_paths: ["planning", "implementing"],
  task_append_comment: [
    "todo_picker",
    "planning",
    "implementing",
    "ai_review",
    "publishing",
  ],
  task_decide: ["ai_review"],
  task_context: [
    "todo_picker",
    "planning",
    "implementing",
    "ai_review",
    "publishing",
  ],
};

function authorize(ctx: McpAuthContext, tool: keyof typeof STAGE_GATES): void {
  const allowed = STAGE_GATES[tool];
  if (!allowed.includes(ctx.stage)) {
    throw new McpAuthError(`tool ${tool} not allowed in stage ${ctx.stage}`);
  }
}

function loadTask(taskId: string): Task {
  const t = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!t) throw new McpAuthError(`task ${taskId} not found`);
  return t;
}

function loadProject(projectId: string): Project {
  const p = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!p) throw new McpAuthError(`project ${projectId} not found`);
  return p;
}

function loadComments(taskId: string): Comment[] {
  return db
    .select()
    .from(comments)
    .where(eq(comments.task_id, taskId))
    .orderBy(asc(comments.at))
    .all();
}

function loadPeersAffectedPaths(task: Task): Array<{
  task_id: string;
  affected_paths: string[];
}> {
  const peers = db
    .select({ id: tasks.id, affected_paths: tasks.affected_paths })
    .from(tasks)
    .where(
      and(
        eq(tasks.project_id, task.project_id),
        ne(tasks.id, task.id),
        inArray(tasks.status, CONFLICTS_BLOCKING_STATUSES),
      ),
    )
    .all();
  return peers.map((p) => ({
    task_id: p.id,
    affected_paths: p.affected_paths,
  }));
}

function normalizeAffectedPath(
  rawPath: string,
  projectFolder: string,
): string {
  const folder = resolveProjectPath(projectFolder);
  let p = rawPath;
  if (p.startsWith(folder)) p = relative(folder, p);
  p = posixPath.normalize(p.replaceAll("\\", "/"));
  if (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/")) p = p.slice(1);
  return p;
}

// -- Tools --

export function task_context(ctx: McpAuthContext) {
  authorize(ctx, "task_context");
  const task = loadTask(ctx.taskId);
  const project = loadProject(task.project_id);
  return {
    task: {
      id: task.id,
      name: task.name,
      description: task.description,
      status: task.status,
      mode: task.mode,
      priority: task.priority,
      plan: task.plan,
      checklist: task.checklist,
      affected_paths: task.affected_paths,
      depends_on: task.depends_on,
      conflicts_with: task.conflicts_with,
      branch: task.branch,
      worktree_path: task.worktree_path,
      workspace_path: task.workspace_path,
      skip_plan: task.skip_plan,
      skip_plan_review: task.skip_plan_review,
      skip_ai_review: task.skip_ai_review,
    },
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      folder_path: project.folder_path,
      has_repo: project.has_repo,
      default_branch: project.default_branch,
    },
    comments: loadComments(task.id),
    peers_affected_paths: loadPeersAffectedPaths(task),
  };
}

function emitTaskUpdated(taskId: string): void {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (task) broadcast({ type: "task.updated", task });
}

export function task_set_plan(ctx: McpAuthContext, plan: string) {
  authorize(ctx, "task_set_plan");
  db.update(tasks)
    .set({ plan, updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  emitTaskUpdated(ctx.taskId);
  return { ok: true };
}

export function task_set_checklist(ctx: McpAuthContext, checklist: string) {
  authorize(ctx, "task_set_checklist");
  db.update(tasks)
    .set({ checklist, updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  emitTaskUpdated(ctx.taskId);
  return { ok: true };
}

export function task_set_affected_paths(
  ctx: McpAuthContext,
  paths: string[],
) {
  authorize(ctx, "task_set_affected_paths");
  const task = loadTask(ctx.taskId);
  const project = loadProject(task.project_id);
  const normalized = paths.map((p) => normalizeAffectedPath(p, project.folder_path));
  db.update(tasks)
    .set({ affected_paths: normalized, updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  emitTaskUpdated(ctx.taskId);
  return { ok: true, affected_paths: normalized };
}

export function task_append_comment(
  ctx: McpAuthContext,
  stage: Task["status"],
  text: string,
) {
  authorize(ctx, "task_append_comment");
  const id = randomUUID();
  const inserted = db
    .insert(comments)
    .values({
      id,
      task_id: ctx.taskId,
      at: now(),
      stage,
      author: "ai",
      text,
    })
    .returning()
    .all();
  db.update(tasks)
    .set({ updated_at: now() })
    .where(eq(tasks.id, ctx.taskId))
    .run();
  if (inserted[0]) broadcast({ type: "comment.appended", comment: inserted[0] });
  emitTaskUpdated(ctx.taskId);
  return { ok: true, id };
}

export type DecisionOutcome = "approve" | "decline";

export function task_decide(
  ctx: McpAuthContext,
  outcome: DecisionOutcome,
  reason?: string,
) {
  authorize(ctx, "task_decide");
  const task = loadTask(ctx.taskId);

  if (task.status !== "AI-REVIEW") {
    throw new McpAuthError(
      `task_decide requires status AI-REVIEW, got ${task.status}`,
    );
  }

  if (outcome === "approve") {
    if (reason) {
      task_append_comment(ctx, "AI-REVIEW", `approve: ${reason}`);
    }
    const moved = transitionStatus({
      taskId: ctx.taskId,
      from: "AI-REVIEW",
      to: "PUBLISHING",
    });
    if (!moved) throw new McpAuthError("transition lost; retry");
    return { ok: true, status: "PUBLISHING" };
  }

  // decline path — append reason and check brake
  const text = reason ?? "decline";
  task_append_comment(ctx, "AI-REVIEW", text);

  const max = getMaxAiDeclineCycles();
  const count = countAiAutoActions(ctx.taskId);
  if (count >= max) {
    task_append_comment(
      ctx,
      "AI-REVIEW",
      "max AI decline cycles reached — deferring to human",
    );
    const forced = transitionStatus({
      taskId: ctx.taskId,
      from: "AI-REVIEW",
      to: "PUBLISHING",
    });
    if (!forced) throw new McpAuthError("forced transition lost; retry");
    return { ok: true, status: "PUBLISHING", forced: true };
  }

  const moved = transitionStatus({
    taskId: ctx.taskId,
    from: "AI-REVIEW",
    to: "IMPLEMENTING",
  });
  if (!moved) throw new McpAuthError("decline transition lost; retry");
  return { ok: true, status: "IMPLEMENTING" };
}

function getMaxAiDeclineCycles(): number {
  const row = db
    .select({ n: globalConfig.max_ai_decline_cycles })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  return row?.n ?? 3;
}
