"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/client/api";

/**
 * Restart-safety indicator. Polls /api/health for live claims (a worker mid-stage).
 * Busy → loud warning: stopping/rebuilding now orphans the running task(s). Idle →
 * a muted "safe to restart" so you get positive confirmation before `npm run rebuild`,
 * not just the absence of a warning. Pairs with the rebuild.sh/stop.sh busy guard.
 */
export function RestartSafety() {
  const [busy, setBusy] = useState<number | null>(null);
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      api
        .getHealth()
        .then((h) => {
          if (cancelled) return;
          setBusy(h.active_claims);
          setIds(h.active_claim_ids);
        })
        .catch(() => {
          /* transient — keep last known state */
        });
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (busy === null) return null; // unknown until first fetch — say nothing

  if (busy === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-text-3" title="No live workers — safe to stop/rebuild krill.">
        <CheckCircle2 className="h-3.5 w-3.5 text-success/70" />
        safe to restart
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 font-medium text-danger"
      title={`Live worker(s) on: ${ids.join(", ")}. Stopping/rebuilding now orphans them — wait for the board to go idle.`}
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      Working — don&apos;t stop/rebuild ({busy} running)
    </span>
  );
}
