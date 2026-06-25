import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { cleanData, createProject, createTask, db, tables } from "../helpers/setup";
import { task_set_plan, task_set_plan_summary } from "@/claude/mcp-tools";
import type { Stage } from "@/workflow/types";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

const row = (id: string) =>
  db.select().from(tables.tasks).where(eq(tables.tasks.id, id)).get()!;

function ctx(taskId: string, stage: Stage) {
  return { token: "t", taskId, stage, expiresAt: Math.floor(Date.now() / 1000) + 60 };
}

test("task_set_plan_summary writes plan_summary; plan is byte-identical", () => {
  const p = createProject({ slug: "PS" });
  const t = createTask(p, { name: "t1", status: "PLANNING" });

  const planText = "## Plan\n\nDo the thing.";
  task_set_plan(ctx(t.id, "planning"), planText);
  task_set_plan_summary(ctx(t.id, "planning"), "Short summary of the plan.");

  const r = row(t.id);
  assert.equal(r.plan_summary, "Short summary of the plan.");
  assert.equal(r.plan, planText, "plan must be byte-identical after task_set_plan_summary");
});

test("task_set_plan_summary is rejected outside planning stage", () => {
  const p = createProject({ slug: "PS" });
  const t = createTask(p, { name: "t2", status: "IMPLEMENTING" });

  assert.throws(
    () => task_set_plan_summary(ctx(t.id, "implementing"), "should fail"),
    /not allowed in stage/,
  );
});
