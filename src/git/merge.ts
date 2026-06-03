import simpleGit from "simple-git";
import { MergeConflictError } from "./errors";
import { execCmd } from "./exec";

/**
 * `git fetch origin <branch>` on the worktree.
 */
export async function fetchOriginBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.fetch(["origin", branch]);
}

/**
 * Idempotent pre-merge sync: `git fetch origin && git reset --hard
 * origin/<taskBranch>`. Used by the PUBLISHING tick and the manual
 * resolve-conflict endpoint so retries pick up any human-side resolution
 * pushed to GitHub. No-op when the worktree is already in sync.
 */
export async function resetWorktreeToOriginBranch(
  worktreePath: string,
  taskBranch: string,
): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.fetch(["origin"]);
  await execCmd("git", ["reset", "--hard", `origin/${taskBranch}`], {
    cwd: worktreePath,
  });
}

export type MergeResult =
  | { ok: true; sha: string | null }
  | { ok: false; conflictedFiles: string[] };

/**
 * Merge origin/<defaultBranch> INTO the current task branch (merge-into,
 * never rebase). Returns conflict file list on failure so caller can
 * route to AI conflict resolution.
 */
export async function mergeOriginInto(
  worktreePath: string,
  defaultBranch: string,
): Promise<MergeResult> {
  const ref = `origin/${defaultBranch}`;
  const res = await execCmd("git", ["merge", "--no-ff", "--no-edit", ref], {
    cwd: worktreePath,
  });
  if (res.exitCode === 0) {
    const git = simpleGit(worktreePath);
    const sha = (await git.revparse(["HEAD"])).trim();
    return { ok: true, sha };
  }
  const conflictedFiles = await detectConflictedFiles(worktreePath);
  return { ok: false, conflictedFiles };
}

export async function detectConflictedFiles(
  worktreePath: string,
): Promise<string[]> {
  const res = await execCmd("git", ["status", "--porcelain"], {
    cwd: worktreePath,
  });
  const out: string[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    if (
      xy === "UU" ||
      xy === "AA" ||
      xy === "DD" ||
      xy[0] === "U" ||
      xy[1] === "U"
    ) {
      out.push(line.slice(3).trim());
    }
  }
  return out;
}

/**
 * Abort an in-progress merge. Use when AI resolution fails and we need to
 * leave the worktree in a clean state for the next retry.
 */
export async function abortMerge(worktreePath: string): Promise<void> {
  await execCmd("git", ["merge", "--abort"], { cwd: worktreePath });
}

/**
 * Stage + commit a finished merge after AI resolution.
 *
 * The post-`git add -A` `detectConflictedFiles` check is a safety net, NOT a
 * guarantee: `git add -A` collapses plain content conflicts (UU) into `M`,
 * so a file left with `<<<<<<<` markers will silently pass through and
 * commit. Only conflict types that survive staging (e.g. delete/modify in
 * some configurations) trigger the throw. Callers must trust AI resolution
 * upstream — this is belt, not braces.
 */
export async function commitMerge(
  worktreePath: string,
  message: string,
): Promise<string | null> {
  await execCmd("git", ["add", "-A"], { cwd: worktreePath });
  const stillConflicted = await detectConflictedFiles(worktreePath);
  if (stillConflicted.length > 0) {
    throw new MergeConflictError(
      `unresolved markers in ${stillConflicted.length} files`,
      stillConflicted,
    );
  }
  const res = await execCmd("git", ["commit", "--no-edit", "-m", message], {
    cwd: worktreePath,
  });
  if (res.exitCode !== 0) return null;
  const sha = await execCmd("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
  });
  return sha.stdout.trim() || null;
}

/**
 * Push the merge commit upstream.
 */
export async function pushMerge(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.push(["origin", branch]);
}
