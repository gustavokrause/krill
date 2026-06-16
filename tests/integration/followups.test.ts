import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { task_seed_followup } from "@/claude/mcp-tools";
import { listOpenFollowups, consumeFollowup } from "@/workflow/followups";

beforeEach(() => cleanData());

const ctx = (taskId: string) => ({ token: "t", taskId, stage: "implementing" as const, expiresAt: Date.now() + 1e6 });

test("task_seed_followup records an open follow-up for the task's project", () => {
  const project = createProject({ slug: "FU", has_repo: true });
  const task = createTask(project, { name: "docs", status: "IMPLEMENTING", mode: "non-dev" });

  task_seed_followup(ctx(task.id), "edit features.ts BETA_UNTIL_DATE", "apps/.../features.ts:6");
  task_seed_followup(ctx(task.id), "revise handle_new_user SQL default");

  const open = listOpenFollowups();
  assert.equal(open.length, 2);
  assert.equal(open[0].project_slug, "FU", "joined with project slug");
  assert.equal(open.every((f) => f.task_id === task.id), true, "lineage to the task");
});

test("consumeFollowup drops it from the open list", () => {
  const project = createProject({ slug: "FV", has_repo: true });
  const task = createTask(project, { name: "x", status: "AI-REVIEW", mode: "dev" });
  const r = task_seed_followup({ ...ctx(task.id), stage: "ai_review" }, "schedule Plan B kickoff");
  assert.equal(listOpenFollowups().length, 1);

  consumeFollowup(r.id);
  assert.equal(listOpenFollowups().length, 0);
  assert.equal(db.select().from(tables.followups).where(eq(tables.followups.id, r.id)).get()!.status, "consumed");
});
