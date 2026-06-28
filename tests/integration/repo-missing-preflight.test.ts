import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { cleanData, createProject, createTask, db, tables } from "../helpers/setup";
import { runImplementing } from "@/workflow/stages/implementing";
import { runPublishing } from "@/workflow/stages/publishing";
import { listBlockers } from "@/workflow/blockers";

beforeEach(cleanData);

// Regression: a project with has_repo on whose folder vanished (moved/deleted)
// used to freeze the task — git ops threw, the generic tick catch couldn't
// release a claim it had no taskId for, so the claim sat held for the full TTL
// and the task re-claimed + re-threw every tick. The preflight guard now blocks
// the task instead (claim() skips blocked rows) with a surfaced blocker.
const MISSING = "/tmp/krill-test-no-such-repo-do-not-create";

test("IMPLEMENTING on a vanished repo blocks the task instead of looping", async () => {
  const project = createProject({
    slug: "RM",
    has_repo: true,
    folder_path: MISSING,
  });
  const task = createTask(project, {
    name: "x",
    status: "IMPLEMENTING",
    branch: "rm-1",
    worktree_path: `${MISSING}/wt`,
  });

  // Handled (parked) — does NOT throw.
  const result = await runImplementing("worker-test");
  assert.equal(result, task.id);

  const after = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get();
  assert.equal(after?.status, "IMPLEMENTING"); // status untouched
  assert.ok(after?.blocked); // parked as blocked
  assert.equal(after?.claimed_by, null); // claim released

  const open = listBlockers("open").filter((b) => b.task_id === task.id);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, "repo_missing");

  // No loop: a blocked task is not re-claimed, so the next tick is a no-op.
  const again = await runImplementing("worker-test");
  assert.equal(again, null);
});

test("PUBLISHING on a vanished repo blocks the task too", async () => {
  const project = createProject({
    slug: "RP",
    has_repo: true,
    folder_path: MISSING,
  });
  const task = createTask(project, {
    name: "y",
    status: "PUBLISHING",
    branch: "rp-1",
    worktree_path: `${MISSING}/wt`,
  });

  const result = await runPublishing("worker-test");
  assert.equal(result, task.id);

  const after = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get();
  assert.ok(after?.blocked);
  assert.equal(after?.claimed_by, null);

  const open = listBlockers("open").filter((b) => b.task_id === task.id);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, "repo_missing");
});
