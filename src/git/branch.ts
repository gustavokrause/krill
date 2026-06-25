import simpleGit from "simple-git";

export function generateBranchName(
  projectSlug: string,
  taskId: string,
  taskName: string,
): string {
  const slug = projectSlug.toLowerCase();
  const num = taskId.replace(/^.*-/, "");
  const sluggedName = taskName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
  return `${slug}-${num}-${sluggedName}`;
}

/**
 * Push the branch to origin. Sets upstream on first push.
 */
export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.push(["-u", "origin", branch]);
}

/**
 * Delete the local branch (no remote prune). Use on DONE/cancel cleanup.
 */
export async function deleteLocalBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(repoPath);
  await git.branch(["-D", branch]);
}

/**
 * Commit all staged + unstaged changes in the worktree with the given
 * message. Returns the new HEAD sha, or null if nothing was committed.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
): Promise<string | null> {
  const git = simpleGit(worktreePath);
  await git.add(["-A"]);
  // Defense in depth: drop the worktree's node_modules symlink from the index
  // even if the target project's .gitignore doesn't cover it (a dir-only
  // `node_modules/` pattern misses the symlink provisionWorktreeDeps creates).
  // Staging it leaks the project's absolute path into the PR. Unstaging is a
  // no-op when nothing matched, so this never breaks a normal commit.
  try {
    await git.raw(["reset", "-q", "--", "node_modules"]);
  } catch {
    // No node_modules in the index — nothing to unstage.
  }
  const status = await git.status();
  if (status.staged.length === 0 && status.created.length === 0 && status.deleted.length === 0 && status.modified.length === 0 && status.renamed.length === 0) {
    return null;
  }
  const result = await git.commit(message);
  return result.commit || null;
}
