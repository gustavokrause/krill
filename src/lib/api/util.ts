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
