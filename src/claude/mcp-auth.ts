import { randomUUID } from "node:crypto";
import type { Stage } from "@/workflow/types";

export type McpAuthContext = {
  token: string;
  taskId: string;
  stage: Stage;
  expiresAt: number;
};

// Persist across HMR reloads in Next.js dev mode by hanging the Map off
// globalThis. Without this, each route handler that loads `mcp-auth`
// after HMR gets a fresh empty Map and token lookups fail.
const GLOBAL_KEY = "__ai_auto_mcp_tokens";
const g = globalThis as unknown as Record<string, Map<string, McpAuthContext>>;
const tokens: Map<string, McpAuthContext> =
  g[GLOBAL_KEY] ?? (g[GLOBAL_KEY] = new Map());

export function issueToken(
  taskId: string,
  stage: Stage,
  ttlSeconds: number,
): string {
  const token = randomUUID();
  tokens.set(token, {
    token,
    taskId,
    stage,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  return token;
}

export function resolveToken(token: string): McpAuthContext | null {
  const ctx = tokens.get(token);
  if (!ctx) return null;
  if (ctx.expiresAt < Math.floor(Date.now() / 1000)) {
    tokens.delete(token);
    return null;
  }
  return ctx;
}

export function revokeToken(token: string): void {
  tokens.delete(token);
}

export function purgeExpired(): void {
  const ts = Math.floor(Date.now() / 1000);
  for (const [token, ctx] of tokens) {
    if (ctx.expiresAt < ts) tokens.delete(token);
  }
}
