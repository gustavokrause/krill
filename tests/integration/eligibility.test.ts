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
import { claim } from "@/workflow/claim";
import { checkEligibility } from "@/workflow/eligibility";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

test("dep blocker prevents pickup until the blocker is DONE", () => {
  const p = createProject({ slug: "DEP", max_parallel_tasks: 5 });
  const blocker = createTask(p, { name: "blocker", status: "TODO" });
  const dependent = createTask(p, {
    name: "dependent",
    status: "TODO",
    depends_on: [blocker.id],
  });

  const elig = checkEligibility(dependent);
  assert.equal(elig.eligible, false);
  assert.equal(elig.reason, "deps_not_done");

  // After the blocker reaches DONE, dependent becomes eligible.
  db.update(tables.tasks)
    .set({ status: "DONE" })
    .where(eq(tables.tasks.id, blocker.id))
    .run();

  const refreshed = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, dependent.id))
    .get()!;
  const elig2 = checkEligibility(refreshed);
  assert.equal(elig2.eligible, true);
});

test("conflicts_with skips when peer is active", () => {
  const p = createProject({ slug: "CONF", max_parallel_tasks: 5 });
  const peer = createTask(p, { name: "peer", status: "PLANNING" });
  const blocked = createTask(p, {
    name: "blocked",
    status: "TODO",
    conflicts_with: [peer.id],
  });

  const elig = checkEligibility(blocked);
  assert.equal(elig.eligible, false);
  assert.equal(elig.reason, "conflict_active");
});

test("max_parallel_tasks caps active state count per project", () => {
  const p = createProject({ slug: "PAR", max_parallel_tasks: 2 });
  createTask(p, { name: "a1", status: "PLANNING" });
  createTask(p, { name: "a2", status: "IMPLEMENTING" });
  const waiting = createTask(p, { name: "wait", status: "TODO" });

  const elig = checkEligibility(waiting);
  assert.equal(elig.eligible, false);
  assert.equal(elig.reason, "max_parallel_reached");
});

test("claim TODO honors all three eligibility gates and picks the next free task", () => {
  const p = createProject({ slug: "ELG", max_parallel_tasks: 3 });
  // Blocked by deps:
  const blocker = createTask(p, { name: "blocker", status: "TODO" });
  createTask(p, {
    name: "dep-blocked",
    status: "TODO",
    depends_on: [blocker.id],
  });
  // Blocked by conflict:
  const peer = createTask(p, { name: "peer", status: "PLANNING" });
  createTask(p, {
    name: "conflict-blocked",
    status: "TODO",
    conflicts_with: [peer.id],
  });
  // Open candidate:
  const open = createTask(p, { name: "open", status: "TODO" });
  // First call should pick blocker (no deps; not conflicting).
  const a = claim({
    stage: "todo_picker",
    workerId: "w1",
    ttlSeconds: 60,
  });
  assert.ok(a);
  assert.ok([blocker.id, open.id].includes(a!.id));

  // Drain by advancing claim manually so the second call can grab the other.
  const b = claim({
    stage: "todo_picker",
    workerId: "w2",
    ttlSeconds: 60,
  });
  assert.ok(b);
  assert.notEqual(a!.id, b!.id);
  assert.ok([blocker.id, open.id].includes(b!.id));

  // A third claim now should be null — only blocked candidates remain.
  const c = claim({
    stage: "todo_picker",
    workerId: "w3",
    ttlSeconds: 60,
  });
  assert.equal(c, null);
});
