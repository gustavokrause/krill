import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { createWorktree, deleteLocalBranch, deleteRemoteBranch, closePr } from "@/git";
import { applyTransitionSideEffects } from "@/workflow/cleanup";
import { taskTransitionSchema } from "@/lib/api/validation";

const tmps: string[] = [];

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "krill-co-"));
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

async function prepCanceledTask(repo: string, slug: string) {
  const wtRoot = mkdtempSync(join(tmpdir(), "krill-cowt-"));
  tmps.push(wtRoot);
  const project = createProject({ slug, has_repo: true, folder_path: repo });
  const task = createTask(project, { name: "cancel me", status: "IMPLEMENTING", mode: "dev" });
  const branch = `${slug.toLowerCase()}-1-cancel-me`;
  const wt = await createWorktree({
    projectFolder: repo, worktreesRoot: wtRoot, projectSlug: slug,
    taskId: task.id, branch, defaultBranch: "main",
  });
  writeFileSync(join(wt, "work.txt"), "wip\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["commit", "-m", "wip"], { cwd: wt });
  db.update(tables.tasks).set({ worktree_path: wt, branch }).where(eq(tables.tasks.id, task.id)).run();
  return { project, task, branch };
}

const branchExists = (repo: string, branch: string) =>
  execFileSync("git", ["branch", "--list", branch], { cwd: repo, encoding: "utf8" }).trim() !== "";

beforeEach(() => cleanData());
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

// --- Schema tests (no git) ---

test("taskTransitionSchema accepts valid cancel_options", () => {
  const result = taskTransitionSchema.safeParse({
    to: "CANCELED",
    cancel_options: { close_pr: true, delete_branch: false },
  });
  assert.ok(result.success, "valid cancel_options accepted");
  assert.deepEqual(result.data!.cancel_options, { close_pr: true, delete_branch: false });
});

test("taskTransitionSchema accepts cancel_options with both true", () => {
  const result = taskTransitionSchema.safeParse({
    to: "CANCELED",
    cancel_options: { close_pr: true, delete_branch: true },
  });
  assert.ok(result.success);
  assert.deepEqual(result.data!.cancel_options, { close_pr: true, delete_branch: true });
});

test("taskTransitionSchema rejects cancel_options with missing fields", () => {
  const result = taskTransitionSchema.safeParse({
    to: "CANCELED",
    cancel_options: { close_pr: true },
  });
  assert.ok(!result.success, "partial cancel_options rejected");
});

test("taskTransitionSchema rejects cancel_options with non-boolean", () => {
  const result = taskTransitionSchema.safeParse({
    to: "CANCELED",
    cancel_options: { close_pr: "yes", delete_branch: false },
  });
  assert.ok(!result.success, "non-boolean close_pr rejected");
});

test("taskTransitionSchema allows cancel_options to be omitted (legacy path)", () => {
  const result = taskTransitionSchema.safeParse({ to: "CANCELED" });
  assert.ok(result.success);
  assert.equal(result.data!.cancel_options, undefined);
});

// --- Branch delete on cancel (git, no gh) ---

test("delete_branch=true deletes local branch after worktree removed", async () => {
  const repo = initRepo();
  const { task, branch } = await prepCanceledTask(repo, "CO");

  // Simulate what the route does: applyTransitionSideEffects first (removes worktree),
  // then delete the branch.
  await applyTransitionSideEffects(task.id, "IMPLEMENTING", "CANCELED");
  assert.ok(branchExists(repo, branch), "branch still exists after worktree removal");

  await deleteLocalBranch(repo, branch);
  assert.ok(!branchExists(repo, branch), "branch deleted after explicit delete call");
});

test("delete_branch=false keeps branch after cancel", async () => {
  const repo = initRepo();
  const { task, branch } = await prepCanceledTask(repo, "CP");

  await applyTransitionSideEffects(task.id, "IMPLEMENTING", "CANCELED");
  // No branch delete called — branch must remain.
  assert.ok(branchExists(repo, branch), "branch retained when delete_branch=false");
});

test("closePr is exported from @/git", () => {
  // Structural: ensure the function is importable (no gh available in CI).
  assert.equal(typeof closePr, "function", "closePr exported from @/git");
});
