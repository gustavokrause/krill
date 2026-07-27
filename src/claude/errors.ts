export class UsageLimitError extends Error {
  readonly code = "usage_limit";
  resetsAt: number | null;
  scope: "session_5h" | "week";
  raw: string;
  taskId: string;
  constructor(o: {
    message: string;
    resetsAt: number | null;
    scope: "session_5h" | "week";
    raw: string;
    taskId: string;
  }) {
    super(o.message);
    this.name = "UsageLimitError";
    this.resetsAt = o.resetsAt;
    this.scope = o.scope;
    this.raw = o.raw;
    this.taskId = o.taskId;
  }
}

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

const USAGE_LIMIT_RE =
  /usage[ -]?limit[ \t]+reached|5[- ]?hour[ \t]+limit[ \t]+reached|week(?:ly)?[ \t]+(?:usage[ \t]+)?limit[ \t]+reached|Claude AI usage limit reached/i;
const WEEK_RE = /\bweek(?:ly)?\b/i;
const PIPE_EPOCH_RE = /reached\|(\d{10,})/i;
const RESET_AT_INT_RE = /resets?[ _-]?at[ :=]*(\d{10,})/i;
const ISO_RE =
  /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/;
const RELATIVE_RE =
  /\bin (\d+)h(?:\s*(\d+)m)?|\bin (\d+) hours?(?:\s+(\d+) minutes?)?/i;
const WALL_CLOCK_RE = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

function extractResetsAt(text: string, nowSec: number): number | null {
  const pipe = PIPE_EPOCH_RE.exec(text);
  if (pipe) return parseInt(pipe[1], 10);

  const resetInt = RESET_AT_INT_RE.exec(text);
  if (resetInt) return parseInt(resetInt[1], 10);

  const iso = ISO_RE.exec(text);
  if (iso) {
    const parsed = Date.parse(iso[1]);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }

  const rel = RELATIVE_RE.exec(text);
  if (rel) {
    const h = parseInt(rel[1] ?? rel[3] ?? "0", 10);
    const m = parseInt(rel[2] ?? rel[4] ?? "0", 10);
    return nowSec + h * 3600 + m * 60;
  }

  const wall = WALL_CLOCK_RE.exec(text);
  if (wall) {
    let h = parseInt(wall[1], 10);
    const min = parseInt(wall[2] ?? "0", 10);
    const ampm = wall[3].toLowerCase();
    if (ampm === "am" && h === 12) h = 0;
    if (ampm === "pm" && h !== 12) h += 12;
    const d = new Date(nowSec * 1000);
    d.setUTCHours(h, min, 0, 0);
    let ts = Math.floor(d.getTime() / 1000);
    if (ts < nowSec) ts += 86400;
    return ts;
  }

  return null;
}

/**
 * Classify CLI output as a usage-limit exhaustion, or null for ordinary stderr.
 * Returns the parsed scope and resetsAt (may be null when no time is parseable).
 * Optional nowSec freezes the clock for tests.
 */
export function classifyUsageLimit(
  text: string,
  nowSec?: number,
): { resetsAt: number | null; scope: "session_5h" | "week" } | null {
  if (!USAGE_LIMIT_RE.test(text)) return null;
  const scope: "session_5h" | "week" = WEEK_RE.test(text) ? "week" : "session_5h";
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  return { resetsAt: extractResetsAt(text, now), scope };
}

/** Classify CLI output as an interactive block, or null for an ordinary result. */
export function classifyBlock(
  text: string,
): { kind: "mcp_auth" | "cli_login"; actionUrl?: string } | null {
  if (!MCP_AUTH_RE.test(text)) return null;
  return {
    kind: LOGIN_RE.test(text) ? "cli_login" : "mcp_auth",
    // Stop at whitespace AND markdown/quote chars — models wrap URLs in **bold**
    // / backticks / parens, and `\S+` would swallow the trailing delimiter into
    // the URL (e.g. `…/mcp**`). Kept for logging; the URL is no longer persisted
    // as a CTA (it's a single-use, process-scoped OAuth link — dead on arrival).
    actionUrl: text.match(/https?:\/\/[^\s*`"'<>)\]}]+/)?.[0],
  };
}
