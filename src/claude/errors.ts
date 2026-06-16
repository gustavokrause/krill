export class RateLimitError extends Error {
  readonly code = "rate_limit";
  constructor(message: string) {
    super(message);
  }
}

export class TimeoutError extends Error {
  readonly code = "timeout";
  constructor(message: string) {
    super(message);
  }
}

export class AuthError extends Error {
  readonly code = "auth";
  constructor(message: string) {
    super(message);
  }
}

export class McpAuthError extends Error {
  readonly code = "mcp_auth";
  constructor(message: string) {
    super(message);
  }
}

/**
 * A stage hit something interactive a human must clear (an unauthenticated MCP
 * answered with an OAuth URL, or the CLI is logged out). The tick pauses the
 * task (blocked flag) and files a blocker instead of failing the stage.
 */
export class BlockedError extends Error {
  readonly code = "blocked";
  kind: "mcp_auth" | "cli_login";
  detail: string;
  actionUrl?: string;
  taskId: string;
  stage: string;
  constructor(o: {
    kind: "mcp_auth" | "cli_login";
    summary: string;
    detail: string;
    actionUrl?: string;
    taskId: string;
    stage: string;
  }) {
    super(o.summary);
    this.name = "BlockedError";
    this.kind = o.kind;
    this.detail = o.detail;
    this.actionUrl = o.actionUrl;
    this.taskId = o.taskId;
    this.stage = o.stage;
  }
}

const MCP_AUTH_RE =
  /\b(authoriz|oauth|Open this URL|Please run \/login|Not logged in|authenticate)\b/i;
const LOGIN_RE = /\b(Please run \/login|Not logged in)\b/i;

/** Classify CLI output as an interactive block, or null for an ordinary result. */
export function classifyBlock(
  text: string,
): { kind: "mcp_auth" | "cli_login"; actionUrl?: string } | null {
  if (!MCP_AUTH_RE.test(text)) return null;
  return {
    kind: LOGIN_RE.test(text) ? "cli_login" : "mcp_auth",
    actionUrl: text.match(/https?:\/\/\S+/)?.[0],
  };
}
