import { execSync } from "node:child_process";
import type { LimitProvider, LimitRow } from "./limits";

type CliCapability =
  | { capable: false }
  | { capable: true; args: string[] };

const CACHE_KEY = "__ai_auto_claude_cli_usage_capable";
const g = globalThis as Record<string, unknown>;

function getCached(): CliCapability | undefined {
  return g[CACHE_KEY] as CliCapability | undefined;
}

function setCached(v: CliCapability): void {
  g[CACHE_KEY] = v;
}

function probeCapability(): CliCapability {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5_000 });
  } catch {
    return { capable: false };
  }

  let helpText = "";
  try {
    helpText = execSync("claude --help", {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5_000,
    });
  } catch (err) {
    if (err && typeof err === "object" && "stdout" in err) {
      helpText = String((err as { stdout?: unknown }).stdout ?? "");
    }
  }

  if (/\busage\b/i.test(helpText)) {
    return { capable: true, args: ["usage", "--json"] };
  }
  if (/--output-format/i.test(helpText)) {
    return { capable: true, args: ["--output-format", "json", "--print-usage"] };
  }

  return { capable: false };
}

interface RawBucket {
  scope?: unknown;
  bucket?: unknown;
  key?: unknown;
  model?: unknown;
  model_bucket?: unknown;
  used?: unknown;
  usedTokens?: unknown;
  used_tokens?: unknown;
  limit?: unknown;
  limitTokens?: unknown;
  limit_tokens?: unknown;
  resetsAt?: unknown;
  resets_at?: unknown;
  resetAt?: unknown;
}

function pct(used: unknown, limit: unknown): number | null {
  const u = Number(used ?? 0);
  const l = Number(limit ?? 0);
  if (l <= 0) return null;
  return Math.min(100, (u / l) * 100);
}

function epoch(v: unknown): number | null {
  return v != null ? Number(v) : null;
}

function parseBucket(b: RawBucket, fallbackScope: string, fallbackModel: string | null): LimitRow | null {
  const used_pct = pct(b.used ?? b.usedTokens ?? b.used_tokens, b.limit ?? b.limitTokens ?? b.limit_tokens);
  if (used_pct === null) return null;
  const scope = String(b.scope ?? b.bucket ?? b.key ?? fallbackScope);
  const model_bucket = String(b.model ?? b.model_bucket ?? fallbackModel ?? "") || null;
  const resets_at = epoch(b.resetsAt ?? b.resets_at ?? b.resetAt);
  return { scope, model_bucket, used_pct, resets_at, source: "cli", raw: null };
}

function parseOutput(raw: string): LimitRow[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!json || typeof json !== "object") return [];

  const out: LimitRow[] = [];

  if (Array.isArray(json)) {
    for (const item of json) {
      const row = parseBucket(item as RawBucket, "unknown", null);
      if (row) out.push(row);
    }
    return out;
  }

  const obj = json as Record<string, unknown>;

  // Shape: { session: {...}, week: {...}, week_opus: {...}, ... }
  const SCOPE_MAP: Record<string, { scope: string; model_bucket: string | null }> = {
    session: { scope: "session_5h", model_bucket: null },
    session_5h: { scope: "session_5h", model_bucket: null },
    sessionUsage: { scope: "session_5h", model_bucket: null },
    week: { scope: "week", model_bucket: null },
    weekly: { scope: "week", model_bucket: null },
    weeklyUsage: { scope: "week", model_bucket: null },
    week_opus: { scope: "week_opus", model_bucket: "opus" },
    week_sonnet: { scope: "week_sonnet", model_bucket: "sonnet" },
    week_fable: { scope: "week_fable", model_bucket: "fable" },
  };

  for (const [key, meta] of Object.entries(SCOPE_MAP)) {
    const val = obj[key];
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const row = parseBucket(val as RawBucket, meta.scope, meta.model_bucket);
    if (row) out.push({ ...row, scope: meta.scope, model_bucket: meta.model_bucket });
  }

  // Shape: { usage: [...] } or { buckets: [...] }
  const arr = Array.isArray(obj.usage)
    ? obj.usage
    : Array.isArray(obj.buckets)
      ? obj.buckets
      : null;
  if (arr) {
    for (const item of arr as unknown[]) {
      const row = parseBucket(item as RawBucket, "unknown", null);
      if (row) out.push(row);
    }
  }

  return out;
}

export const cliProvider: LimitProvider = {
  name: "cli",
  async probe(_now: number): Promise<LimitRow[] | null> {
    const cached = getCached();
    const cap: CliCapability = cached ?? probeCapability();
    if (!cached) setCached(cap);

    if (!cap.capable) return null;

    let raw: string;
    try {
      raw = execSync(`claude ${cap.args.join(" ")}`, {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 10_000,
      });
    } catch {
      return null;
    }

    const rows = parseOutput(raw);
    if (rows.length === 0) return null;

    return rows.map((r) => ({ ...r, raw }));
  },
};
