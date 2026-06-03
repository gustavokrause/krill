import { getRunner } from "@/claude";
import { TimeoutError } from "@/claude/errors";
import { issueToken, revokeToken } from "@/claude/mcp-auth";
import { claim } from "../claim";
import { appendAiComment } from "../comment";
import { releaseClaim } from "../transition";
import {
  getBaseUrl,
  getClaimTtl,
  getProject,
  pickPromptFor,
} from "./context";

/**
 * AI-REVIEW handler. The transition is driven by task_decide() inside the
 * MCP tools (approve → PUBLISHING, decline → IMPLEMENTING, brake reached →
 * force-PUBLISHING). If the runner exits without calling task_decide we
 * release the claim and let the next tick retry.
 */
export async function runAiReview(workerId: string): Promise<string | null> {
  const ttl = getClaimTtl("ai_review");
  const task = claim({ stage: "ai_review", workerId, ttlSeconds: ttl });
  if (!task) return null;

  const project = getProject(task.project_id);
  const cwd = task.worktree_path ?? task.workspace_path;
  if (!cwd) {
    releaseClaim(task.id, workerId);
    throw new Error(`task ${task.id} missing worktree/workspace`);
  }

  const token = issueToken(task.id, "ai_review", ttl);
  try {
    const prompt = pickPromptFor("ai_review", task);
    try {
      await getRunner().run({
        stage: "ai_review",
        task,
        project,
        prompt,
        mcpToken: token,
        baseUrl: getBaseUrl(),
        cwd,
        timeoutMs: ttl * 1000,
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        appendAiComment(task.id, `ai-review timed out after ${ttl}s — will retry`, "AI-REVIEW");
      }
      releaseClaim(task.id, workerId);
      throw err;
    }
    // If task_decide was not invoked, ensure the claim is released so the
    // next tick can re-enter.
    releaseClaim(task.id, workerId);
    return task.id;
  } finally {
    revokeToken(token);
  }
}
