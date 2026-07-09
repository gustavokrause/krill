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

// Cap for the persisted unified diff. Past this the tail is dropped with a
// marker so downstream stages know to fall back to `git diff` themselves.
export const DIFF_TEXT_MAX_CHARS = 150_000;
export const DIFF_TEXT_TRUNCATED_MARKER =
  "\n\n[diff truncated — run `git diff` in the worktree for the full text]";

/**
 * Full unified diff against base, persisted at IMPLEMENTING end so AI-REVIEW
 * and VERIFYING read it from task_context() instead of each re-deriving it
 * with their own fetch + git diff + file reads (tracker B1: the same diff was
 * re-tokenized 2-3× per task). Same base-pick rules as diffNamesAgainstBase.
 */
export async function diffTextAgainstBase(
  worktreePath: string,
  defaultBranch: string,
): Promise<string> {
  const git = simpleGit(worktreePath);
  const base = await pickBase(worktreePath, defaultBranch);
  const output = await git.raw(["diff", `${base}...HEAD`]);
  if (output.length <= DIFF_TEXT_MAX_CHARS) return output;
  return output.slice(0, DIFF_TEXT_MAX_CHARS) + DIFF_TEXT_TRUNCATED_MARKER;
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
