import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { createWorktree } from "@/git";
import { resolvePublishPolicy } from "@/workflow/publish-policy";
import { runPublishing } from "@/workflow/stages/publishing";

const tmps: string[] = [];

/** A repo with a real `origin` (bare remote) and one commit on main. */
function initRepoWithRemote(): string {
  const bare = mkdtempSync(join(tmpdir(), "krill-bare-"));
  tmps.push(bare);
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);

  const dir = mkdtempSync(join(tmpdir(), "krill-cproff-"));
  tmps.push(dir);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  g("remote", "add", "origin", bare);
  writeFileSync(join(dir, "README.md"), "base\n");
  g("add", "-A");
  g("commit", "-m", "init");
  g("push", "-u", "origin", "main");
  return dir;
}

beforeEach(() => cleanData());
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

test("create_pr=off override keeps push_remote on but drops the PR", async () => {
  const repo = initRepoWithRemote();
  const project = createProject({
    slug: "CPR",
    has_repo: true,
    folder_path: repo,
    create_pr: false,
  });
  const policy = await resolvePublishPolicy(project);
  assert.equal(policy.pushRemote, true, "remote present -> still push");
  assert.equal(policy.createPr, false, "override wins -> no PR");
});

test("publishing with create_pr=off pushes the branch, opens no PR, stops at review", async () => {
  const repo = initRepoWithRemote();
  const wtRoot = mkdtempSync(join(tmpdir(), "krill-cproff-wt-"));
  tmps.push(wtRoot);
  const project = createProject({
    slug: "CPR",
    has_repo: true,
    folder_path: repo,
    create_pr: false,
  });
  const task = createTask(project, {
    name: "do thing",
    status: "PUBLISHING",
    mode: "non-dev",
  });

  const branch = "cpr-1-do-thing";
  const wt = await createWorktree({
    projectFolder: repo,
    worktreesRoot: wtRoot,
    projectSlug: "CPR",
    taskId: task.id,
    branch,
    defaultBranch: "main",
  });
  writeFileSync(join(wt, "feature.txt"), "work\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: wt });
  db.update(tables.tasks)
    .set({ worktree_path: wt, branch })
    .where(eq(tables.tasks.id, task.id))
    .run();

  await runPublishing("worker-cpr");

  const t = db.select().from(tables.tasks).where(eq(tables.tasks.id, task.id)).get()!;
  assert.equal(t.status, "NEEDS_REVIEW", "stops for human review");
  assert.equal(t.pending_review_kind, "deliverable");
  assert.equal(t.delivery_url, `branch:${branch}`, "branch ref, not a PR url");

  // branch was actually pushed to origin (push_remote stayed on)
  const remoteRefs = execFileSync("git", ["ls-remote", "--heads", "origin"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.match(remoteRefs, new RegExp(`refs/heads/${branch}`), "branch on origin");

  // and the pointer comment is visible on the task
  const comment = db
    .select()
    .from(tables.comments)
    .where(eq(tables.comments.task_id, task.id))
    .all()
    .find((c) => /no PR \(create_pr off\)/.test(c.text));
  assert.ok(comment, "expected a 'no PR (create_pr off)' AI comment");
  assert.match(comment.text, new RegExp(branch));
});

test("auto-finish with create_pr=off merges directly to main and pushes origin", async () => {
  const repo = initRepoWithRemote();
  const wtRoot = mkdtempSync(join(tmpdir(), "krill-cproff-wt2-"));
  tmps.push(wtRoot);
  const project = createProject({
    slug: "CPA",
    has_repo: true,
    folder_path: repo,
    create_pr: false,
    allow_auto_finish: true,
  });
  const task = createTask(project, {
    name: "do thing",
    status: "PUBLISHING",
    mode: "non-dev",
  });
  db.update(tables.tasks)
    .set({ auto_publish: true })
    .where(eq(tables.tasks.id, task.id))
    .run();

  const branch = "cpa-1-do-thing";
  const wt = await createWorktree({
    projectFolder: repo,
    worktreesRoot: wtRoot,
    projectSlug: "CPA",
    taskId: task.id,
    branch,
    defaultBranch: "main",
  });
  writeFileSync(join(wt, "feature.txt"), "work\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: wt });
  db.update(tables.tasks)
    .set({ worktree_path: wt, branch })
    .where(eq(tables.tasks.id, task.id))
    .run();

  await runPublishing("worker-cpa");

  const t = db.select().from(tables.tasks).where(eq(tables.tasks.id, task.id)).get()!;
  assert.equal(t.status, "DONE", "auto-finished past the gate, no PR");
  // merged into the local main checkout
  assert.ok(existsSync(join(repo, "feature.txt")), "main has the merged file");
  // and main was pushed to origin (origin/main now carries the change)
  const remoteMain = execFileSync("git", ["ls-tree", "-r", "--name-only", "origin/main"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.match(remoteMain, /feature\.txt/, "origin/main has the merged file");

  const comment = db
    .select()
    .from(tables.comments)
    .where(eq(tables.comments.task_id, task.id))
    .all()
    .find((c) => /merged .* directly into/.test(c.text));
  assert.ok(comment, "expected an 'auto-finished — merged directly' comment");
});
