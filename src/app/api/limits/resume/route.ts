import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { forceResume } from "@/workflow/limit-guard";
import { computeLimitsView } from "@/lib/limits-view";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const restored = forceResume();
    return NextResponse.json({ restored, view: computeLimitsView() });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
