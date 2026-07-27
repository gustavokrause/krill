import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LimitProvider, LimitRow } from "./limits";

// OAuth usage endpoint on claude.ai. Returns 4xx when the scope isn't granted
// or the account type doesn't expose machine-readable limits → provider returns
// null and the orchestrator falls through to the estimator.
const USAGE_ENDPOINT = "https://claude.ai/api/account/usage_limits";

function readCredentialsFile(): string | null {
  const credPath = join(homedir(), ".claude", ".credentials.json");
  try {
    return readFileSync(credPath, "utf8");
  } catch {
    return null;
  }
}

function extractAccessToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;

    // Most common shape: { claudeAiOauth: { accessToken: "..." } }
    const oauth = obj.claudeAiOauth ?? obj.claude_ai_oauth;
    if (oauth && typeof oauth === "object") {
      const token = (oauth as Record<string, unknown>).accessToken ??
        (oauth as Record<string, unknown>).access_token;
      if (typeof token === "string" && token.length > 0) return token;
    }

    // Flat shape: { accessToken: "..." } or { token: "..." }
    if (typeof obj.accessToken === "string") return obj.accessToken;
    if (typeof obj.token === "string") return obj.token;
  } catch {
    // ignore
  }
  return null;
}

function readKeychainToken(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execSync(
      "security find-generic-password -s 'Claude Code' -a 'oauth' -w 2>/dev/null",
      { encoding: "utf8", stdio: "pipe", timeout: 5_000 },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function getAccessToken(): string | null {
  const fileRaw = readCredentialsFile();
  if (fileRaw) {
    const tok = extractAccessToken(fileRaw);
    if (tok) return tok;
  }
  return readKeychainToken();
}

interface UsageEntry {
  scope?: unknown;
  bucket?: unknown;
  model?: unknown;
  model_bucket?: unknown;
  used_pct?: unknown;
  usedPct?: unknown;
  used?: unknown;
  limit?: unknown;
  resets_at?: unknown;
  resetsAt?: unknown;
}

function parseResponse(body: string): LimitRow[] | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;

  const rows: LimitRow[] = [];

  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as Record<string, unknown>).limits)
      ? (json as Record<string, unknown>).limits
      : Array.isArray((json as Record<string, unknown>).buckets)
        ? (json as Record<string, unknown>).buckets
        : null;

  if (arr) {
    for (const item of arr as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const e = item as UsageEntry;
      const scope = String(e.scope ?? e.bucket ?? "");
      if (!scope) continue;
      const model_bucket = String(e.model ?? e.model_bucket ?? "") || null;
      const rawPct = e.used_pct ?? e.usedPct;
      const used_pct =
        rawPct != null
          ? Math.min(100, Number(rawPct))
          : (() => {
              const u = Number(e.used ?? 0);
              const l = Number(e.limit ?? 0);
              return l > 0 ? Math.min(100, (u / l) * 100) : 0;
            })();
      const resets_at = e.resets_at != null ? Number(e.resets_at) : e.resetsAt != null ? Number(e.resetsAt) : null;
      rows.push({ scope, model_bucket, used_pct, resets_at, source: "oauth", raw: body });
    }
  }

  return rows.length > 0 ? rows : null;
}

export const oauthProvider: LimitProvider = {
  name: "oauth",
  async probe(_now: number): Promise<LimitRow[] | null> {
    const token = getAccessToken();
    if (!token) return null;

    let res: Response;
    try {
      res = await fetch(USAGE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }

    if (!res.ok) return null;

    let body: string;
    try {
      body = await res.text();
    } catch {
      return null;
    }

    return parseResponse(body);
  },
};
