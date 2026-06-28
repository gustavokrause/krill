import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { cleanData, createProject, createTask, db, tables } from "../helpers/setup";
import { task_set_plan, task_set_plan_summary, stripToolScaffold } from "@/claude/mcp-tools";
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

test("task_set_plan strips leaked tool-call scaffold (malformed bundle)", () => {
  const p = createProject({ slug: "PS" });
  const t = createTask(p, { name: "t3", status: "PLANNING" });

  // Reproduces a malformed task_set_plan_bundle: the model closed the `plan`
  // parameter with `</plan>` instead of `</parameter>`, so the parser swallowed
  // the sibling params into the plan value as raw tool-call XML.
  const polluted =
    "## Plan\n\nAdd the keys.</plan>\n" +
    '<parameter name="plan_summary">A short summary.</plan_summary>\n' +
    '<parameter name="checklist">- [ ] Add block to en_US.json after auth.reset.';
  task_set_plan(ctx(t.id, "planning"), polluted);

  const r = row(t.id);
  assert.equal(r.plan, "## Plan\n\nAdd the keys.");
  assert.doesNotMatch(r.plan, /<\/?plan|<parameter|checklist/i);
});

test("stripToolScaffold leaves clean values untouched (incl. legit code/JSX)", () => {
  const clean = "## Plan\n\nRender `<Button name=\"x\" />` and a `Map<string, T>`.";
  assert.equal(stripToolScaffold(clean), clean);
  assert.equal(stripToolScaffold("plain text"), "plain text");
});

test("task_set_plan_summary is rejected outside planning stage", () => {
  const p = createProject({ slug: "PS" });
  const t = createTask(p, { name: "t2", status: "IMPLEMENTING" });

  assert.throws(
    () => task_set_plan_summary(ctx(t.id, "implementing"), "should fail"),
    /not allowed in stage/,
  );
});
