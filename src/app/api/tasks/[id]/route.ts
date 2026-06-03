import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { apiErrorResponse, notFound } from "@/lib/api/errors";
import { taskPatchSchema } from "@/lib/api/validation";
import { broadcast } from "@/lib/sse";
import { now } from "@/workflow/types";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) notFound("task not found");
    return NextResponse.json({ task: row });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = taskPatchSchema.parse(await req.json());
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!existing) notFound("task not found");

    const updates = { updated_at: now(), ...body };
    const updated = db
      .update(tasks)
      .set(updates)
      .where(eq(tasks.id, id))
      .returning()
      .all();
    broadcast({ type: "task.updated", task: updated[0] });
    return NextResponse.json({ task: updated[0] });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = db.delete(tasks).where(eq(tasks.id, id)).run();
    if (result.changes === 0) notFound("task not found");
    broadcast({ type: "task.deleted", taskId: id });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
