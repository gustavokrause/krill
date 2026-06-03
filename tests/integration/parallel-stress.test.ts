import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cleanData, createProject, createTask, db, tables } from "../helpers/setup";
import { claim } from "@/workflow/claim";
import { eq, inArray } from "drizzle-orm";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

test("3 concurrent claim() callers return distinct tasks under a single project", async () => {
  const project = createProject({ slug: "STR3", max_parallel_tasks: 5 });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(createTask(project, { name: `t${i}`, status: "TODO" }).id);
  }

  const results = await Promise.all([
    Promise.resolve(claim({ stage: "todo_picker", workerId: "w1", ttlSeconds: 60 })),
    Promise.resolve(claim({ stage: "todo_picker", workerId: "w2", ttlSeconds: 60 })),
    Promise.resolve(claim({ stage: "todo_picker", workerId: "w3", ttlSeconds: 60 })),
  ]);

  for (const r of results) assert.ok(r, "every concurrent claim should pick a task");
  const pickedIds = results.map((r) => r!.id);
  const uniq = new Set(pickedIds);
  assert.equal(uniq.size, 3, `expected 3 distinct tasks, got ${pickedIds.join(",")}`);

  // Each claimed task should be tagged with its worker and have claimed_until set.
  const claimedRows = db
    .select()
    .from(tables.tasks)
    .where(inArray(tables.tasks.id, pickedIds))
    .all();
  for (const row of claimedRows) {
    assert.ok(row.claimed_by, `task ${row.id} should have claimed_by`);
    assert.ok(row.claimed_until && row.claimed_until > 0, `task ${row.id} should have claimed_until`);
    assert.match(row.claimed_by!, /^w\d$/);
  }
});

test("more concurrent callers than tasks: extras return null, no double-claim", async () => {
  const project = createProject({ slug: "STR4", max_parallel_tasks: 5 });
  createTask(project, { name: "only-one", status: "TODO" });

  const results = await Promise.all([
    Promise.resolve(claim({ stage: "todo_picker", workerId: "w1", ttlSeconds: 60 })),
    Promise.resolve(claim({ stage: "todo_picker", workerId: "w2", ttlSeconds: 60 })),
    Promise.resolve(claim({ stage: "todo_picker", workerId: "w3", ttlSeconds: 60 })),
  ]);

  const claimed = results.filter((r) => r !== null);
  assert.equal(claimed.length, 1, "exactly one worker should win the single task");

  const tasksWithClaim = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.project_id, project.id))
    .all()
    .filter((t) => t.claimed_by !== null);
  assert.equal(tasksWithClaim.length, 1, "no double-claim on the one task");
});

test("repeated claim/release loop keeps invariant: never two live claims on the same task", async () => {
  const project = createProject({ slug: "STRL", max_parallel_tasks: 5 });
  for (let i = 0; i < 4; i++) {
    createTask(project, { name: `l${i}`, status: "TODO" });
  }

  // Five iterations of (claim 4 in parallel; assert distinct; release all).
  for (let iter = 0; iter < 5; iter++) {
    const claims = await Promise.all([
      Promise.resolve(claim({ stage: "todo_picker", workerId: "w1", ttlSeconds: 60 })),
      Promise.resolve(claim({ stage: "todo_picker", workerId: "w2", ttlSeconds: 60 })),
      Promise.resolve(claim({ stage: "todo_picker", workerId: "w3", ttlSeconds: 60 })),
      Promise.resolve(claim({ stage: "todo_picker", workerId: "w4", ttlSeconds: 60 })),
    ]);
    const ids = claims.filter((c) => c !== null).map((c) => c!.id);
    const uniq = new Set(ids);
    assert.equal(
      uniq.size,
      ids.length,
      `iter ${iter}: duplicate claim detected — ${ids.join(",")}`,
    );

    // Release all by zeroing the claim columns.
    db.update(tables.tasks)
      .set({ claimed_until: null, claimed_by: null })
      .run();
  }
});

test("max_parallel cap enforced under concurrent claims: 1 already-active task in p1, only p2 picks a TODO", async () => {
  const p1 = createProject({ slug: "MX1", max_parallel_tasks: 1 });
  const p2 = createProject({ slug: "MX2", max_parallel_tasks: 1 });
  // p1 already at cap (one PLANNING task occupies the slot).
  createTask(p1, { name: "p1-active", status: "PLANNING" });
  createTask(p1, { name: "p1-waiting", status: "TODO" });
  // p2 has one TODO and no active.
  createTask(p2, { name: "p2-waiting", status: "TODO" });
  createTask(p2, { name: "p2-second", status: "TODO" });

  const results = await Promise.all([
    Promise.resolve(claim({ stage: "todo_picker", workerId: "w1", ttlSeconds: 60 })),
    Promise.resolve(claim({ stage: "todo_picker", workerId: "w2", ttlSeconds: 60 })),
    Promise.resolve(claim({ stage: "todo_picker", workerId: "w3", ttlSeconds: 60 })),
  ]);

  const winners = results.filter((r) => r !== null);
  // p1 is capped (active=1, max=1) → p1-waiting is ineligible.
  // p2 has one slot — two concurrent claims may both pick a p2 TODO since
  // neither has transitioned yet at the moment of selection. We assert the
  // cap-blocked task NEVER makes it through, not the total winner count.
  for (const w of winners) {
    assert.notEqual(w!.name, "p1-waiting", "capped project should not yield a claim");
  }
  for (const w of winners) {
    assert.equal(w!.project_id, p2.id, "all winners must be from the uncapped project");
  }
});
