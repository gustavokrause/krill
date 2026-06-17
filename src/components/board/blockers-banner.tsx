"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { Blocker } from "@/db/schema";

const j = async (url: string, opts?: RequestInit) => (await fetch(url, opts)).json();

// How to clear each kind. In-app where possible; otherwise guide an interactive
// session (a browser sign-in / login the headless runner can't do), then resume.
function remedy(kind: string): string {
  switch (kind) {
    case "mcp_auth":
      return "krill's headless runner can't do a browser sign-in, and the captured auth link is single-use — it dies with the worker, so there's nothing to click here. Authenticate the MCP once in an interactive session on this machine (run `claude`, then `/mcp` → authorize the server, e.g. Supabase). The token caches, so krill reuses it — then Resume to re-run the stage.";
    case "cli_login":
      return "Run `claude` in a terminal on this machine and complete `/login`. Then Resume to re-run the stage.";
    default:
      return "Clear the issue in an interactive session, then Resume.";
  }
}

// The unblock queue: a stage paused on something interactive (MCP auth / CLI
// login). Surface it, let the human clear it, then re-run the stage on Resume.
export function BlockersBanner() {
  const [items, setItems] = useState<Blocker[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await j("/api/blockers")).blockers ?? []);
    } catch {
      /* tolerate */
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(() => !document.hidden && load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (id: string, action: "resolve" | "dismiss") => {
    setBusy(id);
    try {
      await j(`/api/blockers/${id}/${action}`, { method: "POST" });
      load();
    } finally {
      setBusy(null);
    }
  };

  if (!items.length) return null;

  return (
    <div className="mb-4 rounded-lg border border-warning/50 bg-warning/10 p-3">
      <div className="flex items-center gap-2 text-warning font-semibold text-sm">
        <AlertTriangle className="h-4 w-4" />
        {items.length} thing{items.length === 1 ? "" : "s"} need attention to keep krill moving
      </div>
      <ul className="mt-2 space-y-2">
        {items.map((b) => (
          <li key={b.id} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-text font-medium">{b.summary}</div>
                <div className="text-text-3 mt-0.5">
                  {b.kind}
                  {b.task_id ? ` · ${b.stage}:${b.task_id}` : ""}
                </div>
                {b.detail ? (
                  <div className="text-text-2 mt-1 font-mono whitespace-pre-wrap break-all line-clamp-3">
                    {b.detail}
                  </div>
                ) : null}
                <div className="text-text-2 mt-1.5 leading-relaxed">{remedy(b.kind)}</div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  disabled={busy === b.id}
                  onClick={() => act(b.id, "resolve")}
                  className="px-2.5 py-1 rounded-sm bg-primary text-white disabled:opacity-50"
                >
                  {busy === b.id ? "…" : "Done — resume"}
                </button>
                <button
                  type="button"
                  disabled={busy === b.id}
                  onClick={() => act(b.id, "dismiss")}
                  className="px-2.5 py-1 rounded-sm border border-border-strong disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
