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
