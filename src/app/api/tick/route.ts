import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api/errors";
import { tick } from "@/workflow/tick";
import { STAGES } from "@/workflow/types";

const querySchema = z.object({
  stage: z.enum(STAGES as [string, ...string[]]).optional(),
  loop: z.coerce.boolean().optional(),
});

/**
 * Manual tick endpoint. Spike helper: fire one stage tick at a time, or
 * `?loop=1` to walk a freshly-picked TODO all the way to HUMAN-REVIEW.
 * Real cron registration arrives in phase 11.
 */
export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const q = querySchema.parse(Object.fromEntries(url.searchParams));

    if (q.stage && !q.loop) {
      const result = await tick(q.stage as (typeof STAGES)[number]);
      return NextResponse.json(result);
    }

    if (q.loop) {
      const trace: unknown[] = [];
      for (const stage of [
        "todo_picker",
        "planning",
        "implementing",
        "ai_review",
        "verify",
        "publishing",
      ] as const) {
        const result = await tick(stage);
        trace.push({ stage, ...result });
        if (!("ran" in result) || !result.ran) break;
      }
      return NextResponse.json({ trace });
    }

    return NextResponse.json(
      { error: { code: "validation_failed", message: "missing ?stage or ?loop=1" } },
      { status: 400 },
    );
  } catch (err) {
    return apiErrorResponse(err);
  }
}
