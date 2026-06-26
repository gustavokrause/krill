import { NextResponse, type NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { getToolCallStats } from "@/lib/tool-log";

export const dynamic = "force-dynamic";

// Per-(stage,tool) MCP call counts — the bookkeeping-turn meter for tuning prompt
// persistence. `?task_id=` scopes to one task; omit for fleet-wide.
export async function GET(req: NextRequest) {
  try {
    const taskId = new URL(req.url).searchParams.get("task_id") ?? undefined;
    return NextResponse.json({ stats: getToolCallStats(taskId) });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
