import { NextResponse, type NextRequest } from "next/server";
import { apiErrorResponse, notFound } from "@/lib/api/errors";
import { consumeFollowup } from "@/workflow/followups";

export const dynamic = "force-dynamic";

// Mark a follow-up consumed once whale has ingested it into its inbox.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!consumeFollowup(id)) notFound("follow-up not found");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
