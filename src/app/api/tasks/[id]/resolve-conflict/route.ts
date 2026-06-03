import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { comments, projects, tasks } from "@/db/schema";
import {
  abortMerge,
  commitMerge,
  mergeOriginInto,
  pushMerge,
  resetWorktreeToOriginBranch,
} from "@/git";
import { apiErrorResponse, invalidState, notFound } from "@/lib/api/errors";
import { broadcast } from "@/lib/sse";
import { getClaimTtl } from "@/workflow/stages/context";
import { attemptAiConflictResolve } from "@/workflow/stages/publishing";
import { MANUAL_AI_COMMENT_PREFIX } from "@/workflow/loop-brake";
import { releaseClaim, transitionStatus } from "@/workflow/transition";
import { now } from "@/workflow/types";

type Ctx = { params: Promise<{ id: string }> };

// Per-task "Solve with Sonnet" CTA. Recreates the conflict on the worktree
// and re-runs the AI conflict resolver without incrementing the brake
// counter. The PUBLISHING cron does NOT pick up NEEDS_REVIEW tasks (it
// filters on status='PUBLISHING'), so this endpoint cannot race the cron
// mid-tick on the same task. The claim guard catches concurrent human clicks.
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ttl = getClaimTtl("publishing");
    const ts = now();
    const expiry = ts + ttl;
    const workerId = `resolve-conflict-${randomUUID()}`;

    // Atomic claim: only proceed when task is NEEDS_REVIEW(conflict) AND
    // not currently claimed. Same shape as workflow/claim.ts.
    const claimed = db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, id))
          .get();
        if (!existing) return { error: "not_found" as const };
        if (
          existing.status !== "NEEDS_REVIEW" ||
          existing.pending_review_kind !== "conflict"
        ) {
          return { error: "wrong_state" as const, existing };
        }
        const updated = tx
          .update(tasks)
          .set({
            claimed_until: expiry,
            claimed_by: workerId,
            updated_at: ts,
          })
          .where(
            and(
              eq(tasks.id, id),
              eq(tasks.status, "NEEDS_REVIEW"),
              eq(tasks.pending_review_kind, "conflict"),
              or(isNull(tasks.claimed_until), lt(tasks.claimed_until, ts)),
            ),
          )
          .returning()
          .all();
        if (updated.length !== 1) return { error: "claim_lost" as const };
        return { task: updated[0] };
      },
      { behavior: "immediate" },
    );

    if ("error" in claimed) {
      if (claimed.error === "not_found") notFound("task not found");
      if (claimed.error === "wrong_state") {
        invalidState(
          "task is not in NEEDS_REVIEW(conflict); resolve-conflict not applicable",
        );
      }
      invalidState("task is currently claimed; retry");
    }

    const task = claimed.task!;
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.id, task.project_id))
      .get();
    if (!project) {
      releaseClaim(task.id, workerId);
      notFound("project not found");
    }
    if (!task.worktree_path || !task.branch) {
      releaseClaim(task.id, workerId);
      invalidState("task is missing worktree/branch; cannot resolve");
    }

    void runResolveInBackground({
      taskId: task.id,
      workerId,
      ttl,
      worktreePath: task.worktree_path!,
      taskBranch: task.branch!,
      defaultBranch: project!.default_branch,
    });

    // 202 Accepted — work runs after response. Return the claimed task
    // snapshot so the client can render the busy state.
    const snapshot = db.select().from(tasks).where(eq(tasks.id, task.id)).get();
    return NextResponse.json({ task: snapshot }, { status: 202 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

async function runResolveInBackground(opts: {
  taskId: string;
  workerId: string;
  ttl: number;
  worktreePath: string;
  taskBranch: string;
  defaultBranch: string;
}): Promise<void> {
  try {
    // Idempotent sync — picks up any human-side resolution pushed to GitHub.
    await resetWorktreeToOriginBranch(opts.worktreePath, opts.taskBranch);

    const merge = await mergeOriginInto(opts.worktreePath, opts.defaultBranch);
    if (merge.ok) {
      // No conflict to resolve — clean merge, push and move on.
      await pushMerge(opts.worktreePath, opts.taskBranch);
      appendManualAiComment(opts.taskId, "no conflict detected after sync — clean merge, resuming PUBLISHING");
      moveBackToPublishing(opts.taskId, opts.workerId);
      return;
    }

    const resolved = await attemptAiConflictResolve(opts.taskId, opts.ttl, {
      manual: true,
    });
    if (resolved) {
      try {
        await commitMerge(
          opts.worktreePath,
          `merge origin/${opts.defaultBranch} into ${opts.taskBranch}`,
        );
        await pushMerge(opts.worktreePath, opts.taskBranch);
        appendManualAiComment(opts.taskId, `conflict resolved by Sonnet — merged origin/${opts.defaultBranch} into ${opts.taskBranch}, resuming PUBLISHING`);
        moveBackToPublishing(opts.taskId, opts.workerId);
        return;
      } catch (err) {
        appendManualAiComment(
          opts.taskId,
          `conflict commit failed: ${(err as Error).message}`,
        );
        await abortMerge(opts.worktreePath);
      }
    } else {
      await abortMerge(opts.worktreePath);
    }

    appendManualAiComment(
      opts.taskId,
      `conflict resolution failed: ${merge.conflictedFiles.join(", ")}`,
    );
    releaseClaim(opts.taskId, opts.workerId);
  } catch (err) {
    appendManualAiComment(
      opts.taskId,
      `resolve-conflict runner crashed: ${(err as Error).message}`,
    );
    releaseClaim(opts.taskId, opts.workerId);
  }
}

function moveBackToPublishing(taskId: string, workerId: string): void {
  const moved = transitionStatus({
    taskId,
    from: "NEEDS_REVIEW",
    to: "PUBLISHING",
  });
  if (!moved) {
    releaseClaim(taskId, workerId);
  }
}

function appendManualAiComment(taskId: string, text: string): void {
  const inserted = db
    .insert(comments)
    .values({
      id: randomUUID(),
      task_id: taskId,
      at: now(),
      stage: "NEEDS_REVIEW",
      author: "ai",
      text: `${MANUAL_AI_COMMENT_PREFIX}${text}`,
    })
    .returning()
    .all();
  db.update(tasks)
    .set({ updated_at: now() })
    .where(eq(tasks.id, taskId))
    .run();
  if (inserted[0]) broadcast({ type: "comment.appended", comment: inserted[0] });
}
