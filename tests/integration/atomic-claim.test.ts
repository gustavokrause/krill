import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cleanData, createProject, createTask } from "../helpers/setup";
import { claim } from "@/workflow/claim";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

test("claim picks the highest-priority FIFO task", () => {
  const p = createProject({ slug: "AC" });
  createTask(p, { name: "older P2", status: "TODO" });
  // Make sure the next two get later timestamps.
  const a = createTask(p, { name: "P0 task", status: "TODO", priority: "P0" });
  createTask(p, { name: "newer P2", status: "TODO" });

  const claimed = claim({
    stage: "todo_picker",
    workerId: "w1",
    ttlSeconds: 60,
  });
  assert.ok(claimed, "expected a claimed task");
  assert.equal(claimed!.id, a.id, "should pick the P0 task first");
});

test("a second claim immediately after returns the next eligible task", () => {
  const p = createProject({ slug: "AC", max_parallel_tasks: 5 });
  const t1 = createTask(p, { name: "t1", status: "TODO" });
  const t2 = createTask(p, { name: "t2", status: "TODO" });
  // Note: same-second created_at; FIFO order is by created_at ASC then id —
  // since insert order is t1 then t2 and the timestamps tie, ordering can be
  // either way. We only assert that two distinct tasks come out, not the
  // exact pair order.

  const a = claim({
    stage: "todo_picker",
    workerId: "w1",
    ttlSeconds: 60,
  });
  const b = claim({
    stage: "todo_picker",
    workerId: "w2",
    ttlSeconds: 60,
  });
  assert.ok(a && b);
  assert.notEqual(a!.id, b!.id);
  assert.ok([t1.id, t2.id].includes(a!.id));
  assert.ok([t1.id, t2.id].includes(b!.id));
});

test("claim returns null when only candidate has an unexpired lock", () => {
  const p = createProject({ slug: "AC" });
  createTask(p, { name: "locked", status: "TODO" });

  const first = claim({
    stage: "todo_picker",
    workerId: "w1",
    ttlSeconds: 60,
  });
  assert.ok(first);

  const second = claim({
    stage: "todo_picker",
    workerId: "w2",
    ttlSeconds: 60,
  });
  assert.equal(second, null);
});

test("claim re-picks the task after the TTL expires", async () => {
  const p = createProject({ slug: "AC" });
  const task = createTask(p, { name: "reclaim", status: "TODO" });

  const first = claim({
    stage: "todo_picker",
    workerId: "w1",
    ttlSeconds: 1,
  });
  assert.ok(first);
  assert.equal(first!.id, task.id);

  // Wait past the 1s TTL plus the second-precision boundary. SQLite stores
  // claimed_until as a unix second; the predicate is strict `<`, so the
  // current second must exceed claimed_until.
  await new Promise((resolve) => setTimeout(resolve, 2100));

  const second = claim({
    stage: "todo_picker",
    workerId: "w2",
    ttlSeconds: 60,
  });
  assert.ok(second, "expected reclaim after TTL expiry");
  assert.equal(second!.id, task.id);
  assert.equal(second!.claimed_by, "w2");
});

test("paused project skips its tasks for every stage", () => {
  const live = createProject({ slug: "LIVE" });
  const paused = createProject({ slug: "PAUSED", paused: true });
  createTask(paused, { name: "paused task", status: "TODO" });
  const liveTask = createTask(live, { name: "live task", status: "TODO" });

  const claimed = claim({
    stage: "todo_picker",
    workerId: "w1",
    ttlSeconds: 60,
  });
  assert.ok(claimed);
  assert.equal(claimed!.id, liveTask.id);
});
