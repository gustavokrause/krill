import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { comments, projects, tasks } from "@/db/schema";
import { addPrComment, closePr, deleteLocalBranch, deleteRemoteBranch } from "@/git";
import {
  apiErrorResponse,
  invalidState,
  notFound,
} from "@/lib/api/errors";
import { taskTransitionSchema } from "@/lib/api/validation";
import { broadcast } from "@/lib/sse";
import { finishMerge } from "@/workflow/finish";
import { cancelDependentsCascade, tripAutoFinishBreaker } from "@/workflow/breaker";
import { applyTransitionSideEffects } from "@/workflow/cleanup";
import { transitionStatus } from "@/workflow/transition";
import { now } from "@/workflow/types";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = taskTransitionSchema.parse(await req.json());

    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!existing) notFound("task not found");

    const from = body.from ?? existing.status;
    if (existing.status !== from) {
      invalidState(
        `task is in status '${existing.status}', not '${from}'`,
      );
    }

    const startedAt =
      from === "TODO" && body.to === "PLANNING" && existing.started_at == null
        ? now()
        : undefined;
    const endedAt =
      body.to === "DONE" || body.to === "CANCELED" ? now() : undefined;

    // NEEDS_REVIEW(deliverable) approve on a repo project triggers PR merge
    // BEFORE we flip status — so the merge failure surfaces as 409 to the
    // caller instead of leaving the task DONE without a merged PR.
    if (
      from === "NEEDS_REVIEW" &&
      existing.pending_review_kind === "deliverable" &&
      body.to === "DONE" &&
      existing.delivery_url
    ) {
      const project = db
        .select()
        .from(projects)
        .where(eq(projects.id, existing.project_id))
        .get();
      if (project?.has_repo) {
        try {
          await finishMerge(existing, project);
        } catch (err) {
          invalidState(`merge failed: ${(err as Error).message}`);
        }
      }
    }

    const moved = transitionStatus({
      taskId: id,
      from,
      to: body.to,
      startedAt,
      endedAt,
    });
    if (!moved) {
      invalidState("status changed concurrently; retry");
    }

    if (body.comment) {
      const inserted = db
        .insert(comments)
        .values({
          id: randomUUID(),
          task_id: id,
          at: now(),
          stage: from,
          author: body.comment.author,
          text: body.comment.text,
        })
        .returning()
        .all();
      if (inserted[0]) {
        broadcast({ type: "comment.appended", comment: inserted[0] });
      }

      // Post human decline note to the PR so the review context is visible on GitHub.
      // Applies to NEEDS_REVIEW exits where a PR exists (deliverable or conflict kind).
      if (
        from === "NEEDS_REVIEW" &&
        (existing.pending_review_kind === "deliverable" ||
          existing.pending_review_kind === "conflict") &&
        body.to !== "DONE" &&
        existing.delivery_url &&
        /^https?:\/\//.test(existing.delivery_url)
      ) {
        const project = db
          .select()
          .from(projects)
          .where(eq(projects.id, existing.project_id))
          .get();
        if (project?.has_repo) {
          try {
            await addPrComment(project.folder_path, existing.delivery_url, body.comment.text);
          } catch (err) {
            console.warn(`pr comment failed for ${id}:`, err);
          }
        }
      }
    }

    await applyTransitionSideEffects(id, from, body.to);

    // Cancel-time PR/branch teardown — only when the human explicitly opted in
    // via cancel_options. Runs AFTER applyTransitionSideEffects so the worktree
    // is already gone before we attempt branch delete. PR close first (needs the
    // remote branch to exist); branch delete second. Both non-fatal.
    if (body.to === "CANCELED" && body.cancel_options) {
      const cancelProject = db
        .select()
        .from(projects)
        .where(eq(projects.id, existing.project_id))
        .get();
      if (cancelProject?.has_repo) {
        const { close_pr, delete_branch } = body.cancel_options;
        if (close_pr && existing.delivery_url && /^https?:\/\//.test(existing.delivery_url)) {
          try {
            await closePr(cancelProject.folder_path, existing.delivery_url);
          } catch (err) {
            console.warn(`cancel: pr close failed for ${id}:`, err);
          }
        }
        if (delete_branch && existing.branch) {
          try {
            await deleteLocalBranch(cancelProject.folder_path, existing.branch);
          } catch (err) {
            console.warn(`cancel: local branch delete failed for ${id}:`, err);
          }
          try {
            await deleteRemoteBranch(cancelProject.folder_path, existing.branch);
          } catch (err) {
            console.warn(`cancel: remote branch delete failed for ${id}:`, err);
          }
        }
      }
    }

    // A3: declining/cancelling a task cancels its dependent subtree, and counts
    // toward the project's auto-finish failure budget (breaker).
    if (body.to === "CANCELED") {
      cancelDependentsCascade(id, `upstream task ${id} canceled`);
      tripAutoFinishBreaker(existing.project_id, id);
    }

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return NextResponse.json({ task: updated });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
