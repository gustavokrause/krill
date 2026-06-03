import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { resolveProjectPath } from "@/lib/api/util";
import { GitError } from "./errors";
import { execCmd, throwIfFailed } from "./exec";

export type WorktreeOpts = {
  projectFolder: string;
  worktreesRoot: string;
  projectSlug: string;
  taskId: string;
  branch: string;
  defaultBranch: string;
};

export function worktreePathFor(
  worktreesRoot: string,
  projectSlug: string,
  taskId: string,
): string {
  return join(resolveProjectPath(worktreesRoot), projectSlug, taskId);
}

/**
 * Create a worktree at {worktrees_root}/{slug}/{id} based on a new branch
 * forked from origin/{default_branch}. Idempotent: if the worktree already
 * exists, returns its path.
 */
export async function createWorktree(opts: WorktreeOpts): Promise<string> {
  const repo = resolveProjectPath(opts.projectFolder);
  const wt = worktreePathFor(opts.worktreesRoot, opts.projectSlug, opts.taskId);

  if (existsSync(wt)) return wt;
  mkdirSync(dirname(wt), { recursive: true });

  const git: SimpleGit = simpleGit(repo);

  // Refresh remote refs so the new branch forks off latest origin.
  await git.fetch(["origin", opts.defaultBranch]);

  // Determine the base ref. Prefer origin/<default> when remote is wired,
  // otherwise fall back to the local default branch HEAD.
  const remotes = await git.getRemotes(true);
  const hasOrigin = remotes.some((r) => r.name === "origin");
  const base = hasOrigin
    ? `origin/${opts.defaultBranch}`
    : opts.defaultBranch;

  // Check whether the branch already exists locally. If so, attach the
  // worktree without -b (re-attach existing branch). Otherwise create it.
  const branches = await git.branchLocal();
  const branchExists = branches.all.includes(opts.branch);

  const args = branchExists
    ? ["worktree", "add", wt, opts.branch]
    : ["worktree", "add", "-b", opts.branch, wt, base];

  const res = await execCmd("git", args, { cwd: repo });
  throwIfFailed(res, "git worktree add");

  return wt;
}

/**
 * Destroy the worktree. Branch is retained for audit per OVERVIEW.md.
 * Force-remove handles dirty trees on cancel paths.
 */
export async function removeWorktree(opts: {
  projectFolder: string;
  worktreePath: string;
}): Promise<void> {
  const repo = resolveProjectPath(opts.projectFolder);
  if (!existsSync(opts.worktreePath)) return;
  const res = await execCmd(
    "git",
    ["worktree", "remove", "--force", opts.worktreePath],
    { cwd: repo },
  );
  if (res.exitCode !== 0) {
    // Worktree may already be unregistered; prune as a fallback.
    await execCmd("git", ["worktree", "prune"], { cwd: repo });
    if (existsSync(opts.worktreePath)) {
      throw new GitError(
        `worktree remove failed: ${res.stderr.trim().slice(0, 400)}`,
      );
    }
  }
}
