import { and, eq, gte, like } from "drizzle-orm";
import { runStage } from "@/claude/usage";
import { TimeoutError } from "@/claude/errors";
import { issueToken, revokeToken } from "@/claude/mcp-auth";
import { effectiveModel, pickResumeSession } from "@/claude/resume";
import { db } from "@/db/client";
import { comments, tasks } from "@/db/schema";
import { pauseLineForHuman } from "../blockers";
import { claim } from "../claim";
import { appendAiComment } from "../comment";
import { repoMissingBlock } from "../preflight";
import { getMaxAiDeclineCycles } from "../loop-brake";
import { releaseClaim, transitionStatus } from "../transition";
import {
  getBaseUrl,
  getClaimTtl,
  getProject,
  getRunnerTimeoutMs,
  pickPromptFor,
} from "./context";

// Marker prefix on the comment we append every time a verify run ends without a
// verdict. We count these (since the current VERIFYING episode began) to bound
// the no-verdict retry loop without a schema column.
const VERIFY_INCOMPLETE_MARKER = "[verify-incomplete]";

/**
 * VERIFYING handler. Mirrors AI-REVIEW: the transition is driven by
 * task_verify() inside the MCP tools (pass → PUBLISHING, fail → IMPLEMENTING,
 * brake reached → NEEDS_REVIEW(verify)). Unlike AI-REVIEW this run actually
 * RUNS the change in its worktree to prove behavior against the acceptance
 * criteria — it never edits code (a fail bounces back to IMPLEMENTING).
 *
 * If the runner exits WITHOUT calling task_verify (it couldn't run the change,
 * timed out, or died early) the status is still VERIFYING. That path used to
 * release the claim and silently retry every tick — an unbounded loop when the
 * change simply can't be run in the worktree. We now count those incomplete
 * runs and, after max_ai_decline_cycles of them, park at NEEDS_REVIEW(verify)
 * for a human instead of looping forever.
 */
export async function runVerify(workerId: string): Promise<string | null> {
  const ttl = getClaimTtl("verify");
  const task = claim({ stage: "verify", workerId, ttlSeconds: ttl });
  if (!task) return null;

  const project = getProject(task.project_id);

  // Repo gone (moved/deleted) → block + release instead of looping on git errors.
  if (repoMissingBlock({ task, project, stage: "VERIFYING", workerId })) {
    return task.id;
  }

  const cwd = task.worktree_path ?? task.workspace_path;
  if (!cwd) {
    releaseClaim(task.id, workerId);
    throw new Error(`task ${task.id} missing worktree/workspace`);
  }

  const token = issueToken(task.id, "verify", ttl);
  try {
    const prompt = pickPromptFor("verify", task);
    // V2/V1 resume: prefer the freshest same-model session — the implementing
    // run (diff/files/plan already in context) or a prior verify attempt.
    // MCP auth is unchanged: this spawn gets a fresh verify-scoped token and
    // config; the resumed transcript only supplies context.
    const resumeSessionId = pickResumeSession(
      task,
      "verify",
      effectiveModel("verify"),
    );
    try {
      await runStage({
        stage: "verify",
        task,
        project,
        prompt,
        mcpToken: token,
        baseUrl: getBaseUrl(),
        cwd,
        timeoutMs: getRunnerTimeoutMs(ttl),
        resumeSessionId,
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        brakeIncompleteVerify(
          task.id,
          workerId,
          task.stage_entered_at,
          `verify timed out after ${ttl}s`,
        );
        throw err;
      }
      releaseClaim(task.id, workerId);
      throw err;
    }
    // A verdict (task_verify) would have moved the status off VERIFYING. Still
    // VERIFYING ⇒ the run produced no verdict — count it and brake if needed.
    const after = db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get();
    if (after?.status === "VERIFYING") {
      brakeIncompleteVerify(
        task.id,
        workerId,
        task.stage_entered_at,
        "runner exited without calling task_verify",
      );
    }
    return task.id;
  } finally {
    revokeToken(token);
  }
}

/** Count incomplete-verify markers logged in the current VERIFYING episode. */
function countIncompleteVerifies(taskId: string, since: number): number {
  return db
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(
        eq(comments.task_id, taskId),
        eq(comments.stage, "VERIFYING"),
        gte(comments.at, since),
        like(comments.text, `${VERIFY_INCOMPLETE_MARKER}%`),
      ),
    )
    .all().length;
}

/**
 * Handle a verify run that ended without a verdict: log the attempt (so the
 * human has a trail) and, once we hit the configured cycle limit, park the task
 * at NEEDS_REVIEW(verify) and pause the line. Otherwise release the claim so the
 * next tick retries.
 */
function brakeIncompleteVerify(
  taskId: string,
  workerId: string,
  episodeStart: number,
  why: string,
): void {
  appendAiComment(
    taskId,
    `${VERIFY_INCOMPLETE_MARKER} verify did not reach a verdict: ${why}. The change was not proven against its acceptance.`,
    "VERIFYING",
  );

  const max = getMaxAiDeclineCycles();
  if (countIncompleteVerifies(taskId, episodeStart) >= max) {
    appendAiComment(
      taskId,
      `Parking for human review — verify could not complete after ${max} attempts. ` +
        `Most likely the change can't be run in its worktree (missing deps / the app won't start). ` +
        `Investigate, then move the task back to re-verify.`,
      "VERIFYING",
    );
    const parked = transitionStatus({
      taskId,
      from: "VERIFYING",
      to: "NEEDS_REVIEW",
      pendingReviewKind: "verify",
    });
    if (parked) {
      pauseLineForHuman({
        taskId,
        stage: "verify",
        summary: `Verification couldn't complete ${taskId} after ${max} attempts`,
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
