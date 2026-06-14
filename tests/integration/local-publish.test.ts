import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { createWorktree, localMergeToMain } from "@/git";
import { resolvePublishPolicy } from "@/workflow/publish-policy";
import { runPublishing } from "@/workflow/stages/publishing";

const tmps: string[] = [];

/** A real git repo with no remote and one commit on main. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "krill-localrepo-"));
  tmps.push(dir);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  g("init", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "base\n");
  g("add", "-A");
  g("commit", "-m", "init");
  return dir;
}

beforeEach(() => cleanData());
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

test("remote-less project auto-resolves to the local publish policy", async () => {
  const repo = initRepo();
  const project = createProject({ slug: "LOC", has_repo: true, folder_path: repo });
  const policy = await resolvePublishPolicy(project);
  assert.equal(policy.pushRemote, false, "no remote -> no push");
  assert.equal(policy.createPr, false, "no remote -> no PR");
  assert.equal(policy.mergeToMain, true, "merge-to-main on by default");
});

test("createWorktree works on a remote-less repo (no bare fetch origin)", async () => {
  const repo = initRepo();
  const wtRoot = mkdtempSync(join(tmpdir(), "krill-wt-"));
  tmps.push(wtRoot);
  const wt = await createWorktree({
    projectFolder: repo,
    worktreesRoot: wtRoot,
    projectSlug: "LOC",
    taskId: "LOC-1",
    branch: "loc-1-x",
    defaultBranch: "main",
  });
  assert.ok(existsSync(wt), "worktree created without a remote");
});

test("publishing a remote-less task lands at the deliverable gate (local:)", async () => {
  const repo = initRepo();
  const wtRoot = mkdtempSync(join(tmpdir(), "krill-wt-"));
  tmps.push(wtRoot);
  const project = createProject({ slug: "LOC", has_repo: true, folder_path: repo });
  const task = createTask(project, { name: "do thing", status: "PUBLISHING", mode: "non-dev" });

  const branch = "loc-1-do-thing";
  const wt = await createWorktree({
    projectFolder: repo, worktreesRoot: wtRoot, projectSlug: "LOC",
    taskId: task.id, branch, defaultBranch: "main",
  });
  // simulate IMPLEMENTING output: a committed change on the task branch
  writeFileSync(join(wt, "feature.txt"), "work\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: wt });
  db.update(tables.tasks).set({ worktree_path: wt, branch }).where(eq(tables.tasks.id, task.id)).run();

  await runPublishing("worker-1");

  const t = db.select().from(tables.tasks).where(eq(tables.tasks.id, task.id)).get()!;
  assert.equal(t.status, "NEEDS_REVIEW");
  assert.equal(t.pending_review_kind, "deliverable");
  assert.match(t.delivery_url ?? "", /^local:/);
});

test("localMergeToMain merges the branch into main", async () => {
  const repo = initRepo();
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  g("checkout", "-b", "feat");
  writeFileSync(join(repo, "feature.txt"), "x\n");
  g("add", "-A");
  g("commit", "-m", "feat work");
  g("checkout", "main");
  assert.ok(!existsSync(join(repo, "feature.txt")), "main lacks the file pre-merge");

  await localMergeToMain(repo, "feat", "main");

  assert.ok(existsSync(join(repo, "feature.txt")), "main has the merged file");
});

test("localMergeToMain refuses a dirty working tree", async () => {
  const repo = initRepo();
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  g("checkout", "-b", "feat");
  writeFileSync(join(repo, "feature.txt"), "x\n");
  g("add", "-A");
  g("commit", "-m", "feat");
  g("checkout", "main");
  writeFileSync(join(repo, "dirty.txt"), "uncommitted\n"); // untracked => not clean

  await assert.rejects(() => localMergeToMain(repo, "feat", "main"), /not clean/);
});
