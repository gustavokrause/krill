import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export function resolveProjectPath(p: string): string {
  return resolve(expandHome(p));
}

export function detectHasRepo(folderPath: string): boolean {
  const abs = resolveProjectPath(folderPath);
  const gitPath = join(abs, ".git");
  try {
    if (!existsSync(gitPath)) return false;
    const st = statSync(gitPath);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * Read the repo's default branch: origin's HEAD if set, else the current
 * branch. Returns null for non-repos or when it can't be determined (caller
 * falls back to "main").
 */
export function detectDefaultBranch(folderPath: string): string | null {
  if (!detectHasRepo(folderPath)) return null;
  const abs = resolveProjectPath(folderPath);
  const tryGit = (args: string[]): string | null => {
    try {
      const out = execFileSync("git", args, {
        cwd: abs,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  };
  const originHead = tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead.replace(/^origin\//, "");
  const current = tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current && current !== "HEAD") return current;
  return null;
}
