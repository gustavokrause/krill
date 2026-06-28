import { existsSync } from "node:fs";
import type { Project, Task } from "@/db/schema";
import { resolveProjectPath } from "@/lib/api/util";
import { addBlocker, setTaskBlocked } from "./blockers";
import { appendAiComment } from "./comment";
import { releaseClaim } from "./transition";

/**
 * Guard against a vanished repo. When a project has `has_repo` on but its
 * `folder_path` is gone (moved, renamed, or deleted out from under krill),
 * every git step in the stage throws. The generic tick catch can't release a
 * claim it has no taskId for, so the task freezes for the full claim TTL, then
 * re-claims and throws again next tick — an infinite stuck loop with no signal.
 *
 * Detect it before doing any work. Park the task as BLOCKED (claim() skips
 * blocked rows), file a surfaced blocker, drop an on-card comment, and release
 * the claim. Status is untouched — restoring the repo and resolving the blocker
 * unblocks the task (blockers.resolveBlocker → setTaskBlocked(false)) and the
 * next tick re-runs the same stage.
 *
 * Returns true when the repo is missing (the caller must stop and return the
 * task id). False when the repo is reachable (or the project is repo-less).
 */
export function repoMissingBlock(opts: {
  task: Task;
  project: Project;
  stage: string;
  workerId: string;
}): boolean {
  const { task, project, stage, workerId } = opts;
  if (!project.has_repo) return false;

  const repoPath = resolveProjectPath(project.folder_path);
  if (existsSync(repoPath)) return false;

  setTaskBlocked(task.id, true);
  releaseClaim(task.id, workerId);
  addBlocker({
    kind: "repo_missing",
    task_id: task.id,
    stage,
    summary: `Project repo missing: ${repoPath}`,
    detail:
      `Project "${project.name}" has has_repo on, but ${repoPath} doesn't ` +
      `exist (moved, renamed, or deleted). Every git step in ${stage} fails ` +
      `here. Restore the repo to that path, then resolve this blocker to ` +
      `re-run the stage.`,
    dedupe: true,
  });
  appendAiComment(
    task.id,
    `Paused — project repo missing at ${repoPath}. Restore it (clone or move ` +
      `it back), then clear the blocker to re-run ${stage}.`,
    task.status,
  );
  return true;
}
