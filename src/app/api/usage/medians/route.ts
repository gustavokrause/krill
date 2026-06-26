import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { getStageMedians } from "@/lib/usage-rollups";

export const dynamic = "force-dynamic";

// Per-stage median token cost, consumed by whale to pre-estimate a task's spend
// (sum of medians for the stages it will run). Returns `{ medians: { stage: n } }`.
export async function GET() {
  try {
    return NextResponse.json({ medians: getStageMedians() });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
