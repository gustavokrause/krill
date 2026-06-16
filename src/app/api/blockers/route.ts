import { NextResponse, type NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { listBlockers } from "@/workflow/blockers";

// Open blockers — the unblock queue the board surfaces. ?all=1 for full history.
export async function GET(req: NextRequest) {
  try {
    const all = new URL(req.url).searchParams.get("all") === "1";
    return NextResponse.json({ blockers: listBlockers(all ? undefined : "open") });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
