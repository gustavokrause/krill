import { NextResponse, type NextRequest } from "next/server";
import { apiErrorResponse, notFound, ruleViolation } from "@/lib/api/errors";
import { getBlocker, resolveBlocker } from "@/workflow/blockers";

// resolve = cleared + unblock the task so the next tick re-runs the stage.
// dismiss = clear the blocker but leave the task blocked.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) {
  try {
    const { id, action } = await ctx.params;
    if (!getBlocker(id)) notFound("blocker not found");
    if (action !== "resolve" && action !== "dismiss") ruleViolation(`unknown action "${action}"`);
    const status = action === "dismiss" ? "dismissed" : "resolved";
    const b = resolveBlocker(id, status);
    return NextResponse.json({ ok: true, blocker: b, resumed: action === "resolve" });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
