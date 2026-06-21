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
  getRunnerTimeoutMs,
  pickPromptFor,
} from "./context";

/**
 * VERIFYING handler. Mirrors AI-REVIEW: the transition is driven by
 * task_verify() inside the MCP tools (pass → PUBLISHING, fail → IMPLEMENTING,
 * brake reached → NEEDS_REVIEW(verify)). Unlike AI-REVIEW this run actually
 * RUNS the change in its worktree to prove behavior against the acceptance
 * criteria — it never edits code (a fail bounces back to IMPLEMENTING). If the
 * runner exits without calling task_verify we release the claim and retry.
 */
export async function runVerify(workerId: string): Promise<string | null> {
  const ttl = getClaimTtl("verify");
  const task = claim({ stage: "verify", workerId, ttlSeconds: ttl });
  if (!task) return null;

  const project = getProject(task.project_id);
  const cwd = task.worktree_path ?? task.workspace_path;
  if (!cwd) {
    releaseClaim(task.id, workerId);
    throw new Error(`task ${task.id} missing worktree/workspace`);
  }

  const token = issueToken(task.id, "verify", ttl);
  try {
    const prompt = pickPromptFor("verify", task);
    try {
      await getRunner().run({
        stage: "verify",
        task,
        project,
        prompt,
        mcpToken: token,
        baseUrl: getBaseUrl(),
        cwd,
        timeoutMs: getRunnerTimeoutMs(ttl),
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        appendAiComment(task.id, `verify timed out after ${ttl}s — will retry`, "VERIFYING");
      }
      releaseClaim(task.id, workerId);
      throw err;
    }
    // If task_verify was not invoked, ensure the claim is released so the
    // next tick can re-enter.
    releaseClaim(task.id, workerId);
    return task.id;
  } finally {
    revokeToken(token);
  }
}
