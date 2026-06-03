import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  cleanData,
  createProject,
  createTask,
  db,
  tables,
} from "../helpers/setup";
import { StubClaudeRunner } from "@/claude/stub-runner";
import { setRunner } from "@/claude";
import { transitionStatus } from "@/workflow/transition";
import { runAiReview } from "@/workflow/stages/ai-review";
import { runImplementing } from "@/workflow/stages/implementing";
import { runPlanning } from "@/workflow/stages/planning";
import { runPublishing } from "@/workflow/stages/publishing";
import { runTodoPicker } from "@/workflow/stages/todo-picker";

let sandbox: string;

before(() => {
  setRunner(new StubClaudeRunner());
  cleanData();
});

beforeEach(() => {
  cleanData();
  sandbox = mkdtempSync(join(tmpdir(), "ai-lifecycle-"));
});

after(() => {
  if (sandbox && existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("BACKLOG → DONE walks the non-dev path with the stub Claude", async () => {
  const project = createProject({
    slug: "LC",
    has_repo: false,
    folder_path: sandbox,
  });
  const task = createTask(project, {
    name: "deliver a doc",
    status: "BACKLOG",
    mode: "non-dev",
    skip_plan_review: true,
    skip_ai_review: true,
  });

  // BACKLOG → TODO
  assert.equal(
    transitionStatus({ taskId: task.id, from: "BACKLOG", to: "TODO" }),
    true,
  );

  // TODO → PLANNING via the picker
  const picked = await runTodoPicker("worker-todo");
  assert.equal(picked, task.id);

  // PLANNING → IMPLEMENTING (skip_plan_review)
  const planned = await runPlanning("worker-plan");
  assert.equal(planned, task.id);
  const afterPlan = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get()!;
  assert.equal(afterPlan.status, "IMPLEMENTING");
  assert.ok(afterPlan.plan.length > 0, "stub planning should write a plan");
  assert.ok(
    afterPlan.affected_paths.length > 0,
    "stub planning should set affected_paths",
  );

  // IMPLEMENTING → PUBLISHING (skip_ai_review)
  const implemented = await runImplementing("worker-impl");
  assert.equal(implemented, task.id);
  const afterImpl = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get()!;
  assert.equal(afterImpl.status, "PUBLISHING");

  // PUBLISHING → NEEDS_REVIEW(deliverable) (file move + workspace cleanup)
  const published = await runPublishing("worker-pub");
  assert.equal(published, task.id);
  const afterPub = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get()!;
  assert.equal(afterPub.status, "NEEDS_REVIEW");
  assert.equal(afterPub.pending_review_kind, "deliverable");
  assert.equal(afterPub.workspace_path, null);
  assert.ok(
    afterPub.delivery_url?.startsWith("file://"),
    "delivery_url should be a file:// path",
  );

  // Verify the file landed under project.folder_path.
  const target = afterPub.delivery_url!.replace(/^file:\/\//, "");
  assert.ok(existsSync(target), `delivery file should exist at ${target}`);
  const st = statSync(target);
  assert.ok(st.size > 0);

  // NEEDS_REVIEW(deliverable) → DONE
  assert.equal(
    transitionStatus({
      taskId: task.id,
      from: "NEEDS_REVIEW",
      to: "DONE",
      endedAt: Math.floor(Date.now() / 1000),
    }),
    true,
  );
  const final = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get()!;
  assert.equal(final.status, "DONE");
  assert.ok(final.ended_at, "ended_at should be set on DONE");
});

test("ai_review stub approve advances to PUBLISHING", async () => {
  // Drop skip_ai_review so AI-REVIEW actually runs.
  const project = createProject({
    slug: "AR",
    has_repo: false,
    folder_path: sandbox,
  });
  const task = createTask(project, {
    name: "approve me",
    status: "AI-REVIEW",
    workspace_path: join(sandbox, ".tasks", "AR-1"),
    affected_paths: ["docs/foo.md"],
  });

  const result = await runAiReview("worker-ai");
  assert.equal(result, task.id);
  const after = db
    .select()
    .from(tables.tasks)
    .where(eq(tables.tasks.id, task.id))
    .get()!;
  assert.equal(after.status, "PUBLISHING");
});
