import { execCmd, throwIfFailed } from "./exec";

export type PrInfo = { url: string; number: number; state: string };

/**
 * Look up a PR by head branch. Returns null when no PR exists. Uses `gh
 * pr list --head <branch>` so the operation is keyed to the task branch
 * regardless of who opened the PR.
 */
export async function prForBranch(
  repoCwd: string,
  branch: string,
): Promise<PrInfo | null> {
  const res = await execCmd(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "url,number,state",
      "--limit",
      "1",
    ],
    { cwd: repoCwd },
  );
  if (res.exitCode !== 0) {
    throwIfFailed(res, "gh pr list");
  }
  const arr = JSON.parse(res.stdout || "[]") as PrInfo[];
  return arr[0] ?? null;
}

export type OpenPrOpts = {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
};

/**
 * Idempotent PR open: if a PR already exists for the head branch, return
 * its URL. Otherwise `gh pr create` and return the new URL. Pass draft to
 * open it as a draft (`gh pr create --draft`).
 */
export async function ensurePr(opts: OpenPrOpts): Promise<PrInfo> {
  const existing = await prForBranch(opts.cwd, opts.head);
  if (existing) return existing;

  const args = [
    "pr",
    "create",
    "--base",
    opts.base,
    "--head",
    opts.head,
    "--title",
    opts.title,
    "--body",
    opts.body,
  ];
  if (opts.draft) args.push("--draft");
  const res = await execCmd("gh", args, { cwd: opts.cwd });
  throwIfFailed(res, "gh pr create");

  const created = await prForBranch(opts.cwd, opts.head);
  if (!created) {
    throw new Error("gh pr create succeeded but pr lookup returned empty");
  }
  return created;
}

/**
 * Mark a draft PR ready for review (`gh pr ready`). Idempotent: a PR that's
 * already ready returns success. Used before merging a draft on Approve.
 */
export async function markPrReady(
  repoCwd: string,
  prUrl: string,
): Promise<void> {
  const res = await execCmd("gh", ["pr", "ready", prUrl], { cwd: repoCwd });
  if (res.exitCode === 0) return;
  if (res.stderr.toLowerCase().includes("already ready")) return;
  throwIfFailed(res, "gh pr ready");
}

export async function addPrComment(
  repoCwd: string,
  prUrl: string,
  body: string,
): Promise<void> {
  const res = await execCmd("gh", ["pr", "comment", prUrl, "--body", body], {
    cwd: repoCwd,
  });
  throwIfFailed(res, "gh pr comment");
}

export async function getPrState(
  repoCwd: string,
  prUrl: string,
): Promise<string | null> {
  const res = await execCmd(
    "gh",
    ["pr", "view", prUrl, "--json", "state", "--jq", ".state"],
    { cwd: repoCwd },
  );
  if (res.exitCode !== 0) return null;
  return res.stdout.trim() || null;
}

/**
 * Merge the PR. Defaults to squash for clean default-branch history; pass
 * "merge" to preserve full commit graph. Idempotent: if the PR is already
 * MERGED (e.g., merged manually on GitHub), short-circuits without error.
 *
 * Branch deletion is intentionally NOT bundled here. `gh pr merge
 * --delete-branch` fails when a worktree still references the branch
 * (worktree is cleaned up later in applyTransitionSideEffects). Branch
 * teardown lives in cleanup, sequenced after worktree removal.
 */
export async function mergePr(
  repoCwd: string,
  prUrl: string,
  strategy: "squash" | "merge" | "rebase" = "squash",
): Promise<void> {
  const state = await execCmd(
    "gh",
    ["pr", "view", prUrl, "--json", "state", "--jq", ".state"],
    { cwd: repoCwd },
  );
  if (state.exitCode === 0 && state.stdout.trim() === "MERGED") return;

  const flag = `--${strategy}`;
  const res = await execCmd(
    "gh",
    ["pr", "merge", prUrl, flag],
    { cwd: repoCwd },
  );
  throwIfFailed(res, `gh pr merge ${strategy}`);
}

/**
 * Close an open PR. Idempotent: silently OK when the PR is already closed or
 * merged. Branch deletion is intentionally NOT bundled here — the caller
 * controls that separately via deleteLocalBranch / deleteRemoteBranch.
 */
export async function closePr(repoCwd: string, prUrl: string): Promise<void> {
  const res = await execCmd("gh", ["pr", "close", prUrl], { cwd: repoCwd });
  if (res.exitCode === 0) return;
  const lower = res.stderr.toLowerCase();
  if (lower.includes("already closed") || lower.includes("pull request state") || lower.includes("not open")) return;
  throwIfFailed(res, "gh pr close");
}

/**
 * Delete the remote branch on origin. Idempotent: succeeds silently when
 * the branch is already gone (e.g., previous --delete-branch run, or a
 * human deleted it on GitHub). Use on DONE cleanup after the worktree is
 * removed and the local branch deleted.
 */
export async function deleteRemoteBranch(
  repoCwd: string,
  branch: string,
): Promise<void> {
  const res = await execCmd(
    "git",
    ["push", "origin", "--delete", branch],
    { cwd: repoCwd },
  );
  if (res.exitCode === 0) return;
  const stderr = res.stderr.toLowerCase();
  if (stderr.includes("remote ref does not exist") || stderr.includes("unable to delete")) {
    return;
  }
  throwIfFailed(res, "git push origin --delete");
}
