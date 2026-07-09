import { NextResponse, type NextRequest } from "next/server";
import {
  McpAuthError,
} from "@/claude/errors";
import { resolveToken, type McpAuthContext } from "@/claude/mcp-auth";
import { TOOL_REGISTRY } from "@/claude/mcp-server";
import { TASK_STATUSES } from "@/db/schema";
import { logToolCall } from "@/lib/tool-log";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "krill",
  version: "0.1.0",
};

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

const TOOL_DEFINITIONS = [
  {
    name: "task_context",
    description:
      "Read the current task, its project, plan, checklist, comments, affected_paths, and any peer tasks' affected_paths overlap.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "task_set_plan",
    description:
      "Overwrite the task's plan (markdown). Valid only during PLANNING.",
    inputSchema: {
      type: "object",
      properties: { plan: { type: "string" } },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  {
    name: "task_set_plan_bundle",
    description:
      "PREFERRED for PLANNING: persist the whole plan in ONE call instead of 5 separate ones (each separate call is a wasted agentic turn). Writes plan, plan_summary, checklist, and affected_paths together; pass acceptance ONLY when task_context shows it empty (never overwrite an existing one). Valid only during PLANNING.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "the canonical plan (markdown)" },
        plan_summary: { type: "string", description: "short plain-language summary" },
        checklist: { type: "string", description: "checklist markdown using `[ ]` / `[x]`" },
        affected_paths: { type: "array", items: { type: "string" }, description: "files to modify/create, relative to project.folder_path" },
        acceptance: { type: "string", description: "concrete runnable definition-of-done; omit when one already exists" },
      },
      required: ["plan", "plan_summary", "checklist", "affected_paths"],
      additionalProperties: false,
    },
  },
  {
    name: "task_set_plan_summary",
    description:
      "Write a short plain-language summary of the plan during PLANNING. Call this AFTER task_set_plan — it writes tasks.plan_summary and never touches tasks.plan. Valid only during PLANNING. (Prefer task_set_plan_bundle to do this in one call.)",
    inputSchema: {
      type: "object",
      properties: { plan_summary: { type: "string" } },
      required: ["plan_summary"],
      additionalProperties: false,
    },
  },
  {
    name: "task_set_acceptance",
    description:
      "Set the task's acceptance: a concrete, checkable definition-of-done that VERIFYING runs the change against (e.g. \"after a test-mode checkout, the tenant's plan = the purchased tier\"). Valid only during PLANNING. Only call this when task_context shows acceptance is empty — never overwrite an existing value (it was set deliberately upstream or by a human).",
    inputSchema: {
      type: "object",
      properties: { acceptance: { type: "string" } },
      required: ["acceptance"],
      additionalProperties: false,
    },
  },
  {
    name: "task_set_checklist",
    description:
      "Overwrite the task's checklist (markdown with `[ ]` / `[~]` / `[x]`).",
    inputSchema: {
      type: "object",
      properties: { checklist: { type: "string" } },
      required: ["checklist"],
      additionalProperties: false,
    },
  },
  {
    name: "task_set_affected_paths",
    description:
      "Replace the task's affected_paths list. Paths are normalized relative to project.folder_path.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "task_append_comment",
    description:
      "Append an AI-authored comment tagged with the given stage. Append-only — no edit or delete.",
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "string", enum: [...TASK_STATUSES] },
        text: { type: "string" },
      },
      required: ["stage", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "task_decide",
    description:
      "AI-REVIEW decision. outcome='approve' transitions to VERIFYING (or straight to PUBLISHING when skip_verify is set). outcome='decline' transitions back to IMPLEMENTING; if max_ai_decline_cycles is reached the task parks at NEEDS_REVIEW(deliverable) for a human (it is NOT forced forward). Valid only during AI-REVIEW.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["approve", "decline"] },
        reason: { type: "string" },
        static_sufficient: {
          type: "boolean",
          description:
            "Approve only: true when the diff is fully static (types, comments, constants, markup/config without logic) and this review already covers everything a dynamic run would show — skips the VERIFYING spawn. Never set it for behavior/logic changes.",
        },
      },
      required: ["outcome"],
      additionalProperties: false,
    },
  },
  {
    name: "task_verify",
    description:
      "VERIFYING decision. Report whether the change RUNS and meets its acceptance — do NOT fix code here. outcome='pass' transitions to PUBLISHING. outcome='fail' transitions back to IMPLEMENTING with your reason as the next instruction (or parks at NEEDS_REVIEW if max cycles is reached). Valid only during VERIFYING.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["pass", "fail"] },
        reason: { type: "string", description: "what you checked and the verdict" },
        evidence: { type: "string", description: "commands run + key output proving the result" },
      },
      required: ["outcome", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "task_escalate",
    description:
      "Escalate a genuine judgment fork you can't resolve from context — an ambiguous requirement, two defensible architectures, a dependency direction you'd be guessing. Do NOT guess: call this instead of proceeding. State a tight question, the candidate options, and the evidence you have. The task parks for a higher-effort decision pass, then a human if needed. Valid in planning/implementing/ai_review/verify.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "the specific fork, phrased as one decidable question" },
        options: { type: "array", items: { type: "string" }, description: "the candidate answers you're torn between" },
        evidence: { type: "string", description: "what you found that's relevant + why you can't decide" },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "task_resolve",
    description:
      "Answer an escalated question (resolver pass only). outcome='decided' picks an option and sends the task back to its origin stage with your decision. outcome='defer' means it genuinely needs human/business context you can't derive — it stays for a human. Valid only on a NEEDS_REVIEW(question) task.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["decided", "defer"] },
        decision: { type: "string", description: "the chosen option (required for 'decided')" },
        rationale: { type: "string", description: "why — grounded in the evidence/repo" },
      },
      required: ["outcome"],
      additionalProperties: false,
    },
  },
  {
    name: "task_seed_followup",
    description:
      "Flag out-of-scope follow-up work you noticed but did NOT do (keep THIS task tightly scoped — don't do it here). Records a follow-up for the strategy layer (whale) to pull in and plan; does NOT create a krill task. Use one call per distinct follow-up.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "short imperative title" },
        description: { type: "string", description: "what + where (files/paths), why it's needed" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
] as const;

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function authFromRequest(req: NextRequest): McpAuthContext | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  return resolveToken(m[1].trim());
}

