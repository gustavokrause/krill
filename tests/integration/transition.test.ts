import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  cleanData,
  createProject,
  createTask,
  db,
  tables,
} from "../helpers/setup";
import {
  releaseClaim,
  transitionStatus,
  touchTask,
} from "@/workflow/transition";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

test("transitionStatus advances when the from-status matches", () => {
  const p = createProject({ slug: "TR" });
  const t = createTask(p, { name: "t1", status: "TODO" });
  const ok = transitionStatus({
    taskId: t.id,
    from: "TODO",
    to: "PLANNING",
  });
  assert.equal(ok, true);
  const row = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get();
  assert.equal(row!.status, "PLANNING");
  assert.equal(row!.claimed_until, null);
});

test("transitionStatus returns false when from-status no longer matches", () => {
  const p = createProject({ slug: "TR" });
  const t = createTask(p, { name: "t1", status: "TODO" });
  // First caller wins.
  assert.equal(
    transitionStatus({ taskId: t.id, from: "TODO", to: "PLANNING" }),
    true,
  );
  // Second caller (stale `from`) loses.
  assert.equal(
    transitionStatus({ taskId: t.id, from: "TODO", to: "IMPLEMENTING" }),
    false,
  );
  const row = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get();
  assert.equal(row!.status, "PLANNING");
});

test("transitionStatus optionally sets started_at + ended_at", () => {
  const p = createProject({ slug: "TR" });
  const t = createTask(p, { name: "t1", status: "TODO" });
  const startedAt = 12345;
  transitionStatus({
    taskId: t.id,
    from: "TODO",
    to: "PLANNING",
    startedAt,
  });
  const row1 = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get();
  assert.equal(row1!.started_at, startedAt);

  // Get to NEEDS_REVIEW(deliverable) via direct DB update so we can test ended_at.
  db.update(tables.tasks)
    .set({ status: "NEEDS_REVIEW", pending_review_kind: "deliverable" })
    .where(eq(tables.tasks.id, t.id))
    .run();
  const endedAt = 67890;
  transitionStatus({
    taskId: t.id,
    from: "NEEDS_REVIEW",
    to: "DONE",
    endedAt,
  });
  const row2 = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get();
  assert.equal(row2!.ended_at, endedAt);
  assert.equal(row2!.status, "DONE");
});

test("releaseClaim only clears when the worker matches", () => {
  const p = createProject({ slug: "TR" });
  const t = createTask(p, {
    name: "t1",
    status: "PLANNING",
    claimed_by: "w1",
    claimed_until: Math.floor(Date.now() / 1000) + 60,
  });

  assert.equal(releaseClaim(t.id, "other-worker"), false);
  let row = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get();
  assert.equal(row!.claimed_by, "w1");

  assert.equal(releaseClaim(t.id, "w1"), true);
  row = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get();
  assert.equal(row!.claimed_by, null);
  assert.equal(row!.claimed_until, null);
});

test("touchTask only bumps updated_at", () => {
  const p = createProject({ slug: "TR" });
  const t = createTask(p, {
    name: "t1",
    status: "PLANNING",
    updated_at: 1,
  });
  touchTask(t.id);
  const row = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get();
  assert.ok(row!.updated_at > 1);
  assert.equal(row!.status, "PLANNING");
});
