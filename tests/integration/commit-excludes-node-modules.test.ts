import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll } from "@/git/branch";

let sandbox: string;
let deps: string;
let wt: string;

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "ai-commit-nm-"));
  // A "project node_modules" the worktree would symlink to (its absolute path is
  // exactly the kind of personal data we must never commit).
  deps = join(sandbox, "real_node_modules");
  mkdirSync(deps);
  writeFileSync(join(deps, "marker.txt"), "x\n");

  wt = join(sandbox, "wt");
  mkdirSync(wt);
  sh("git init --initial-branch=main .", wt);
  sh("git config user.email test@example.com", wt);
  sh("git config user.name Test", wt);
  sh("git config commit.gpgsign false", wt);
  // Deliberately the OLD dir-only pattern that MISSES the symlink — proves
  // commitAll's own guard excludes node_modules regardless of .gitignore.
  writeFileSync(join(wt, ".gitignore"), "node_modules/\n");
  writeFileSync(join(wt, "f.txt"), "base\n");
  sh("git add .gitignore f.txt", wt);
  sh("git commit -m base", wt);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test("commitAll commits real changes but never the node_modules symlink", async () => {
  // Reproduce the worktree: a node_modules symlink + a genuine source change.
  symlinkSync(deps, join(wt, "node_modules"), "dir");
  writeFileSync(join(wt, "feature.ts"), "export const x = 1;\n");

  const sha = await commitAll(wt, "feat: add feature");
  assert.ok(sha, "a commit was created for the real change");

  const tracked = sh("git ls-files", wt).split("\n").filter(Boolean);
  assert.ok(tracked.includes("feature.ts"), "the real change is committed");
  assert.ok(
    !tracked.some((p) => p === "node_modules" || p.startsWith("node_modules/")),
    "node_modules (symlink) is never committed",
  );
});

test("commitAll returns null when the only change is the node_modules symlink", async () => {
  symlinkSync(deps, join(wt, "node_modules"), "dir");
  const sha = await commitAll(wt, "noop");
  assert.equal(sha, null, "nothing to commit once node_modules is excluded");
});