function callTool(
  ctx: McpAuthContext,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case "task_context":
      return TOOL_REGISTRY.task_context(ctx);
    case "task_set_plan":
      return TOOL_REGISTRY.task_set_plan(ctx, args as { plan: string });
    case "task_set_plan_bundle":
      return TOOL_REGISTRY.task_set_plan_bundle(
        ctx,
        args as {
          plan: string;
          plan_summary: string;
          checklist: string;
          affected_paths: string[];
          acceptance?: string;
        },
      );
    case "task_set_plan_summary":
      return TOOL_REGISTRY.task_set_plan_summary(
        ctx,
        args as { plan_summary: string },
      );
    case "task_set_acceptance":
      return TOOL_REGISTRY.task_set_acceptance(
        ctx,
        args as { acceptance: string },
      );
    case "task_set_checklist":
      return TOOL_REGISTRY.task_set_checklist(
        ctx,
        args as { checklist: string },
      );
    case "task_set_affected_paths":
      return TOOL_REGISTRY.task_set_affected_paths(
        ctx,
        args as { paths: string[] },
      );
    case "task_append_comment":
      return TOOL_REGISTRY.task_append_comment(
        ctx,
        args as { stage: Parameters<typeof TOOL_REGISTRY.task_append_comment>[1]["stage"]; text: string },
      );
    case "task_decide":
      return TOOL_REGISTRY.task_decide(
        ctx,
        args as { outcome: "approve" | "decline"; reason: string; static_sufficient?: boolean },
      );
    case "task_verify":
      return TOOL_REGISTRY.task_verify(
        ctx,
        args as { outcome: "pass" | "fail"; reason: string; evidence?: string },
      );
    case "task_escalate":
      return TOOL_REGISTRY.task_escalate(
        ctx,
        args as { question: string; options?: string[]; evidence?: string },
      );
    case "task_resolve":
      return TOOL_REGISTRY.task_resolve(
        ctx,
        args as { outcome: "decided" | "defer"; decision?: string; rationale?: string },
      );
    case "task_seed_followup":
      return TOOL_REGISTRY.task_seed_followup(
        ctx,
        args as { title: string; description?: string },
      );
    default:
      throw new McpAuthError(`unknown tool ${name}`);
  }
}

function handleRpc(req: JsonRpcRequest, ctx: McpAuthContext | null) {
  const isNotification = !("id" in req) || req.id === undefined || req.id === null;
  const id = isNotification ? null : (req.id as JsonRpcId);

  // Notifications never get a response.
  if (req.method.startsWith("notifications/")) return null;

  // Initialize is the only method allowed without prior auth checks; we still
  // require a bearer to be present to discourage probing.
  if (req.method === "initialize") {
    if (!ctx) return rpcError(id, -32001, "missing or invalid bearer token");
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }

  if (!ctx) return rpcError(id, -32001, "missing or invalid bearer token");

  if (req.method === "tools/list") {
    return rpcResult(id, { tools: TOOL_DEFINITIONS });
  }

  if (req.method === "tools/call") {
    const params = (req.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    if (!params.name) {
      return rpcError(id, -32602, "tools/call missing 'name'");
    }
    // Instrument every tool call (the bookkeeping-turn meter). Best-effort.
    logToolCall(ctx.taskId, ctx.stage, params.name);
    try {
      const result = callTool(ctx, params.name, params.arguments ?? {});
      return rpcResult(id, {
        content: [
          { type: "text", text: JSON.stringify(result) },
        ],
      });
    } catch (err) {
      const message = (err as Error).message;
      return rpcResult(id, {
        isError: true,
        content: [{ type: "text", text: message }],
      });
    }
  }

  // ping and similar low-priority methods just return empty.
  if (req.method === "ping") return rpcResult(id, {});

  return rpcError(id, -32601, `method not found: ${req.method}`);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      rpcError(null, -32700, "parse error"),
      { status: 400 },
    );
  }
  const ctx = authFromRequest(req);

  const reqs = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
  for (const r of reqs) {
    console.log(
      `[mcp] ${r.method} task=${ctx?.taskId ?? "?"} stage=${ctx?.stage ?? "?"}`,
    );
  }
  const responses = reqs
    .map((r) => handleRpc(r, ctx))
    .filter((r) => r !== null);

  if (responses.length === 0) {
    return new NextResponse(null, { status: 202 });
  }
  const payload = Array.isArray(body) ? responses : responses[0];
  return NextResponse.json(payload);
}

export async function GET() {
  // Streamable HTTP optional GET endpoint for server-pushed events. We don't
  // push notifications today; return 405 so clients fall back to plain POST.
  return new NextResponse("server-push not supported", { status: 405 });
}

export async function DELETE() {
  return new NextResponse(null, { status: 204 });
}
