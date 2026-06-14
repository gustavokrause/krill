import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { createWorktree } from "@/git";
import { autoFinishEligible } from "@/workflow/finish";
import { runPublishing } from "@/workflow/stages/publishing";

const tmps: string[] = [];
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "krill-af-"));
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

/** stage a committed change on a task branch in a fresh worktree */
async function prepTask(repo: string, slug: string) {
  const wtRoot = mkdtempSync(join(tmpdir(), "krill-afwt-"));
  tmps.push(wtRoot);
  const project = createProject({ slug, has_repo: true, folder_path: repo });
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
  return { project, task };
}

beforeEach(() => cleanData());
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

test("autoFinishEligible needs BOTH task.auto_publish and project.allow_auto_finish", () => {
  const base = { auto_publish: false } as any;
  assert.equal(autoFinishEligible({ auto_publish: false } as any, { allow_auto_finish: true } as any), false);
  assert.equal(autoFinishEligible({ auto_publish: true } as any, { allow_auto_finish: false } as any), false);
  assert.equal(autoFinishEligible({ auto_publish: true } as any, { allow_auto_finish: true } as any), true);
});

test("auto-finish: permitted + auto_publish → merges to main and goes DONE (no gate)", async () => {
  const repo = initRepo();
  const { project, task } = await prepTask(repo, "AF");
  db.update(tables.projects).set({ allow_auto_finish: true }).where(eq(tables.projects.id, project.id)).run();
  db.update(tables.tasks).set({ auto_publish: true }).where(eq(tables.tasks.id, task.id)).run();

  await runPublishing("worker-af");

  const t = db.select().from(tables.tasks).where(eq(tables.tasks.id, task.id)).get()!;
  assert.equal(t.status, "DONE", "auto-finished past the deliverable gate");
  assert.ok(existsSync(join(repo, "feature.txt")), "merged into main locally");
});

test("auto-finish gate: auto_publish but project NOT permitted → stops at deliverable", async () => {
  const repo = initRepo();
  const { task } = await prepTask(repo, "AG");
  // project.allow_auto_finish stays false (default)
  db.update(tables.tasks).set({ auto_publish: true }).where(eq(tables.tasks.id, task.id)).run();

  await runPublishing("worker-ag");

  const t = db.select().from(tables.tasks).where(eq(tables.tasks.id, task.id)).get()!;
  assert.equal(t.status, "NEEDS_REVIEW");
  assert.equal(t.pending_review_kind, "deliverable", "no project permission → human gate holds");
});
