import { NextResponse, type NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { getTaskStageUsage } from "@/lib/usage-rollups";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// Per-stage token breakdown for the task detail "Usage" tab. Re-runs of a stage
// are summed into one row (see getTaskStageUsage); empty array = nothing metered.
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ stages: getTaskStageUsage(id) });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
