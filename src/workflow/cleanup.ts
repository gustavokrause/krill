import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects, tasks, type Task } from "@/db/schema";
import { WORKTREE_RETAINED_STATUSES, type TaskStatus } from "@/db/schema";
import { deleteLocalBranch, deleteRemoteBranch, removeWorktree } from "@/git";
import { now } from "./types";

const WORKTREE_RETAINED = new Set<TaskStatus>(WORKTREE_RETAINED_STATUSES);

export function isWorktreeRetained(status: TaskStatus): boolean {
  return WORKTREE_RETAINED.has(status);
}

/**
 * Side effects to run after a successful transitionStatus(). Destroys
 * worktree / workspace when the task leaves an active state, per
 * OVERVIEW.md lifecycle rules.
 */
export async function applyTransitionSideEffects(
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
): Promise<void> {
  const wasRetained = isWorktreeRetained(from);
  const nowRetained = isWorktreeRetained(to);
  if (!wasRetained || nowRetained) return;

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return;
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, task.project_id))
    .get();
  if (!project) return;

  if (project.has_repo && task.worktree_path) {
    let worktreeRemoved = false;
    try {
      await removeWorktree({
        projectFolder: project.folder_path,
        worktreePath: task.worktree_path,
      });
      worktreeRemoved = true;
    } catch (err) {
      console.warn(`worktree cleanup failed for ${task.id}:`, err);
    }
    db.update(tasks)
      .set({ worktree_path: null, updated_at: now() })
      .where(eq(tasks.id, task.id))
      .run();

    // Branch teardown is DONE-only per OVERVIEW.md: CANCELED and
    // decline-back-to-BACKLOG retain the branch for audit / reuse. Must
    // happen AFTER worktree removal (the worktree references the branch)
    // and is non-fatal — a teardown hiccup never blocks the transition.
    // After a squash merge the local branch isn't an ancestor of main, so
    // -D (deleteLocalBranch) is required; -d would fail "not fully merged".
    if (to === "DONE" && worktreeRemoved && task.branch) {
      try {
        await deleteLocalBranch(project.folder_path, task.branch);
      } catch (err) {
        console.warn(`local branch delete failed for ${task.id}:`, err);
      }
      try {
        await deleteRemoteBranch(project.folder_path, task.branch);
      } catch (err) {
        console.warn(`remote branch delete failed for ${task.id}:`, err);
      }
    }
  }

  // For non-repo projects, PUBLISHING already moves + cleans the workspace.
  // For any other active→non-active exit (cancel, back-to-backlog) destroy
  // the staging dir if it still exists.
  if (
    !project.has_repo &&
    task.workspace_path &&
    !(to === "NEEDS_REVIEW" && from === "PUBLISHING")
  ) {
    try {
      rmSync(task.workspace_path, { recursive: true, force: true });
    } catch (err) {
      console.warn(`workspace cleanup failed for ${task.id}:`, err);
    }
    db.update(tasks)
      .set({ workspace_path: null, updated_at: now() })
      .where(eq(tasks.id, task.id))
      .run();
  }
}

export function clearAffectedTask(_: Task): void {
  // Reserved hook — phase 09 will broadcast SSE events here.
}
