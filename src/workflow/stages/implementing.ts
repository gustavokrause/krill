import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { getRunner } from "@/claude";
import { TimeoutError } from "@/claude/errors";
import { issueToken, revokeToken } from "@/claude/mcp-auth";
import { commitAll, diffNamesAgainstBase, pushBranch } from "@/git";
import { claim } from "../claim";
import { applyTransitionSideEffects } from "../cleanup";
import { appendAiComment } from "../comment";
import { releaseClaim, transitionStatus } from "../transition";
import { now } from "../types";
import {
  ensureWorkspace,
  getBaseUrl,
  getClaimTtl,
  getProject,
  getRunnerTimeoutMs,
  pickPromptFor,
} from "./context";

export async function runImplementing(
  workerId: string,
): Promise<string | null> {
  const ttl = getClaimTtl("implementing");
  const task = claim({ stage: "implementing", workerId, ttlSeconds: ttl });
  if (!task) return null;

  const project = getProject(task.project_id);

  // Task may arrive here without a workspace if the picker routed
  // skip_plan=true straight from TODO, or if a human manually advanced
  // the task. `ensureWorkspace` is idempotent — no-op when already set up.
  try {
    await ensureWorkspace(task, project);
  } catch (err) {
    releaseClaim(task.id, workerId);
    throw err;
  }

  const cwd = task.worktree_path ?? task.workspace_path;
  if (!cwd) {
    releaseClaim(task.id, workerId);
    throw new Error(`task ${task.id} missing worktree/workspace`);
  }

  const token = issueToken(task.id, "implementing", ttl);
  try {
    const prompt = pickPromptFor("implementing", task);
    try {
      await getRunner().run({
        stage: "implementing",
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
        appendAiComment(task.id, `implementing timed out after ${ttl}s — will retry`, "IMPLEMENTING");
        releaseClaim(task.id, workerId);
      }
      throw err;
    }

    if (project.has_repo && task.worktree_path && task.branch) {
      const message = `${task.id}: ${task.name}`;
      const sha = await commitAll(task.worktree_path, message);
      if (sha) {
        try {
          await pushBranch(task.worktree_path, task.branch);
        } catch (err) {
          console.warn(`push failed for ${task.id}:`, err);
        }
      }
      const diff = await diffNamesAgainstBase(
        task.worktree_path,
        project.default_branch,
      );
      db.update(tasks)
        .set({ affected_paths: diff, updated_at: now() })
        .where(eq(tasks.id, task.id))
        .run();

      // Empty implementation: the runner committed nothing and the branch has
      // no diff against base. Advancing would graduate an empty branch to
      // PUBLISHING, where `gh pr create` fails forever ("No commits between
      // <base> and <branch>") and head-of-line-blocks the publish queue. By
      // design an empty result is a human-review event — route it to
      // NEEDS_REVIEW here, at the source, instead of letting it rot downstream.
      if (!sha && diff.length === 0) {
        appendAiComment(
          task.id,
          `no codebase changes — implementation produced no commits on \`${task.branch}\`, nothing to ship. Safe to mark DONE, or cancel; re-run IMPLEMENTING to retry.`,
          "NEEDS_REVIEW",
        );
        const parked = transitionStatus({
          taskId: task.id,
          from: "IMPLEMENTING",
          to: "NEEDS_REVIEW",
          pendingReviewKind: "empty",
        });
        if (parked) {
          await applyTransitionSideEffects(task.id, "IMPLEMENTING", "NEEDS_REVIEW");
        } else {
          releaseClaim(task.id, workerId);
        }
        return task.id;
      }
    } else {
      const scanned = scanWorkspace(cwd);
      db.update(tasks)
        .set({ affected_paths: scanned, updated_at: now() })
        .where(eq(tasks.id, task.id))
        .run();
    }

    // 3-way: AI-REVIEW gates first; with it skipped, VERIFYING runs the change
    // unless that's skipped too, then straight to PUBLISHING.
    const target = task.skip_ai_review
      ? task.skip_verify
        ? "PUBLISHING"
        : "VERIFYING"
      : "AI-REVIEW";
    const moved = transitionStatus({
      taskId: task.id,
      from: "IMPLEMENTING",
      to: target,
    });
    if (moved) {
      await applyTransitionSideEffects(task.id, "IMPLEMENTING", target);
    } else {
      releaseClaim(task.id, workerId);
    }
    return task.id;
  } finally {
    revokeToken(token);
  }
}

function scanWorkspace(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else out.push(relative(root, abs).replaceAll("\\", "/"));
    }
  };
  try {
    walk(root);
  } catch {}
  return out.sort();
}
