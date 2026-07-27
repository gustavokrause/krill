import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { readUsageLimits } from "@/claude/limits";
import { computeLimitsView } from "@/lib/limits-view";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  try {
    await readUsageLimits();
    return NextResponse.json(computeLimitsView());
  } catch (err) {
    return apiErrorResponse(err);
  }
}
