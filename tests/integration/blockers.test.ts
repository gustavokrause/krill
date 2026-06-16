import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, tables, cleanData, createProject, createTask } from "../helpers/setup";
import { classifyBlock } from "@/claude/errors";
import { addBlocker, listBlockers, resolveBlocker, setTaskBlocked } from "@/workflow/blockers";
import { claim } from "@/workflow/claim";

beforeEach(() => cleanData());

test("classifyBlock: auth/login prompts classify, ordinary failures don't", () => {
  const supa = classifyBlock("Open this URL to authorize Supabase:\nhttps://api.supabase.com/v1/oauth/authorize?x=1");
  assert.equal(supa?.kind, "mcp_auth");
  assert.match(supa?.actionUrl ?? "", /^https:\/\/api\.supabase\.com/);
  assert.equal(classifyBlock("Not logged in · Please run /login")?.kind, "cli_login");
  assert.equal(classifyBlock("claude exited 1: some compile error"), null);
});

test("claim skips blocked tasks; clearing the block makes them claimable again", () => {
  const project = createProject({ slug: "BK", has_repo: true });
  const task = createTask(project, { name: "x", status: "PLANNING", mode: "non-dev" });

  setTaskBlocked(task.id, true);
  assert.equal(claim({ stage: "planning", workerId: "w1", ttlSeconds: 60 }), null, "blocked → not claimed");

  setTaskBlocked(task.id, false);
  const got = claim({ stage: "planning", workerId: "w2", ttlSeconds: 60 });
  assert.equal(got?.id, task.id, "unblocked → claimable");
});

test("blocker queue: file (deduped), resolve unblocks the task, dismiss doesn't", () => {
  const project = createProject({ slug: "BQ", has_repo: true });
  const t1 = createTask(project, { name: "a", status: "PLANNING", mode: "non-dev" });
  const t2 = createTask(project, { name: "b", status: "PLANNING", mode: "non-dev" });
  setTaskBlocked(t1.id, true);
  setTaskBlocked(t2.id, true);

  const a = addBlocker({ kind: "mcp_auth", task_id: t1.id, stage: "planning", summary: "auth", action_url: "https://x" });
  // same (kind, task, stage) while open -> dedupe
  const dup = addBlocker({ kind: "mcp_auth", task_id: t1.id, stage: "planning", summary: "auth again" });
  assert.equal(dup.id, a.id, "deduped");
  const b = addBlocker({ kind: "mcp_auth", task_id: t2.id, stage: "planning", summary: "other" });
  assert.equal(listBlockers("open").length, 2);

  resolveBlocker(a.id, "resolved");
  assert.equal(listBlockers("open").length, 1, "resolved drops out of open");
  assert.equal(db.select().from(tables.tasks).where(eq(tables.tasks.id, t1.id)).get()!.blocked, false, "resolve unblocks the task");

  resolveBlocker(b.id, "dismissed");
  assert.equal(db.select().from(tables.tasks).where(eq(tables.tasks.id, t2.id)).get()!.blocked, true, "dismiss leaves the task blocked");
});
