// Append-only log of krill MCP tool calls + read-side rollups. One row per
// tools/call dispatch — the instrument for tuning prompt persistence later (each
// tool call is one agentic turn). Write must never break a tool call, so it
// swallows its own errors.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { toolCalls } from "@/db/schema";
import { now } from "@/workflow/types";

export function logToolCall(taskId: string, stage: string, tool: string): void {
  try {
    db.insert(toolCalls)
      .values({ id: randomUUID(), task_id: taskId, stage, tool, created_at: now() })
      .run();
  } catch {
    // Instrumentation is best-effort — never let it fail a real tool call.
  }
}

export type ToolCallStat = { stage: string; tool: string; calls: number };

/** Per-(stage,tool) call counts. Scope to one task, or omit for fleet-wide. */
export function getToolCallStats(taskId?: string): ToolCallStat[] {
  const base = db
    .select({
      stage: toolCalls.stage,
      tool: toolCalls.tool,
      calls: sql<number>`count(*)`,
    })
    .from(toolCalls);
  return (taskId ? base.where(eq(toolCalls.task_id, taskId)) : base)
    .groupBy(toolCalls.stage, toolCalls.tool)
    .orderBy(sql`count(*) desc`)
    .all();
}
