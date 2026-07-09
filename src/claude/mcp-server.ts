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
  task_set_acceptance,
  task_set_affected_paths,
  task_set_checklist,
  task_set_plan,
  task_set_plan_bundle,
  task_set_plan_summary,
  task_verify,
  task_escalate,
  task_resolve,
} from "./mcp-tools";
import type { McpAuthContext } from "./mcp-auth";

export type ToolName =
  | "task_context"
  | "task_set_plan"
  | "task_set_plan_bundle"
  | "task_set_plan_summary"
  | "task_set_acceptance"
  | "task_set_checklist"
  | "task_set_affected_paths"
  | "task_append_comment"
  | "task_decide"
  | "task_verify"
  | "task_escalate"
  | "task_resolve"
  | "task_seed_followup";

export const TOOL_REGISTRY = {
  task_context: (ctx: McpAuthContext) => task_context(ctx),
  task_set_plan: (ctx: McpAuthContext, args: { plan: string }) =>
    task_set_plan(ctx, args.plan),
  task_set_plan_bundle: (
    ctx: McpAuthContext,
    args: {
      plan: string;
      plan_summary: string;
      checklist: string;
      affected_paths: string[];
      acceptance?: string;
    },
  ) => task_set_plan_bundle(ctx, args),
  task_set_plan_summary: (ctx: McpAuthContext, args: { plan_summary: string }) =>
    task_set_plan_summary(ctx, args.plan_summary),
  task_set_acceptance: (ctx: McpAuthContext, args: { acceptance: string }) =>
    task_set_acceptance(ctx, args.acceptance),
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
    args: { outcome: "approve" | "decline"; reason: string; static_sufficient?: boolean },
  ) => task_decide(ctx, args.outcome, args.reason, args.static_sufficient ?? false),
  task_verify: (
    ctx: McpAuthContext,
    args: { outcome: "pass" | "fail"; reason: string; evidence?: string },
  ) => task_verify(ctx, args.outcome, args.reason, args.evidence),
  task_escalate: (
    ctx: McpAuthContext,
    args: { question: string; options?: string[]; evidence?: string },
  ) => task_escalate(ctx, args.question, args.options ?? [], args.evidence),
  task_resolve: (
    ctx: McpAuthContext,
    args: { outcome: "decided" | "defer"; decision?: string; rationale?: string },
  ) => task_resolve(ctx, args.outcome, args.decision ?? "", args.rationale),
  task_seed_followup: (
    ctx: McpAuthContext,
    args: { title: string; description?: string },
  ) => task_seed_followup(ctx, args.title, args.description),
} as const;
