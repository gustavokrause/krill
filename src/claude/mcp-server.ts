/**
 * MCP server skeleton. The tool implementations live in mcp-tools.ts and
 * are already invoked in-process by the stub runner (phase 06).
 *
 * Wiring real Claude Code via @modelcontextprotocol/sdk requires an HTTP
 * (or stdio) transport. Phase 05 spike intentionally stops here — phase
 * 06 real-runner work will add `/api/mcp/route.ts` that bridges incoming
 * JSON-RPC requests to the typed tool functions below, using the bearer
 * token to look up McpAuthContext via mcp-auth.ts.
 */

import {
  task_append_comment,
  task_context,
  task_decide,
  task_seed_followup,
  task_set_affected_paths,
  task_set_checklist,
  task_set_plan,
} from "./mcp-tools";
import type { McpAuthContext } from "./mcp-auth";

export type ToolName =
  | "task_context"
  | "task_set_plan"
  | "task_set_checklist"
  | "task_set_affected_paths"
  | "task_append_comment"
  | "task_decide"
  | "task_seed_followup";

export const TOOL_REGISTRY = {
  task_context: (ctx: McpAuthContext) => task_context(ctx),
  task_set_plan: (ctx: McpAuthContext, args: { plan: string }) =>
    task_set_plan(ctx, args.plan),
  task_set_checklist: (ctx: McpAuthContext, args: { checklist: string }) =>
    task_set_checklist(ctx, args.checklist),
  task_set_affected_paths: (
    ctx: McpAuthContext,
    args: { paths: string[] },
  ) => task_set_affected_paths(ctx, args.paths),
  task_append_comment: (
    ctx: McpAuthContext,
    args: { stage: Parameters<typeof task_append_comment>[1]; text: string },
  ) => task_append_comment(ctx, args.stage, args.text),
  task_decide: (
    ctx: McpAuthContext,
    args: { outcome: "approve" | "decline"; reason: string },
  ) => task_decide(ctx, args.outcome, args.reason),
  task_seed_followup: (
    ctx: McpAuthContext,
    args: { title: string; description?: string },
  ) => task_seed_followup(ctx, args.title, args.description),
} as const;
