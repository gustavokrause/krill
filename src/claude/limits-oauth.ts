import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LimitProvider, LimitRow } from "./limits";

// The endpoint Claude Code's own /usage command calls (verified against the
// CLI binary and live: returns session/weekly/per-model percentages matching
// the app exactly). Undocumented and internal — it can change or vanish at any
// time, which is fine: any failure returns null and the ladder falls through
// to the estimator. Requires the cached Claude Code OAuth token plus the
// oauth beta header.
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

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
  // Current Claude Code stores a JSON credentials blob under
  // 'Claude Code-credentials'; older builds used 'Claude Code' + 'oauth'.
  for (const cmd of [
    "security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null",
    "security find-generic-password -s 'Claude Code' -a 'oauth' -w 2>/dev/null",
  ]) {
    try {
      const out = execSync(cmd, { encoding: "utf8", stdio: "pipe", timeout: 5_000 }).trim();
      if (!out) continue;
      // Blob may be JSON (extract) or a bare token.
      return extractAccessToken(out) ?? (out.startsWith("{") ? null : out);
    } catch {
      // try next source
    }
  }
  return null;
}

function getAccessToken(): string | null {
  const fileRaw = readCredentialsFile();
  if (fileRaw) {
    const tok = extractAccessToken(fileRaw);
    if (tok) return tok;
  }
  return readKeychainToken();
}

// Real response shape (2026-07): a `limits` array of
//   { kind: "session" | "weekly_all" | "weekly_scoped", percent, resets_at: ISO,
//     scope: null | { model: { display_name } } }
// plus top-level five_hour/seven_day objects we use as a fallback if the
// array ever disappears.
function isoToEpoch(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function parseResponse(body: string): LimitRow[] | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;

  const rows: LimitRow[] = [];

  if (Array.isArray(obj.limits)) {
    for (const item of obj.limits as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const kind = String(e.kind ?? "");
      const scope = kind === "session" ? "session_5h" : kind.startsWith("weekly") ? "week" : null;
      if (!scope) continue;
      let model_bucket: string | null = null;
      const s = e.scope;
      if (s && typeof s === "object") {
        const m = (s as Record<string, unknown>).model;
        if (m && typeof m === "object") {
          const name = (m as Record<string, unknown>).display_name;
          if (typeof name === "string" && name) model_bucket = name;
        }
      }
      rows.push({
        scope,
        model_bucket,
        used_pct: Math.min(100, Number(e.percent ?? 0)),
        resets_at: isoToEpoch(e.resets_at),
        source: "oauth",
        raw: body,
      });
    }
  }

  // Fallback: top-level five_hour / seven_day utilization objects.
  if (rows.length === 0) {
    for (const [key, scope] of [
      ["five_hour", "session_5h"],
      ["seven_day", "week"],
    ] as const) {
      const b = obj[key];
      if (b && typeof b === "object") {
        const util = Number((b as Record<string, unknown>).utilization ?? NaN);
        if (!Number.isNaN(util)) {
          rows.push({
            scope,
            model_bucket: null,
            used_pct: Math.min(100, util),
            resets_at: isoToEpoch((b as Record<string, unknown>).resets_at),
            source: "oauth",
            raw: body,
          });
        }
      }
    }
  }

  return rows.length > 0 ? rows : null;
}

async function fetchUsage(token: string): Promise<Response | null> {
  try {
    return await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
}

export const oauthProvider: LimitProvider = {
  name: "oauth",
  async probe(_now: number): Promise<LimitRow[] | null> {
    const token = getAccessToken();
    if (!token) return null;

    let res = await fetchUsage(token);
    // The endpoint rate-limits per token and the quota is shared with every
    // live Claude Code session's own /usage polling, so a 429 here is a lost
    // lottery, not an outage. One short-delay retry wins most of them.
    if (res === null || res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 3_000));
      res = await fetchUsage(token);
    }
    if (res === null || !res.ok) return null;

    let body: string;
    try {
      body = await res.text();
    } catch {
      return null;
    }

    return parseResponse(body);
  },
};

// Test-only: parse a captured response body without hitting the network.
export const __parseUsageResponse = parseResponse;
