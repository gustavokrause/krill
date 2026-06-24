import { existsSync, mkdirSync, symlinkSync } from "node:fs";
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

  // Idempotent: a re-used worktree still gets deps provisioned (back-fills
  // worktrees created before provisioning existed).
  if (existsSync(wt)) {
    provisionWorktreeDeps(repo, wt);
    return wt;
  }
  mkdirSync(dirname(wt), { recursive: true });

  const git: SimpleGit = simpleGit(repo);

  // Determine the base ref. Prefer origin/<default> when remote is wired,
  // otherwise fall back to the local default branch HEAD (remote-less repos).
  const remotes = await git.getRemotes(true);
  const hasOrigin = remotes.some((r) => r.name === "origin");

  // Refresh remote refs so the new branch forks off latest origin — only when
  // a remote exists (a bare `git fetch origin` errors on remote-less repos).
  if (hasOrigin) {
    await git.fetch(["origin", opts.defaultBranch]);
  }

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

  provisionWorktreeDeps(repo, wt);
  return wt;
}

/**
 * Make a worktree runnable by the verify stage.
 *
 * OPTION 1 (current, cheap): symlink the project's existing `node_modules` into
 * the worktree instead of installing. Instant, ~zero extra disk. A git worktree
 * shares .git but NOT a working tree, so it has no deps of its own — without
 * this, verify's `npm run dev` / build can't resolve a single import.
 *
 * KNOWN LIMITATION: Turbopack refuses a `node_modules` that is a symlink
 * pointing outside the project root. So the verify run must boot the app via the
 * webpack dev server or `next build && next start` — NOT `next dev --turbopack`.
 * The verify prompt (prompts/verify-dev.md) tells the agent this.
 *
 * ── OPTION 3 (escalation seam) ──────────────────────────────────────────────
 * If symlinking proves insufficient — Turbopack-only projects, native/
 * postinstall deps, or per-task dependency drift — swap the symlink below for a
 * real per-worktree install (`npm ci` / `pnpm install`). That is fully isolated
 * and correct but slow (minutes) and disk-heavy per task, so we only pay it when
 * Option 1 starts failing often (currently rare). Keep this function the single
 * provisioning seam so that swap stays one place; consider making it a per-
 * project choice (a `worktree_setup` config) rather than a global default.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function provisionWorktreeDeps(repoPath: string, worktreePath: string): void {
  const src = join(repoPath, "node_modules");
  const dest = join(worktreePath, "node_modules");
  // Node projects only; never clobber an existing dir/symlink.
  if (!existsSync(src) || existsSync(dest)) return;
  try {
    symlinkSync(src, dest, "dir");
  } catch {
    // Non-fatal: the worktree is still usable for non-running stages. If verify
    // can't boot the app it reports a fail, which the verify loop-brake bounds —
    // it no longer hangs forever.
  }
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
