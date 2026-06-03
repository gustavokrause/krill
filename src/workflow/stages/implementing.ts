import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { getRunner } from "@/claude";
import { issueToken, revokeToken } from "@/claude/mcp-auth";
import { commitAll, diffNamesAgainstBase, pushBranch } from "@/git";
import { claim } from "../claim";
import { applyTransitionSideEffects } from "../cleanup";
import { releaseClaim, transitionStatus } from "../transition";
import { now } from "../types";
import {
  ensureWorkspace,
  getBaseUrl,
  getClaimTtl,
  getProject,
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
    await getRunner().run({
      stage: "implementing",
      task,
      project,
      prompt,
      mcpToken: token,
      baseUrl: getBaseUrl(),
      cwd,
      timeoutMs: ttl * 1000,
    });

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
    } else {
      const scanned = scanWorkspace(cwd);
      db.update(tasks)
        .set({ affected_paths: scanned, updated_at: now() })
        .where(eq(tasks.id, task.id))
        .run();
    }

    const target = task.skip_ai_review ? "PUBLISHING" : "AI-REVIEW";
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
