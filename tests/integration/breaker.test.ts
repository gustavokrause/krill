import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { cancelDependentsCascade, tripAutoFinishBreaker } from "@/workflow/breaker";

beforeEach(() => cleanData());

const reload = (id: string) =>
  db.select().from(tables.tasks).where(eq(tables.tasks.id, id)).get()!;
const projPaused = (id: string) =>
  db.select().from(tables.projects).where(eq(tables.projects.id, id)).get()!.paused;

test("cancelDependentsCascade cancels the dependent subtree, leaves independents", () => {
  const p = createProject({ slug: "CAS" });
  const a = createTask(p, { name: "a", status: "TODO" });
  const b = createTask(p, { name: "b", status: "TODO", depends_on: [a.id] });
  const c = createTask(p, { name: "c", status: "TODO", depends_on: [b.id] });
  const d = createTask(p, { name: "d", status: "TODO" }); // independent

  const n = cancelDependentsCascade(a.id);

  assert.equal(n, 2, "b and c canceled");
  assert.equal(reload(b.id).status, "CANCELED");
  assert.equal(reload(c.id).status, "CANCELED", "transitive dependent canceled");
  assert.equal(reload(d.id).status, "TODO", "independent untouched");
  assert.equal(reload(a.id).status, "TODO", "the canceled task itself isn't touched here");
});

test("circuit breaker trips + pauses project at 2 auto-finish failures", () => {
  const p = createProject({ slug: "BRK" });
  createTask(p, { name: "x", status: "NEEDS_REVIEW", pending_review_kind: "deliverable", auto_publish: true });
  createTask(p, { name: "y", status: "CANCELED", auto_publish: true });

  const tripped = tripAutoFinishBreaker(p.id);

  assert.equal(tripped, true);
  assert.equal(projPaused(p.id), true, "project paused by breaker");
});

test("circuit breaker does NOT trip on a single failure", () => {
  const p = createProject({ slug: "BRK2" });
  createTask(p, { name: "x", status: "NEEDS_REVIEW", pending_review_kind: "deliverable", auto_publish: true });

  assert.equal(tripAutoFinishBreaker(p.id), false);
  assert.equal(projPaused(p.id), false);
});

test("circuit breaker ignores non-auto-finish failures", () => {
  const p = createProject({ slug: "BRK3" });
  // two failures, but not auto_publish → not the breaker's concern
  createTask(p, { name: "x", status: "CANCELED", auto_publish: false });
  createTask(p, { name: "y", status: "NEEDS_REVIEW", pending_review_kind: "deliverable", auto_publish: false });

  assert.equal(tripAutoFinishBreaker(p.id), false);
  assert.equal(projPaused(p.id), false);
});
