import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { apiErrorResponse, notFound, ruleViolation } from "@/lib/api/errors";
import { forceReleaseClaim } from "@/workflow/transition";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Recover an orphaned-claim task: force-release the dead worker's claim so the
 * next stage tick re-picks it immediately (instead of waiting out the claim
 * TTL). Status is untouched — the task re-runs the stage it was stranded in.
 * forceReleaseClaim broadcasts task.updated so the board clears the badge live.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) notFound("task not found");
    if (row.claimed_by == null) {
      ruleViolation("task has no active claim to recover");
    }
    forceReleaseClaim(id);
    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return NextResponse.json({ task: updated, recovered: true });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
