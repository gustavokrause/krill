import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { comments, tasks } from "@/db/schema";
import { apiErrorResponse, notFound } from "@/lib/api/errors";
import { commentCreateSchema } from "@/lib/api/validation";
import { broadcast } from "@/lib/sse";
import { now } from "@/workflow/types";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exists = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();
    if (!exists) notFound("task not found");

    const rows = db
      .select()
      .from(comments)
      .where(eq(comments.task_id, id))
      .orderBy(asc(comments.at))
      .all();
    return NextResponse.json({ comments: rows });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const exists = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();
    if (!exists) notFound("task not found");

    const body = commentCreateSchema.parse(await req.json());
    const inserted = db
      .insert(comments)
      .values({
        id: randomUUID(),
        task_id: id,
        at: now(),
        stage: body.stage,
        author: body.author,
        text: body.text,
      })
      .returning()
      .all();

    db.update(tasks)
      .set({ updated_at: now() })
      .where(eq(tasks.id, id))
      .run();

    broadcast({ type: "comment.appended", comment: inserted[0] });
    const refreshed = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (refreshed) broadcast({ type: "task.updated", task: refreshed });

    return NextResponse.json({ comment: inserted[0] }, { status: 201 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
