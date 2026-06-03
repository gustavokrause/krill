import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cleanData, createProject, createTask, db, tables } from "../helpers/setup";
import { eq } from "drizzle-orm";
import { claim } from "@/workflow/claim";
import { checkEligibility } from "@/workflow/eligibility";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

test("cyclic depends_on leaves every task ineligible; claim returns null", () => {
  const p = createProject({ slug: "CYC", max_parallel_tasks: 5 });
  const a = createTask(p, { name: "a", status: "TODO" });
  const b = createTask(p, { name: "b", status: "TODO" });

  db.update(tables.tasks)
    .set({ depends_on: [b.id] })
    .where(eq(tables.tasks.id, a.id))
    .run();
  db.update(tables.tasks)
    .set({ depends_on: [a.id] })
    .where(eq(tables.tasks.id, b.id))
    .run();

  const aRefreshed = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, a.id))
    .get()!;
  const bRefreshed = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, b.id))
    .get()!;

  assert.equal(checkEligibility(aRefreshed).reason, "deps_not_done");
  assert.equal(checkEligibility(bRefreshed).reason, "deps_not_done");

  for (let i = 0; i < 3; i++) {
    const picked = claim({
      stage: "todo_picker",
      workerId: `w${i}`,
      ttlSeconds: 60,
    });
    assert.equal(picked, null, `iteration ${i}: cyclic deps must never claim`);
  }
});

test("3-node cycle (A→B→C→A) keeps the picker starved", () => {
  const p = createProject({ slug: "CYC3", max_parallel_tasks: 5 });
  const a = createTask(p, { name: "a", status: "TODO" });
  const b = createTask(p, { name: "b", status: "TODO" });
  const c = createTask(p, { name: "c", status: "TODO" });

  db.update(tables.tasks).set({ depends_on: [b.id] }).where(eq(tables.tasks.id, a.id)).run();
  db.update(tables.tasks).set({ depends_on: [c.id] }).where(eq(tables.tasks.id, b.id)).run();
  db.update(tables.tasks).set({ depends_on: [a.id] }).where(eq(tables.tasks.id, c.id)).run();

  const picked = claim({ stage: "todo_picker", workerId: "w1", ttlSeconds: 60 });
  assert.equal(picked, null);
});

test("breaking the cycle by marking one node DONE releases the next", () => {
  const p = createProject({ slug: "CYCB", max_parallel_tasks: 5 });
  const a = createTask(p, { name: "a", status: "TODO" });
  const b = createTask(p, { name: "b", status: "TODO" });

  db.update(tables.tasks).set({ depends_on: [b.id] }).where(eq(tables.tasks.id, a.id)).run();
  db.update(tables.tasks).set({ depends_on: [a.id] }).where(eq(tables.tasks.id, b.id)).run();

  assert.equal(claim({ stage: "todo_picker", workerId: "w1", ttlSeconds: 60 }), null);

  db.update(tables.tasks)
    .set({ status: "DONE" })
    .where(eq(tables.tasks.id, a.id))
    .run();

  const picked = claim({ stage: "todo_picker", workerId: "w2", ttlSeconds: 60 });
  assert.ok(picked, "B should be claimable once A is DONE");
  assert.equal(picked!.id, b.id);
});
