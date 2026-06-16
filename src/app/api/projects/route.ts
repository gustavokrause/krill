import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { apiErrorResponse, ruleViolation } from "@/lib/api/errors";
import { detectDefaultBranch, detectHasRepo, resolveProjectPath } from "@/lib/api/util";
import { projectCreateSchema } from "@/lib/api/validation";
import { broadcast } from "@/lib/sse";
import { now } from "@/workflow/types";

export async function GET() {
  try {
    const rows = db.select().from(projects).orderBy(asc(projects.slug)).all();
    return NextResponse.json({ projects: rows });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = projectCreateSchema.parse(await req.json());
    const ts = now();
    const folder_path = resolveProjectPath(body.folder_path);
    const has_repo = body.has_repo ?? detectHasRepo(folder_path);
    // Empty/omitted default branch → read it from the repo, else fall back to main.
    const default_branch =
      body.default_branch?.trim() ||
      detectDefaultBranch(folder_path) ||
      "main";

    try {
      const inserted = db
        .insert(projects)
        .values({
          id: randomUUID(),
          name: body.name,
          slug: body.slug,
          folder_path,
          has_repo,
          default_branch,
          max_parallel_tasks: body.max_parallel_tasks ?? 1,
          paused: body.paused ?? false,
          create_pr: body.create_pr ?? null,
          push_remote: body.push_remote ?? null,
          merge_to_main: body.merge_to_main ?? null,
          allow_auto_finish: body.allow_auto_finish ?? false,
          delete_branch_on_done: body.delete_branch_on_done ?? true,
          draft_pr: body.draft_pr ?? false,
          task_counter: 0,
          created_at: ts,
          updated_at: ts,
        })
        .returning()
        .all();
      broadcast({ type: "project.updated", project: inserted[0] });
      return NextResponse.json({ project: inserted[0] }, { status: 201 });
    } catch (err) {
      if (err instanceof Error && /UNIQUE.*slug/i.test(err.message)) {
        ruleViolation("slug already in use");
      }
      throw err;
    }
  } catch (err) {
    return apiErrorResponse(err);
  }
}

