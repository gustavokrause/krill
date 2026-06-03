import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeOriginInto,
  commitMerge,
  abortMerge,
  detectConflictedFiles,
} from "@/git/merge";

let sandbox: string;
let bare: string;
let wt: string;

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function setupFixture(): void {
  sandbox = mkdtempSync(join(tmpdir(), "ai-merge-conflict-"));
  bare = join(sandbox, "bare.git");
  wt = join(sandbox, "wt");

  execSync(`git init --bare --initial-branch=main "${bare}"`, { stdio: "ignore" });
  execSync(`git clone "${bare}" "${wt}"`, { stdio: "ignore" });

  sh("git config user.email test@example.com", wt);
  sh("git config user.name Test", wt);
  sh("git config commit.gpgsign false", wt);

  writeFileSync(join(wt, "f.txt"), "base\n");
  sh("git add f.txt", wt);
  sh("git commit -m base", wt);
  sh("git push -u origin main", wt);
}

function makeConflictingDivergence(): void {
  // Create a feature branch with its own edit of f.txt.
  sh("git checkout -b feature", wt);
  writeFileSync(join(wt, "f.txt"), "feature edit\n");
  sh("git add f.txt", wt);
  sh("git commit -m feature-change", wt);
  sh("git push -u origin feature", wt);

  // Switch back to main, conflict on the same line, push.
  sh("git checkout main", wt);
  writeFileSync(join(wt, "f.txt"), "main edit\n");
  sh("git add f.txt", wt);
  sh("git commit -m main-change", wt);
  sh("git push origin main", wt);

  // Back to feature so the test runs mergeOriginInto from that side.
  sh("git checkout feature", wt);
  // Refresh origin refs so origin/main is up to date locally.
  sh("git fetch origin", wt);
}

function makeCleanDivergence(): void {
  // Feature edits a different file from main — no conflict expected.
  sh("git checkout -b feature", wt);
  writeFileSync(join(wt, "g.txt"), "feature only\n");
  sh("git add g.txt", wt);
  sh("git commit -m feature-only", wt);
  sh("git push -u origin feature", wt);

  sh("git checkout main", wt);
  writeFileSync(join(wt, "h.txt"), "main only\n");
  sh("git add h.txt", wt);
  sh("git commit -m main-only", wt);
  sh("git push origin main", wt);

  sh("git checkout feature", wt);
  sh("git fetch origin", wt);
}

beforeEach(() => {
  setupFixture();
});

afterEach(() => {
  if (sandbox && existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("mergeOriginInto returns ok=true on a clean merge", async () => {
  makeCleanDivergence();
  const result = await mergeOriginInto(wt, "main");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.sha && result.sha.length >= 7, "expected non-empty sha");
  }
});

test("mergeOriginInto returns ok=false + conflictedFiles on conflict", async () => {
  makeConflictingDivergence();
  const result = await mergeOriginInto(wt, "main");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.conflictedFiles, ["f.txt"]);
  }

  // Conflict markers should be present in f.txt for the simulated resolve.
  const contents = readFileSync(join(wt, "f.txt"), "utf8");
  assert.match(contents, /<<<<<<</);
  assert.match(contents, />>>>>>>/);
});

test("commitMerge succeeds when conflict markers are resolved", async () => {
  makeConflictingDivergence();
  const merge = await mergeOriginInto(wt, "main");
  assert.equal(merge.ok, false);

  // Simulated AI resolution: pick a merged line.
  writeFileSync(join(wt, "f.txt"), "resolved both\n");

  const sha = await commitMerge(wt, "merge origin/main into feature (resolved)");
  assert.ok(sha && sha.length >= 7, "expected sha from commitMerge");

  // No conflict markers remain.
  const remaining = await detectConflictedFiles(wt);
  assert.deepEqual(remaining, []);
});

test("detectConflictedFiles returns empty after a clean state", async () => {
  // After a clean merge, detectConflictedFiles must be empty. This anchors
  // the safety net used by commitMerge — if porcelain ever reports stale
  // conflict markers post-merge, the production safeguard would mis-fire.
  makeCleanDivergence();
  await mergeOriginInto(wt, "main");
  const remaining = await detectConflictedFiles(wt);
  assert.deepEqual(remaining, []);
});

test("abortMerge cleans the worktree after a failed merge", async () => {
  makeConflictingDivergence();
  const merge = await mergeOriginInto(wt, "main");
  assert.equal(merge.ok, false);

  await abortMerge(wt);

  const remaining = await detectConflictedFiles(wt);
  assert.deepEqual(remaining, [], "abort must clear conflict markers");
  const contents = readFileSync(join(wt, "f.txt"), "utf8");
  assert.equal(contents, "feature edit\n", "abort must restore pre-merge feature content");
});
