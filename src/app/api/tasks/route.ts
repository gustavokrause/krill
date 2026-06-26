import { and, asc, desc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { projects, tasks, type TaskStatus } from "@/db/schema";
import { apiErrorResponse, notFound, ruleViolation } from "@/lib/api/errors";
import {
  taskCreateSchema,
  taskListQuerySchema,
} from "@/lib/api/validation";
import { broadcast } from "@/lib/sse";
import { now } from "@/workflow/types";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const q = taskListQuerySchema.parse(Object.fromEntries(url.searchParams));
    const conds = [] as ReturnType<typeof eq>[];
    if (q.status) conds.push(eq(tasks.status, q.status as TaskStatus));
    if (q.project_id) conds.push(eq(tasks.project_id, q.project_id));

    const rows = db
      .select()
      .from(tasks)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(tasks.priority), desc(tasks.created_at))
      .limit(q.limit)
      .all();

    return NextResponse.json({ tasks: rows });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = taskCreateSchema.parse(await req.json());
    const ts = now();

    const task = db.transaction(
      (tx) => {
        const project = tx
          .select()
          .from(projects)
          .where(eq(projects.id, body.project_id))
          .get();
        if (!project) notFound("project not found");

        if (body.mode === "dev" && !project.has_repo) {
          ruleViolation(
            "mode=dev requires project.has_repo=true",
          );
        }

        const nextN = project.task_counter + 1;
        tx.update(projects)
          .set({ task_counter: nextN, updated_at: ts })
          .where(eq(projects.id, project.id))
          .run();

        const id = `${project.slug}-${nextN}`;
        const inserted = tx
          .insert(tasks)
          .values({
            id,
            project_id: project.id,
            name: body.name,
            description: body.description ?? "",
            priority: body.priority,
            status: "BACKLOG",
            mode: body.mode,
            depends_on: body.depends_on,
            conflicts_with: body.conflicts_with,
            affected_paths: body.affected_paths,
            skip_plan: body.skip_plan,
            skip_plan_review: body.skip_plan_review,
            skip_ai_review: body.skip_ai_review,
            // Default verify ON for dev (prove it runs), OFF for non-dev
            // (nothing to run) when the caller doesn't specify.
            skip_verify: body.skip_verify ?? body.mode !== "dev",
            acceptance: body.acceptance ?? null,
            est_tokens: body.est_tokens ?? null,
            auto_publish: body.auto_publish,
            create_pr: body.create_pr ?? null,
            push_remote: body.push_remote ?? null,
            merge_to_main: body.merge_to_main ?? null,
            draft_pr: body.draft_pr ?? null,
            created_at: ts,
            stage_entered_at: ts,
            updated_at: ts,
          })
          .returning()
          .all();
        return inserted[0];
      },
      { behavior: "immediate" },
    );

    broadcast({ type: "task.updated", task });
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

