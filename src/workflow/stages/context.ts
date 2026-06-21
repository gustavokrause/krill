import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  globalConfig,
  projects,
  tasks,
  type Project,
  type Task,
} from "@/db/schema";
import { createWorktree, generateBranchName } from "@/git";
import { resolveProjectPath } from "@/lib/api/util";
import { DEFAULT_CLAIM_TTL } from "@/db/defaults";
import { now, type Stage } from "../types";

export function getProject(projectId: string): Project {
  const p = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!p) throw new Error(`project ${projectId} not found`);
  return p;
}

export function getClaimTtl(stage: Stage): number {
  if (stage === "todo_picker") return 60;
  const cfg = db
    .select({ claim_ttl: globalConfig.claim_ttl })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  const m = cfg?.claim_ttl ?? DEFAULT_CLAIM_TTL;
  const key = stage as Exclude<Stage, "todo_picker">;
  return m[key] ?? 300;
}

/** Runner timeout: 30s less than claim TTL so the process is killed before
 *  the claim expires, preventing a second worker from claiming the same task
 *  mid-run. Floor of 30s guards against very short TTL configs. */
export function getRunnerTimeoutMs(ttl: number): number {
  return Math.max((ttl - 30) * 1000, 30_000);
}

export function loadPrompt(name: string): string {
  const path = resolve(process.cwd(), "src/claude/prompts", name);
  return readFileSync(path, "utf8");
}

export function pickPromptFor(
  stage: Exclude<Stage, "todo_picker" | "publishing">,
  task: Task,
): string {
  const mode = task.mode === "dev" ? "dev" : "non-dev";
  const map: Record<typeof stage, string> = {
    planning: `planning-${mode}.md`,
    implementing: `implementing-${mode}.md`,
    ai_review: `ai-review-${mode}.md`,
    verify: `verify-${mode}.md`,
  };
  return loadPrompt(map[stage]);
}

export function workspacePathFor(task: Task, project: Project): string {
  return resolve(
    resolveProjectPath(project.folder_path),
    ".tasks",
    task.id,
  );
}

export function getBaseUrl(): string {
  return process.env.APP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

function getWorktreesRoot(): string {
  const cfg = db
    .select({ worktrees_root: globalConfig.worktrees_root })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  return cfg?.worktrees_root ?? "~/.ai-worktrees/";
}

/**
 * Idempotent worktree (has_repo) or staging workspace (no repo) provision.
 * Called by PLANNING on first entry and by IMPLEMENTING when the task
 * arrives without setup (e.g. picker routed TODO → IMPLEMENTING because
 * `skip_plan=true`). Mutates `task` in place so the caller sees the new
 * branch / paths.
 */
export async function ensureWorkspace(
  task: Task,
  project: Project,
): Promise<void> {
  if (project.has_repo) {
    if (task.worktree_path) return;
    const branch =
      task.branch ?? generateBranchName(project.slug, task.id, task.name);
    const wt = await createWorktree({
      projectFolder: project.folder_path,
      worktreesRoot: getWorktreesRoot(),
      projectSlug: project.slug,
      taskId: task.id,
      branch,
      defaultBranch: project.default_branch,
    });
    db.update(tasks)
      .set({ branch, worktree_path: wt, updated_at: now() })
      .where(eq(tasks.id, task.id))
      .run();
    task.branch = branch;
    task.worktree_path = wt;
    return;
  }
  if (task.workspace_path) return;
  const workspace = workspacePathFor(task, project);
  mkdirSync(workspace, { recursive: true });
  db.update(tasks)
    .set({ workspace_path: workspace, updated_at: now() })
    .where(eq(tasks.id, task.id))
    .run();
  task.workspace_path = workspace;
}
