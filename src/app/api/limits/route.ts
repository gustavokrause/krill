import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { computeLimitsView } from "@/lib/limits-view";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(computeLimitsView());
  } catch (err) {
    return apiErrorResponse(err);
  }
}
