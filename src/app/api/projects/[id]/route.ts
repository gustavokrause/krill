import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { apiErrorResponse, notFound } from "@/lib/api/errors";
import { detectHasRepo, resolveProjectPath } from "@/lib/api/util";
import { projectPatchSchema } from "@/lib/api/validation";
import { broadcast } from "@/lib/sse";
import { now } from "@/workflow/types";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) notFound("project not found");
    return NextResponse.json({ project: row });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = projectPatchSchema.parse(await req.json());
    const existing = db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    if (!existing) notFound("project not found");

    let folderPath = existing.folder_path;
    let hasRepo = existing.has_repo;
    if (body.folder_path !== undefined) {
      folderPath = resolveProjectPath(body.folder_path);
      hasRepo = body.has_repo ?? detectHasRepo(folderPath);
    } else if (body.has_repo !== undefined) {
      hasRepo = body.has_repo;
    }

    const updated = db
      .update(projects)
      .set({
        updated_at: now(),
        ...(body.name !== undefined ? { name: body.name } : {}),
        folder_path: folderPath,
        has_repo: hasRepo,
        ...(body.default_branch !== undefined
          ? { default_branch: body.default_branch }
          : {}),
        ...(body.max_parallel_tasks !== undefined
          ? { max_parallel_tasks: body.max_parallel_tasks }
          : {}),
        ...(body.paused !== undefined ? { paused: body.paused } : {}),
        ...(body.create_pr !== undefined ? { create_pr: body.create_pr } : {}),
        ...(body.push_remote !== undefined
          ? { push_remote: body.push_remote }
          : {}),
        ...(body.merge_to_main !== undefined
          ? { merge_to_main: body.merge_to_main }
          : {}),
        ...(body.allow_auto_finish !== undefined
          ? { allow_auto_finish: body.allow_auto_finish }
          : {}),
        ...(body.delete_branch_on_done !== undefined
          ? { delete_branch_on_done: body.delete_branch_on_done }
          : {}),
        ...(body.draft_pr !== undefined ? { draft_pr: body.draft_pr } : {}),
      })
      .where(eq(projects.id, id))
      .returning()
      .all();
    broadcast({ type: "project.updated", project: updated[0] });
    return NextResponse.json({ project: updated[0] });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = db.delete(projects).where(eq(projects.id, id)).run();
    if (result.changes === 0) notFound("project not found");
    broadcast({ type: "project.deleted", projectId: id });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
