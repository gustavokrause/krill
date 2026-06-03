import { NextResponse } from "next/server";
import { listenerCount } from "@/lib/sse";

/**
 * Debug probe — returns the current SSE listener count so test scripts
 * can verify that abort cleanup unsubscribed correctly.
 */
export async function GET() {
  return NextResponse.json({ listeners: listenerCount() });
}
