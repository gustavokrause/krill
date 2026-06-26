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
  const [tokens, setTokens] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      api
        .getHealth()
        .then((h) => {
          if (!cancelled) setTokens(h.tokens_today);
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

  if (tokens === null) return null;

  return (
    <span
      className="inline-flex items-center gap-1 text-text-2"
      title={`Tokens metered across all stages since local midnight: ${tokens.toLocaleString()}`}
    >
      <Coins className="h-3.5 w-3.5" />
      Today: {formatTokens(tokens)} tok
    </span>
  );
}
