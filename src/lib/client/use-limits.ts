"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { LimitsView } from "@/lib/client/api";
import { useEventSource } from "@/lib/client/use-event-source";

type Snap = { limits: LimitsView; activeClaims: number };

export function useLimits(): { limits: LimitsView | null; activeClaims: number } {
  const [snap, setSnap] = useState<Snap | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      api
        .getHealth()
        .then((h) => {
          if (!cancelled)
            setSnap({ limits: h.limits, activeClaims: h.active_claims });
        })
        .catch(() => {});
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEventSource({
    "limits.changed": (event) => {
      if (event.type === "limits.changed") {
        setSnap((prev) =>
          prev ? { ...prev, limits: event.view as unknown as LimitsView } : null,
        );
      }
    },
  });

  return snap
    ? { limits: snap.limits, activeClaims: snap.activeClaims }
    : { limits: null, activeClaims: 0 };
}
