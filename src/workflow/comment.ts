import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { comments, tasks, type TaskStatus } from "@/db/schema";
import { broadcast } from "@/lib/sse";
import { now } from "./types";

export function appendAiComment(
  taskId: string,
  text: string,
  stage: TaskStatus = "PUBLISHING",
): void {
  const inserted = db
    .insert(comments)
    .values({
      id: randomUUID(),
      task_id: taskId,
      at: now(),
      stage,
      author: "ai",
      text,
    })
    .returning()
    .all();
  db.update(tasks)
    .set({ updated_at: now() })
    .where(eq(tasks.id, taskId))
    .run();
  if (inserted[0]) broadcast({ type: "comment.appended", comment: inserted[0] });
}
