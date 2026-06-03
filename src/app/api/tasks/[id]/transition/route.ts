import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { comments, projects, tasks } from "@/db/schema";
import { addPrComment, mergePr } from "@/git";
import {
  apiErrorResponse,
  invalidState,
  notFound,
} from "@/lib/api/errors";
import { taskTransitionSchema } from "@/lib/api/validation";
import { broadcast } from "@/lib/sse";
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
          await mergePr(project.folder_path, existing.delivery_url, "squash");
        } catch (err) {
          invalidState(`pr merge failed: ${(err as Error).message}`);
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

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return NextResponse.json({ task: updated });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
