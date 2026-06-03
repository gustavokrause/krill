import type { NextRequest } from "next/server";
import { subscribe } from "@/lib/sse";
import type { WorkflowEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * SSE stream of workflow events. Each connection subscribes to the
 * process-local EventEmitter; messages arrive as `event: <type>\n
 * data: <json>\n\n`. A 15s heartbeat keeps proxies + tab-sleep from
 * killing the connection. EventSource auto-reconnects on disconnect.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeWrite = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch (err) {
          closed = true;
          console.warn("[sse] write threw:", err);
        }
      };

      const sendEvent = (event: WorkflowEvent) => {
        safeWrite(`event: ${event.type}\n`);
        safeWrite(`data: ${JSON.stringify(event)}\n\n`);
      };

      safeWrite(`: connected ${Date.now()}\n\n`);
      const unsubscribe = subscribe(sendEvent);

      const heartbeat = setInterval(() => {
        safeWrite(`: hb ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
