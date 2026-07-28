"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import type { LimitsView, GuardState } from "@/lib/client/api";
import { useLimits } from "@/lib/client/use-limits";

type ToneKey = "text-2" | "warning" | "danger";

const TEXT_CLS: Record<ToneKey, string> = {
  "text-2": "text-text-2",
  warning: "text-warning",
  danger: "text-danger",
};
const BG_CLS: Record<ToneKey, string> = {
  "text-2": "bg-text-2",
  warning: "bg-warning",
  danger: "bg-danger",
};

function toneKey(pct: number): ToneKey {
  if (pct >= 80) return "danger";
  if (pct >= 75) return "warning";
  return "text-2";
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

function chipText(
  guard_state: GuardState,
  worst_pct: number | null,
  active_claims: number,
  nowSec: number,
  limit_resume_at: number | null,
): string {
  switch (guard_state) {
    case "soft_paused":
      return `Not taking new tasks (${Math.round(worst_pct ?? 0)}%)`;
    case "draining":
      return `Draining — finishing ${active_claims} task${active_claims === 1 ? "" : "s"}`;
    case "stopped":
      if (limit_resume_at !== null) {
        return `Stopped — resumes in ${fmtCountdown(limit_resume_at - nowSec)}`;
      }
      return "Stopped";
    default:
      return "Running";
  }
}

function chipTone(guard_state: GuardState): ToneKey {
  if (guard_state === "stopped") return "danger";
  if (guard_state === "draining" || guard_state === "soft_paused") return "warning";
  return "text-2";
}

function buildTitle(limits: LimitsView, nowSec: number): string {
  const ageStr = (observed_at: number | null): string => {
    if (observed_at === null) return "?";
    const delta = nowSec - observed_at;
    return delta < 30 ? "just now" : `${Math.round(delta / 60)}m ago`;
  };
  const lines: string[] = [
    `Session (5h) • fleet worst ${limits.worst_pct !== null ? Math.round(limits.worst_pct) + "%" : "—"}`,
  ];
  for (const b of limits.buckets) {
    lines.push(
      `${b.scope}  ${b.model_bucket ?? "—"}  ${Math.round(b.used_pct)}%  (${b.source})  ${ageStr(limits.observed_at)}`,
    );
  }
  const staleTag = limits.stale ? " STALE" : "";
  lines.push(
    `Observed ${ageStr(limits.observed_at)} via ${limits.source ?? "?"}.${staleTag}`,
  );
  return lines.join("\n");
}

export function LimitsMeter() {
  const { limits, activeClaims: active_claims } = useLimits();
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!limits?.paused_by_limit || !limits?.limit_resume_at) return;
    const id = setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [limits?.paused_by_limit, limits?.limit_resume_at]);

  if (limits === null) return null;
  const isEst = limits.source === "estimate";

  const renderPct = (pct: number | null) => {
    if (pct === null) return <span>—</span>;
    const t = toneKey(pct);
    const display = Math.round(pct);
    return (
      <>
        {isEst ? (
          <span className={`italic ${TEXT_CLS[t]}`}>~{display}%</span>
        ) : (
          <span className={TEXT_CLS[t]}>{display}%</span>
        )}
        <span className="h-1 w-8 bg-border rounded-sm inline-block overflow-hidden align-middle ml-1">
          <span
            className={`h-full ${BG_CLS[t]} block`}
            style={{ width: `${display}%` }}
          />
        </span>
      </>
    );
  };

  const ct = chipTone(limits.guard_state);
  const chip = chipText(
    limits.guard_state,
    limits.worst_pct,
    active_claims,
    nowSec,
    limits.limit_resume_at,
  );

  return (
    <span
      className="inline-flex items-center gap-1.5 text-text-2"
      title={buildTitle(limits, nowSec)}
    >
      <Gauge className="h-3.5 w-3.5 shrink-0" />
      <span>Session</span>
      {renderPct(limits.session_pct)}
      <span className="mx-0.5">·</span>
      <span>Weekly</span>
      {renderPct(limits.weekly_pct)}
      {isEst && (
        // The tilde alone reads as truth at a glance — say it outright.
        <span className="italic opacity-70">est.</span>
      )}
      <span className="mx-0.5">·</span>
      <span className={TEXT_CLS[ct]}>{chip}</span>
    </span>
  );
}
