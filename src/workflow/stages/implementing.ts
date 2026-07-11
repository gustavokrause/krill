import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { runStage } from "@/claude/usage";
import { TimeoutError } from "@/claude/errors";
import { issueToken, revokeToken } from "@/claude/mcp-auth";
import { commitAll, diffNamesAgainstBase, diffTextAgainstBase, pushBranch } from "@/git";
import { effectiveModel, pickResumeSession } from "@/claude/resume";
import { claim } from "../claim";
import { applyTransitionSideEffects } from "../cleanup";
import { appendAiComment } from "../comment";
import { repoMissingBlock } from "../preflight";
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

  // Repo gone (moved/deleted) → block + release instead of looping on git errors.
  if (repoMissingBlock({ task, project, stage: "IMPLEMENTING", workerId })) {
    return task.id;
  }

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
    // V1 retry-resume: a prior implementing session (this is a decline /
    // verify-fail redo) whose cache is still warm carries the whole working
    // context — resume it instead of re-deriving. First runs have none.
    const resumeSessionId = pickResumeSession(
      task,
      "implementing",
      effectiveModel("implementing"),
    );
    try {
      await runStage({
        stage: "implementing",
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
        appendAiComment(task.id, `implementing timed out after ${ttl}s — will retry`, "IMPLEMENTING");
        releaseClaim(task.id, workerId);
      }
      throw err;
    }

    // Post-runStage git + transition. Any throw here (commitAll/diff on a broken
    // worktree, a transition side-effect) must release the claim before it
    // escapes — the generic tick catch has no taskId to release with, so an
    // unreleased claim sits held for the full TTL and the task re-claims and
    // re-throws every cycle (a stuck loop). Release, then rethrow for backoff.
    try {
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
      // Persist the diff TEXT alongside the names: downstream AI-REVIEW and
      // VERIFYING read it from task_context() instead of re-deriving the same
      // bytes with their own fetch + git diff + file reads. Best-effort — a
      // diff failure must not fail the stage; downstream falls back to git.
      let diffText: string | null = null;
      try {
        diffText = await diffTextAgainstBase(
          task.worktree_path,
          project.default_branch,
        );
      } catch (err) {
        console.warn(`diff_text capture failed for ${task.id}:`, err);
      }
      db.update(tasks)
        .set({ affected_paths: diff, diff_text: diffText, updated_at: now() })
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

      // Docs-only change → skip the dynamic VERIFYING stage. Verify would only
      // re-read the markdown that AI-REVIEW already covers (proven duplication in
      // the batch data) — nothing is runnable. Decided on the REAL diff, not the
      // task text, so a code change that merely mentions "docs" is never
      // misrouted. AI-REVIEW still gates the prose. Only flips a still-default
      // skip_verify, and only when the entire diff is docs.
      if (!task.skip_verify && isDocsOnlyDiff(diff)) {
        db.update(tasks)
          .set({ skip_verify: true, updated_at: now() })
          .where(eq(tasks.id, task.id))
          .run();
        task.skip_verify = true;
        appendAiComment(
          task.id,
          "docs-only change — skipping dynamic verify; AI-REVIEW covers the prose.",
          "IMPLEMENTING",
        );
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
      // Event-driven chaining: kick the next stage's tick immediately instead
      // of waiting out the cron slot — keeps same-model hops inside the
      // prompt-cache TTL so V2 resumes actually hit warm cache. Fire-and-
      // forget; the tick has all its own guards (claims, stage_enabled,
      // backoff). Dynamic import dodges an import cycle with tick.ts.
      const nextStage =
        target === "AI-REVIEW" ? "ai_review" : target === "VERIFYING" ? "verify" : "publishing";
      void import("../tick").then((m) => m.tick(nextStage)).catch(() => {});
    } else {
      releaseClaim(task.id, workerId);
    }
    return task.id;
    } catch (err) {
      releaseClaim(task.id, workerId);
      throw err;
    }
  } finally {
    revokeToken(token);
  }
}

// Non-runnable documentation artifacts: a diff of only these has nothing for the
// dynamic VERIFYING stage to execute (AI-REVIEW still reads the prose).
const DOC_PATH_RE = /\.(md|mdx|markdown|txt|rst|adoc)$|(^|\/)(docs?|documentation)\//i;

/** True when the diff is non-empty AND every changed path is a doc artifact. */
export function isDocsOnlyDiff(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => DOC_PATH_RE.test(p));
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
