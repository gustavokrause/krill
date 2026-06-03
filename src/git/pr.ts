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
};

/**
 * Idempotent PR open: if a PR already exists for the head branch, return
 * its URL. Otherwise `gh pr create` and return the new URL.
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
  const res = await execCmd("gh", args, { cwd: opts.cwd });
  throwIfFailed(res, "gh pr create");

  const created = await prForBranch(opts.cwd, opts.head);
  if (!created) {
    throw new Error("gh pr create succeeded but pr lookup returned empty");
  }
  return created;
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
    ["pr", "merge", prUrl, flag, "--delete-branch"],
    { cwd: repoCwd },
  );
  throwIfFailed(res, `gh pr merge ${strategy}`);
}
