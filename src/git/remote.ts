import simpleGit from "simple-git";

/** True when the repo has an `origin` remote wired. Drives publish policy. */
export async function hasRemote(repoPath: string): Promise<boolean> {
  try {
    const remotes = await simpleGit(repoPath).getRemotes();
    return remotes.some((r) => r.name === "origin");
  } catch {
    return false;
  }
}
