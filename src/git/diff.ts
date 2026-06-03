import simpleGit from "simple-git";

/**
 * `git diff --name-only origin/{defaultBranch}...HEAD` for affected_paths
 * refresh at IMPLEMENTING end. Always compares against the REMOTE ref so
 * we ignore local-mirror drift (the user's local <defaultBranch> may lag
 * origin between fetches and would pull unrelated upstream commits into
 * the diff).
 *
 * Fetches the remote ref first so the comparison is fresh.
 */
export async function diffNamesAgainstBase(
  worktreePath: string,
  defaultBranch: string,
): Promise<string[]> {
  const git = simpleGit(worktreePath);
  try {
    await git.fetch(["origin", defaultBranch]);
  } catch {
    // No origin or offline — fall back to the local ref below.
  }
  const base = await pickBase(worktreePath, defaultBranch);
  const output = await git.raw(["diff", "--name-only", `${base}...HEAD`]);
  return output
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function pickBase(
  worktreePath: string,
  defaultBranch: string,
): Promise<string> {
  const git = simpleGit(worktreePath);
  try {
    await git.revparse([`origin/${defaultBranch}`]);
    return `origin/${defaultBranch}`;
  } catch {
    return defaultBranch;
  }
}
