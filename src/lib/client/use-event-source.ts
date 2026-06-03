"use client";

import { useEffect } from "react";
import type { WorkflowEvent, EventType } from "@/lib/events";

type Handlers = Partial<
  Record<EventType, (event: WorkflowEvent) => void>
> & {
  any?: (event: WorkflowEvent) => void;
};

/**
 * Subscribe to /api/stream. EventSource auto-reconnects on disconnect.
 * Handlers receive the parsed event payload. Provide `any` for a
 * catch-all listener used by aggregate refreshers.
 */
export function useEventSource(handlers: Handlers): void {
  useEffect(() => {
    const es = new EventSource("/api/stream");
    const wrap = (type: EventType) => {
      const fn = handlers[type];
      if (!fn && !handlers.any) return;
      const listener = (raw: MessageEvent) => {
        try {
          const event = JSON.parse(raw.data) as WorkflowEvent;
          fn?.(event);
          handlers.any?.(event);
        } catch (err) {
          console.warn("[sse] parse error", err);
        }
      };
      es.addEventListener(type, listener);
    };
    const types: EventType[] = [
      "task.updated",
      "task.transitioned",
      "comment.appended",
      "config.changed",
      "project.updated",
      "project.deleted",
      "task.deleted",
      "task.stuck",
    ];
    for (const t of types) wrap(t);

    es.onerror = (err) => {
      console.warn("[sse] error", err);
    };

    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
