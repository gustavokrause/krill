import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { listOpenFollowups } from "@/workflow/followups";

export const dynamic = "force-dynamic";

// Open follow-ups the strategy layer (whale) pulls into its inbox, then consumes.
export async function GET() {
  try {
    return NextResponse.json({ followups: listOpenFollowups() });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
