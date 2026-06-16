import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { createWorktree } from "@/git";
import { resolvePublishPolicy } from "@/workflow/publish-policy";
import { applyTransitionSideEffects } from "@/workflow/cleanup";

const tmps: string[] = [];

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "krill-bc-"));
  tmps.push(dir);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "base\n");
  g("add", "-A");
  g("commit", "-m", "init");
  return dir;
}

/** Stage a task with a committed branch in a fresh worktree, in PUBLISHING. */
async function prep(repo: string, slug: string, projectOpts = {}) {
  const wtRoot = mkdtempSync(join(tmpdir(), "krill-bcwt-"));
  tmps.push(wtRoot);
  const project = createProject({ slug, has_repo: true, folder_path: repo, ...projectOpts });
  const task = createTask(project, { name: "do thing", status: "PUBLISHING", mode: "non-dev" });
  const branch = `${slug.toLowerCase()}-1-do-thing`;
  const wt = await createWorktree({
    projectFolder: repo, worktreesRoot: wtRoot, projectSlug: slug,
    taskId: task.id, branch, defaultBranch: "main",
  });
  writeFileSync(join(wt, "feature.txt"), "work\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: wt });
  db.update(tables.tasks).set({ worktree_path: wt, branch }).where(eq(tables.tasks.id, task.id)).run();
  return { project, task, branch };
}

const branchExists = (repo: string, branch: string) =>
  execFileSync("git", ["branch", "--list", branch], { cwd: repo, encoding: "utf8" }).trim() !== "";

beforeEach(() => cleanData());
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

test("DONE deletes the task branch when merged (merge_to_main on) + toggle on", async () => {
  const repo = initRepo();
  const { task, branch } = await prep(repo, "BC");
  // remote-less repo → merge_to_main auto resolves true
  const policy = await resolvePublishPolicy((await db.select().from(tables.projects).where(eq(tables.projects.id, task.project_id)).get())!);
  assert.equal(policy.mergeToMain, true);

  await applyTransitionSideEffects(task.id, "PUBLISHING", "DONE");
  assert.ok(!branchExists(repo, branch), "branch deleted after merged DONE");
});

test("DONE keeps the branch when merge_to_main is off (work not merged)", async () => {
  const repo = initRepo();
  const { task, branch } = await prep(repo, "BD", { merge_to_main: false });

  await applyTransitionSideEffects(task.id, "PUBLISHING", "DONE");
  assert.ok(branchExists(repo, branch), "unmerged branch retained — not destroyed");
});

test("DONE keeps the branch when delete_branch_on_done is off", async () => {
  const repo = initRepo();
  const { task, branch } = await prep(repo, "BE", { delete_branch_on_done: false });

  await applyTransitionSideEffects(task.id, "PUBLISHING", "DONE");
  assert.ok(branchExists(repo, branch), "branch retained when cleanup toggled off");
});

test("per-task override beats project policy in resolvePublishPolicy", async () => {
  const repo = initRepo();
  const project = createProject({ slug: "OV", has_repo: true, folder_path: repo, create_pr: false, merge_to_main: false });
  const task = createTask(project, {
    name: "x", status: "PUBLISHING", mode: "non-dev",
    create_pr: true, push_remote: true, merge_to_main: true, draft_pr: true,
  });
  const p = await resolvePublishPolicy(project, task);
  assert.equal(p.createPr, true, "task create_pr override wins");
  assert.equal(p.mergeToMain, true, "task merge_to_main override wins");
  // draft is effective: task forces create_pr + push on → PR flow
  assert.equal(p.draftPr, true, "task draft_pr override wins (PR flow forced)");
  // a field the task leaves null inherits the project
  const p2 = await resolvePublishPolicy(project, createTask(project, { name: "y", status: "TODO", mode: "non-dev" }));
  assert.equal(p2.createPr, false, "null task field inherits project create_pr=off");
});
