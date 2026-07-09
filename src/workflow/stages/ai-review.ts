import { and, eq, gte, like } from "drizzle-orm";
import { runStage } from "@/claude/usage";
import { TimeoutError } from "@/claude/errors";
import { issueToken, revokeToken } from "@/claude/mcp-auth";
import { db } from "@/db/client";
import { comments, tasks } from "@/db/schema";
import { AI_REVIEW_FIRST_PASS_MODEL } from "@/claude/model-map";
import { pauseLineForHuman } from "../blockers";
import { claim } from "../claim";
import { appendAiComment } from "../comment";
import { repoMissingBlock } from "../preflight";
import { countAiAutoActions, getMaxAiDeclineCycles } from "../loop-brake";
import { releaseClaim, transitionStatus } from "../transition";
import {
  getBaseUrl,
  getClaimTtl,
  getProject,
  getRunnerTimeoutMs,
  pickPromptFor,
} from "./context";

// Marker prefix on the comment we append every time a review run ends without
// a verdict. We count these (since the current AI-REVIEW episode began) to
// bound the no-verdict retry loop without a schema column — same pattern as
// the VERIFYING incomplete brake.
const AI_REVIEW_INCOMPLETE_MARKER = "[ai-review-incomplete]";

/**
 * AI-REVIEW handler. The transition is driven by task_decide() inside the
 * MCP tools (approve → PUBLISHING, decline → IMPLEMENTING, brake reached →
 * force-PUBLISHING).
 *
 * If the runner exits WITHOUT calling task_decide (timeout, crash, or it just
 * never reached a verdict) the status is still AI-REVIEW. That path used to
 * release the claim and silently retry every tick — an unbounded loop at full
 * review-model cost per pass. We now count those incomplete runs and, after
 * max_ai_decline_cycles of them, park at NEEDS_REVIEW(stuck) for a human.
 */
export async function runAiReview(workerId: string): Promise<string | null> {
  const ttl = getClaimTtl("ai_review");
  const task = claim({ stage: "ai_review", workerId, ttlSeconds: ttl });
  if (!task) return null;

  const project = getProject(task.project_id);

  // Repo gone (moved/deleted) → block + release instead of looping on git errors.
  if (repoMissingBlock({ task, project, stage: "AI-REVIEW", workerId })) {
    return task.id;
  }

  const cwd = task.worktree_path ?? task.workspace_path;
  if (!cwd) {
    releaseClaim(task.id, workerId);
    throw new Error(`task ${task.id} missing worktree/workspace`);
  }

  const token = issueToken(task.id, "ai_review", ttl);
  try {
    const prompt = pickPromptFor("ai_review", task);
    // Cheap-first ladder: no review activity yet → Sonnet first pass; any
    // prior AI-REVIEW cycle (decline, incomplete, escalate) → stage default
    // (Opus), the review is contested and judgment is load-bearing.
    const firstPass = countAiAutoActions(task.id, "AI-REVIEW") === 0;
    try {
      await runStage({
        stage: "ai_review",
        task,
        project,
        prompt,
        mcpToken: token,
        baseUrl: getBaseUrl(),
        cwd,
        timeoutMs: getRunnerTimeoutMs(ttl),
        ...(firstPass ? { model: AI_REVIEW_FIRST_PASS_MODEL } : {}),
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        brakeIncompleteReview(
          task.id,
          workerId,
          task.stage_entered_at,
          `ai-review timed out after ${ttl}s`,
        );
        throw err;
      }
      releaseClaim(task.id, workerId);
      throw err;
    }
    // A verdict (task_decide) would have moved the status off AI-REVIEW. Still
    // AI-REVIEW ⇒ the run produced no verdict — count it and brake if needed.
    const after = db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get();
    if (after?.status === "AI-REVIEW") {
      brakeIncompleteReview(
        task.id,
        workerId,
        task.stage_entered_at,
        "runner exited without calling task_decide",
      );
    }
    return task.id;
  } finally {
    revokeToken(token);
  }
}

/** Count incomplete-review markers logged in the current AI-REVIEW episode. */
function countIncompleteReviews(taskId: string, since: number): number {
  return db
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(
        eq(comments.task_id, taskId),
        eq(comments.stage, "AI-REVIEW"),
        gte(comments.at, since),
        like(comments.text, `${AI_REVIEW_INCOMPLETE_MARKER}%`),
      ),
    )
    .all().length;
}

/**
 * Handle a review run that ended without a verdict: log the attempt and, once
 * we hit the configured cycle limit, park the task at NEEDS_REVIEW(stuck) and
 * pause the line. Otherwise release the claim so the next tick retries.
 */
function brakeIncompleteReview(
  taskId: string,
  workerId: string,
  episodeStart: number,
  why: string,
): void {
  appendAiComment(
    taskId,
    `${AI_REVIEW_INCOMPLETE_MARKER} ai-review did not reach a verdict: ${why}.`,
    "AI-REVIEW",
  );

  const max = getMaxAiDeclineCycles();
  if (countIncompleteReviews(taskId, episodeStart) >= max) {
    appendAiComment(
      taskId,
      `Parking for human review — ai-review could not reach a verdict after ${max} attempts. ` +
        `Investigate (worktree state, diff size, runner logs), then move the task back to re-review.`,
      "AI-REVIEW",
    );
    const parked = transitionStatus({
      taskId,
      from: "AI-REVIEW",
      to: "NEEDS_REVIEW",
      pendingReviewKind: "stuck",
    });
    if (parked) {
      pauseLineForHuman({
        taskId,
        stage: "ai_review",
        summary: `AI review couldn't reach a verdict on ${taskId} after ${max} attempts`,
        detail: why,
      });
    } else {
      // Lost a race (a verdict landed concurrently) — just drop our claim.
      releaseClaim(taskId, workerId);
    }
    return;
  }

  releaseClaim(taskId, workerId);
}
