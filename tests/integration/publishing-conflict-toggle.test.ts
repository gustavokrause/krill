import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  cleanData,
  createProject,
  createTask,
  db,
  tables,
} from "../helpers/setup";
import { routeConflictResolverDisabled } from "@/workflow/stages/publishing";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

function setSolveConflicts(value: boolean): void {
  db.update(tables.globalConfig)
    .set({ publishing_solve_conflicts: value })
    .where(eq(tables.globalConfig.id, 1))
    .run();
}

test("publishing_solve_conflicts defaults to false", () => {
  const cfg = db
    .select()
    .from(tables.globalConfig)
    .where(eq(tables.globalConfig.id, 1))
    .get()!;
  assert.equal(cfg.publishing_solve_conflicts, false);
});

test("solve_conflicts toggle persists via direct DB write", () => {
  setSolveConflicts(false);
  const off = db
    .select()
    .from(tables.globalConfig)
    .where(eq(tables.globalConfig.id, 1))
    .get()!;
  assert.equal(off.publishing_solve_conflicts, false);

  setSolveConflicts(true);
  const on = db
    .select()
    .from(tables.globalConfig)
    .where(eq(tables.globalConfig.id, 1))
    .get()!;
  assert.equal(on.publishing_solve_conflicts, true);
});

test(
  "routeConflictResolverDisabled moves task PUBLISHING → NEEDS_REVIEW(conflict) + appends comment",
  async () => {
    setSolveConflicts(false);
    const sandbox = mkdtempSync(join(tmpdir(), "ai-conflict-"));
    const project = createProject({
      slug: "CF",
      has_repo: true,
      folder_path: sandbox,
    });
    const task = createTask(project, {
      name: "force conflict",
      status: "PUBLISHING",
      mode: "dev",
      branch: "cf-1-force-conflict",
      worktree_path: join(sandbox, "fake-worktree"),
      delivery_url: "https://example.com/pr/1",
    });

    await routeConflictResolverDisabled({
      taskId: task.id,
      workerId: "worker-conflict",
      worktreePath: task.worktree_path!,
      conflictedSummary: "foo.txt, bar.ts",
    });

    const after = db
      .select()
      .from(tables.tasks)
      .where(eq(tables.tasks.id, task.id))
      .get()!;
    assert.equal(after.status, "NEEDS_REVIEW");
    assert.equal(after.pending_review_kind, "conflict");

    const taskComments = db
      .select()
      .from(tables.comments)
      .where(eq(tables.comments.task_id, task.id))
      .all();
    const disabledComment = taskComments.find(
      (c) =>
        c.author === "ai" &&
        c.stage === "NEEDS_REVIEW" &&
        /conflict resolver disabled/.test(c.text),
    );
    assert.ok(
      disabledComment,
      `expected a NEEDS_REVIEW-stage AI comment with "conflict resolver disabled"; got: ${JSON.stringify(taskComments.map((c) => c.text))}`,
    );
    assert.match(disabledComment.text, /foo\.txt, bar\.ts/);
  },
);
