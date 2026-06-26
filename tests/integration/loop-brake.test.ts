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
import { task_decide } from "@/claude/mcp-tools";
import { countAiAutoActions } from "@/workflow/loop-brake";

before(() => {
  cleanData();
});

beforeEach(() => {
  cleanData();
});

function ctxFor(taskId: string) {
  return {
    token: "test-token",
    taskId,
    stage: "ai_review" as const,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  };
}

test("countAiAutoActions counts AI comments since last human comment", () => {
  const p = createProject({ slug: "BR" });
  const t = createTask(p, { name: "t1", status: "AI-REVIEW" });

  assert.equal(countAiAutoActions(t.id), 0);

  // Append 2 AI comments via task_decide (decline path).
  task_decide(ctxFor(t.id), "decline", "too short");
  // After decline, the task is back to IMPLEMENTING. Move it to AI-REVIEW
  // manually so the next decline call passes the status gate.
  db.update(tables.tasks)
    .set({ status: "AI-REVIEW" })
    .where(eq(tables.tasks.id, t.id))
    .run();
  task_decide(ctxFor(t.id), "decline", "still short");

  // 2 AI comments so far (the decline reasons).
  assert.equal(countAiAutoActions(t.id), 2);

  // Human inserts a comment via direct DB write to simulate inline feedback.
  db.insert(tables.comments)
    .values({
      id: "human-c-1",
      task_id: t.id,
      at: Math.floor(Date.now() / 1000),
      stage: "AI-REVIEW",
      author: "human",
      text: "see thread",
    })
    .run();

  // Counter resets to 0 after the human comment.
  assert.equal(countAiAutoActions(t.id), 0);
});

test("task_decide parks at NEEDS_REVIEW(declined) after max_ai_decline_cycles declines", () => {
  const p = createProject({ slug: "BR" });
  const t = createTask(p, { name: "t1", status: "AI-REVIEW" });

  // Default max_ai_decline_cycles=3. At the cap the brake PARKS for a human —
  // it must NOT force the rejected work forward toward PUBLISHING.
  for (let i = 0; i < 3; i++) {
    task_decide(ctxFor(t.id), "decline", `attempt ${i + 1}`);
    if (i < 2) {
      // Reset to AI-REVIEW between iterations since each non-cap decline
      // bounced to IMPLEMENTING.
      db.update(tables.tasks)
        .set({ status: "AI-REVIEW" })
        .where(eq(tables.tasks.id, t.id))
        .run();
    }
  }

  const row = db.select().from(tables.tasks).where(eq(tables.tasks.id, t.id)).get();
  assert.equal(
    row!.status,
    "NEEDS_REVIEW",
    "brake should park at NEEDS_REVIEW at decline cycle ≥ max, not force forward",
  );
  assert.equal(
    row!.pending_review_kind,
    "declined",
    "brake park should be a 'declined' review (rejected), not 'deliverable' (ready-to-merge)",
  );

  // A brake-marker comment should exist.
  const cmts = db
    .select()
    .from(tables.comments)
    .where(eq(tables.comments.task_id, t.id))
    .all();
  assert.ok(
    cmts.some((c) => c.text.includes("max AI decline cycles")),
    "expected the brake-deferral comment",
  );
});

test("task_decide rejects approve outside AI-REVIEW", () => {
  const p = createProject({ slug: "BR" });
  const t = createTask(p, { name: "t1", status: "IMPLEMENTING" });

  assert.throws(() => {
    task_decide(ctxFor(t.id), "approve", "looks good");
  }, /AI-REVIEW/);
});
