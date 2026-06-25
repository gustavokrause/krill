import { and, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { apiErrorResponse } from "@/lib/api/errors";
import { cleanupQuerySchema } from "@/lib/api/validation";
import { termRange, type TermWindow } from "@/lib/term-window";
import { broadcast } from "@/lib/sse";

const TERMINAL_STATUSES = ["DONE", "CANCELED"] as const;

function terminalsInWindowFilter(window: TermWindow) {
  const { start, end } = termRange(window);
  const conditions = [
    inArray(tasks.status, [...TERMINAL_STATUSES]),
    isNotNull(tasks.ended_at),
  ];
  if (isFinite(start)) conditions.push(gte(tasks.ended_at, start));
  if (isFinite(end)) conditions.push(lt(tasks.ended_at, end));
  return and(...conditions);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const { window } = cleanupQuerySchema.parse({
      window: searchParams.get("window"),
    });
    const rows = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(terminalsInWindowFilter(window))
      .all();
    return NextResponse.json({ count: rows.length, window });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { window } = cleanupQuerySchema.parse(body);

    const ids = db.transaction(() => {
      const rows = db
        .select({ id: tasks.id })
        .from(tasks)
        .where(terminalsInWindowFilter(window))
        .all();
      if (rows.length === 0) return [];
      db.delete(tasks)
        .where(
          inArray(
            tasks.id,
            rows.map((r) => r.id),
          ),
        )
        .run();
      return rows.map((r) => r.id);
    });

    for (const taskId of ids) {
      broadcast({ type: "task.deleted", taskId });
    }

    return NextResponse.json({ deleted: ids.length, window });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
