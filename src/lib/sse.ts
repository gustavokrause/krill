import { EventEmitter } from "node:events";
import type { WorkflowEvent } from "./events";

/**
 * Process-singleton EventEmitter for the SSE pub/sub. Stored on globalThis
 * so Next.js dev HMR re-evaluations reuse the same emitter and existing
 * subscribers keep receiving events across module reloads.
 */
function getEmitter(): EventEmitter {
  const g = globalThis as unknown as { __ai_auto_sse?: EventEmitter };
  if (!g.__ai_auto_sse) {
    const em = new EventEmitter();
    em.setMaxListeners(0); // unlimited; LAN-local clients only
    g.__ai_auto_sse = em;
  }
  return g.__ai_auto_sse;
}

const CHANNEL = "event";

export function broadcast(event: WorkflowEvent): void {
  try {
    getEmitter().emit(CHANNEL, event);
  } catch (err) {
    console.warn("[sse] broadcast threw:", err);
  }
}

export function subscribe(
  handler: (event: WorkflowEvent) => void,
): () => void {
  const em = getEmitter();
  em.on(CHANNEL, handler);
  return () => {
    em.off(CHANNEL, handler);
  };
}

export function listenerCount(): number {
  return getEmitter().listenerCount(CHANNEL);
}
