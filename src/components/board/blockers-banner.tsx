"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { Blocker } from "@/db/schema";
import type { LimitsView } from "@/lib/client/api";
import { api } from "@/lib/client/api";
import { useLimits } from "@/lib/client/use-limits";
import { useToast } from "@/components/ui/toast";

const j = async (url: string, opts?: RequestInit) => (await fetch(url, opts)).json();

function remedy(kind: string): string {
  switch (kind) {
    case "mcp_auth":
      return "krill's headless runner can't do a browser sign-in, and the captured auth link is single-use — it dies with the worker, so there's nothing to click here. Authenticate the MCP once in an interactive session on this machine (run `claude`, then `/mcp` → authorize the server, e.g. Supabase). The token caches, so krill reuses it — then Resume to re-run the stage.";
    case "cli_login":
      return "Run `claude` in a terminal on this machine and complete `/login`. Then Resume to re-run the stage.";
    case "followup":
      return "Auto-picking is paused — a task surfaced out-of-scope work. Review the content below and act on it (e.g. open a task), then Resume to re-enable the TODO picker. Dismiss clears this but keeps picking paused.";
    default:
      return "Clear the issue in an interactive session, then Resume.";
  }
}

function fmtCountdown(sec: number): string {
  if (sec <= 0) return "<1m";
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function fmtTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LimitRow({
  limits,
  activeClaims,
}: {
  limits: LimitsView;
  activeClaims: number;
}) {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (limits.guard_state !== "stopped") return;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [limits.guard_state]);

  const handleResume = async () => {
    setBusy(true);
    try {
      await api.resumeLimits();
    } catch (err) {
      toast.push({
        variant: "danger",
        title: "Resume failed",
        description: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const pct = Math.round(limits.worst_pct ?? 0);
  const isDanger = limits.guard_state === "stopped";

  let rowText: string;
  if (limits.guard_state === "soft_paused") {
    rowText = `Usage at ${pct}% — not taking new tasks`;
  } else if (limits.guard_state === "draining") {
    rowText = `Usage at ${pct}% — finishing ${activeClaims} in-flight task${activeClaims === 1 ? "" : "s"}, then stopping`;
  } else {
    const until =
      limits.limit_resume_at != null
        ? ` until ${fmtTime(limits.limit_resume_at)} (resumes in ${fmtCountdown(limits.limit_resume_at - nowSec)})`
        : "";
    rowText = `Usage at ${pct}% — stopped${until}`;
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs mb-2 ${
        isDanger
          ? "border-danger/40 bg-danger/10"
          : "border-warning/40 bg-warning/10"
      }`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <AlertTriangle
          className={`h-3.5 w-3.5 shrink-0 ${isDanger ? "text-danger" : "text-warning"}`}
        />
        <span className={`font-medium ${isDanger ? "text-danger" : "text-warning"}`}>
          {rowText}
        </span>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={handleResume}
        className="shrink-0 px-2.5 py-1 rounded-sm bg-primary text-white disabled:opacity-50"
      >
        {busy ? "…" : "Resume now"}
      </button>
    </div>
  );
}

export function BlockersBanner() {
  const { limits, activeClaims } = useLimits();
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

  const showLimitRow = limits !== null && limits.guard_state !== "normal";
  const displayItems = items.filter((b) => !b.kind.startsWith("usage_limit_"));

  if (!showLimitRow && displayItems.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-warning/50 bg-warning/10 p-3">
      <div className="flex items-center gap-2 text-warning font-semibold text-sm mb-2">
        <AlertTriangle className="h-4 w-4" />
        {displayItems.length > 0
          ? `${displayItems.length} thing${displayItems.length === 1 ? "" : "s"} need attention to keep krill moving`
          : "Guard holding the pipeline"}
      </div>
      {showLimitRow && limits !== null ? (
        <LimitRow limits={limits} activeClaims={activeClaims} />
      ) : null}
      {displayItems.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {displayItems.map((b) => (
            <li key={b.id} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-text font-medium">{b.summary}</div>
                  <div className="text-text-3 mt-0.5">
                    {b.kind}
                    {b.task_id ? ` · ${b.stage}:${b.task_id}` : ""}
                  </div>
                  {b.detail ? (
                    b.kind === "followup" ? (
                      <textarea
                        readOnly
                        value={b.detail}
                        onClick={(e) => e.currentTarget.select()}
                        className="mt-1 w-full h-24 resize-y rounded border border-border bg-surface-2 p-1.5 text-[11px] font-mono text-text-2"
                      />
                    ) : (
                      <div className="text-text-2 mt-1 font-mono whitespace-pre-wrap break-all line-clamp-3">
                        {b.detail}
                      </div>
                    )
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
                    {busy === b.id ? "…" : b.kind === "followup" ? "Resume" : "Done — resume"}
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
      ) : null}
    </div>
  );
}
