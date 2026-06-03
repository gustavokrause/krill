import { getRunner } from "@/claude";
import { TimeoutError } from "@/claude/errors";
import { issueToken, revokeToken } from "@/claude/mcp-auth";
import { claim } from "../claim";
import { applyTransitionSideEffects } from "../cleanup";
import { appendAiComment } from "../comment";
import { releaseClaim, transitionStatus } from "../transition";
import {
  ensureWorkspace,
  getBaseUrl,
  getClaimTtl,
  getProject,
  getRunnerTimeoutMs,
  pickPromptFor,
} from "./context";

export async function runPlanning(workerId: string): Promise<string | null> {
  const ttl = getClaimTtl("planning");
  const task = claim({ stage: "planning", workerId, ttlSeconds: ttl });
  if (!task) return null;

  const project = getProject(task.project_id);

  try {
    await ensureWorkspace(task, project);
  } catch (err) {
    releaseClaim(task.id, workerId);
    throw err;
  }

  // Safety net: if a task arrives in PLANNING with `skip_plan=true` (e.g.
  // human moved it back), advance without running Opus. The picker also
  // routes skip_plan tasks directly TODO → IMPLEMENTING so this is rare.
  if (task.skip_plan) {
    const moved = transitionStatus({
      taskId: task.id,
      from: "PLANNING",
      to: "IMPLEMENTING",
    });
    if (!moved) releaseClaim(task.id, workerId);
    return task.id;
  }

  const token = issueToken(task.id, "planning", ttl);
  try {
    const cwd = task.worktree_path ?? task.workspace_path!;
    const prompt = pickPromptFor("planning", task);
    try {
      await getRunner().run({
        stage: "planning",
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
        appendAiComment(task.id, `planning timed out after ${ttl}s — will retry`, "PLANNING");
        releaseClaim(task.id, workerId);
      }
      throw err;
    }

    const target: "IMPLEMENTING" | "NEEDS_REVIEW" = task.skip_plan_review
      ? "IMPLEMENTING"
      : "NEEDS_REVIEW";
    const moved = transitionStatus({
      taskId: task.id,
      from: "PLANNING",
      to: target,
      ...(target === "NEEDS_REVIEW"
        ? { pendingReviewKind: "plan" as const }
        : {}),
    });
    if (moved) {
      await applyTransitionSideEffects(task.id, "PLANNING", target);
    } else {
      releaseClaim(task.id, workerId);
    }
    return task.id;
  } finally {
    revokeToken(token);
  }
}
