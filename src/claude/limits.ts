import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { usageLimits, type UsageLimitSource } from "@/db/schema";
import { broadcast } from "@/lib/sse";
import { computeLimitsView } from "@/lib/limits-view";
import { cliProvider } from "./limits-cli";
import { oauthProvider } from "./limits-oauth";
import { estimateProvider } from "./limits-estimate";

// -- Types --

export type LimitRow = {
  scope: string;
  model_bucket: string | null;
  used_pct: number;
  resets_at: number | null;
  source: UsageLimitSource;
  raw: string | null;
};

export type LimitSnapshot = LimitRow[];

export type LimitProvider = {
  name: UsageLimitSource;
  probe(now: number): Promise<LimitRow[] | null>;
};

// -- Provider registry --

let providers: LimitProvider[] = [cliProvider, oauthProvider, estimateProvider];

/** Test-only injection shim. Resets the provider chain. */
export function __setProviders(p: LimitProvider[]): void {
  providers = p;
}

// -- Orchestrator --

/**
 * Walk providers in order; first that returns a non-null row set wins.
 * Batch-inserts all rows to usage_limits and emits limits.changed.
 * Never throws to the caller — probe failures are caught per provider.
 */
export async function readUsageLimits(): Promise<LimitSnapshot> {
  const now = Math.floor(Date.now() / 1000);

  let rows: LimitRow[] | null = null;
  for (const provider of providers) {
    try {
      rows = await provider.probe(now);
    } catch (err) {
      console.warn(`[limits:${provider.name}] probe threw:`, err);
      rows = null;
    }
    if (rows !== null) break;
  }

  if (!rows || rows.length === 0) return [];

  db.insert(usageLimits)
    .values(
      rows.map((r) => ({
        id: randomUUID(),
        source: r.source,
        scope: r.scope,
        model_bucket: r.model_bucket ?? null,
        used_pct: r.used_pct,
        resets_at: r.resets_at ?? null,
        observed_at: now,
        raw: r.raw ?? null,
      })),
    )
    .run();

  broadcast({ type: "limits.changed", view: computeLimitsView(now) });

  return rows;
}
