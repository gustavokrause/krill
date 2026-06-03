import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { getHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getHealth());
  } catch (err) {
    return apiErrorResponse(err);
  }
}
