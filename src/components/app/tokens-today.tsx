"use client";

import { useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { api } from "@/lib/client/api";
import { formatTokens } from "@/lib/client/format";

/**
 * "Tokens today" footer indicator. Polls /api/health every 5s (same cadence as
 * RestartSafety) for the global tokens_today drain since local midnight. Stays
 * silent until the first fetch lands so the footer doesn't flash a zero.
 */
export function TokensToday() {
  const [spend, setSpend] = useState<{
    cost_usd: number;
    new_tokens: number;
    cache_read_tokens: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      api
        .getHealth()
        .then((h) => {
          if (!cancelled) setSpend(h.spend_today ?? null);
        })
        .catch(() => {
          /* transient — keep last known value */
        });
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (spend === null) return null;

  // Cost leads — raw token sums read ~10x scarier than reality (~90% is the
  // cached prefix re-read every agent turn at ~0.1x rates).
  return (
    <span
      className="inline-flex items-center gap-1 text-text-2"
      title={`Since local midnight: $${spend.cost_usd.toFixed(2)} · ${spend.new_tokens.toLocaleString()} new tokens (input + output + cache writes, tokenized once) · ${spend.cache_read_tokens.toLocaleString()} cache reads (the conversation prefix re-read each turn, ~0.1x weight)`}
    >
      <Coins className="h-3.5 w-3.5" />
      Today: ${spend.cost_usd.toFixed(2)} · {formatTokens(spend.new_tokens)} new
      / {formatTokens(spend.cache_read_tokens)} cached
    </span>
  );
}
