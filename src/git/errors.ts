export class GitError extends Error {
  readonly code = "git";
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}

export class GhCliError extends Error {
  readonly code = "gh_cli";
  constructor(
    message: string,
    public stderr?: string,
    public exitCode?: number,
  ) {
    super(message);
  }
}

export class MergeConflictError extends Error {
  readonly code = "merge_conflict";
  constructor(
    message: string,
    public conflictedFiles: string[],
  ) {
    super(message);
  }
}
