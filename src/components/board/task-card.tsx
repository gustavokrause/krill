"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useDraggable } from "@dnd-kit/core";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  CircleDashed,
  Code2,
  Eye,
  FastForward,
  FlaskConical,
  GitBranch,
  Link2,
  Pause,
  Pencil,
  Upload,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Project, ReviewKind, Task, TaskStatus } from "@/db/schema";
import type { StuckEntry } from "@/lib/client/api";
import { DRAG_ACTIVATION_PX } from "./drag-constants";
import { PriorityBadge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { formatTokens } from "@/lib/client/format";

const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  BACKLOG: CircleDashed,
  TODO: Circle,
  PLANNING: Pencil,
  IMPLEMENTING: Code2,
  "AI-REVIEW": Bot,
  VERIFYING: FlaskConical,
  PUBLISHING: Upload,
  NEEDS_REVIEW: Eye,
  DONE: CheckCircle2,
  CANCELED: XCircle,
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  BACKLOG: "text-text-3",
  TODO: "text-info",
  PLANNING: "text-info",
  IMPLEMENTING: "text-info",
  "AI-REVIEW": "text-warning",
  VERIFYING: "text-warning",
  PUBLISHING: "text-info",
  NEEDS_REVIEW: "text-warning",
  DONE: "text-success",
  CANCELED: "text-muted",
};

const KIND_LABEL: Record<ReviewKind, string> = {
  plan: "plan",
  deliverable: "deliverable",
  conflict: "conflict",
  empty: "empty",
  verify: "verify",
  question: "question",
  declined: "rejected",
  stuck: "stuck",
};

const KIND_COLOR: Record<ReviewKind, string> = {
  plan: "bg-info/10 text-info border-info/40",
  deliverable: "bg-success/10 text-success border-success/40",
  conflict: "bg-danger/10 text-danger border-danger/40",
  empty: "bg-warning/10 text-warning border-warning/40",
  verify: "bg-warning/10 text-warning border-warning/40",
  question: "bg-danger/10 text-danger border-danger/40",
  // Rejected by AI-REVIEW — danger, never success. A rejected change must not
  // read like an approved deliverable (the green that caused the bad DONE).
  declined: "bg-danger/10 text-danger border-danger/40",
  // Stage never concluded — needs human unsticking, same urgency as question.
  stuck: "bg-danger/10 text-danger border-danger/40",
};

const TERMINAL = new Set<TaskStatus>(["DONE", "CANCELED"]);

// Stages that hold a claim while a worker runs them. A held claim from a prior
// process (claim_gen ≠ current boot id) in one of these = orphaned worker.
const ACTIVE_CLAIMED = new Set<TaskStatus>([
  "PLANNING",
  "IMPLEMENTING",
  "AI-REVIEW",
  "VERIFYING",
  "PUBLISHING",
]);

const STALE_THRESHOLD_SEC = 86400;

function fmtCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ageLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / (86400 * 30))}mo`;
}

function ageColor(seconds: number): string {
  const days = seconds / 86400;
  if (days >= 7) return "text-danger";
  if (days >= 3) return "text-warning";
  return "text-text-3";
}

export function TaskCard({
  task,
  project,
  stuck,
  bootId,
  onRecover,
  isDraggable,
  dependencies = [],
  selected = false,
  onShiftSelect,
}: {
  task: Task;
  project?: Project;
  stuck?: StuckEntry;
  bootId?: string | null;
  onRecover?: (id: string) => void;
  isDraggable?: boolean;
  dependencies?: Array<{ id: string; status: TaskStatus; name: string }>;
  selected?: boolean;
  onShiftSelect?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { status: task.status },
    disabled: !isDraggable,
  });

  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  function handlePointerDown(e: React.PointerEvent<HTMLAnchorElement>) {
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
    listeners?.onPointerDown?.(e);
  }

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    const pd = pointerDownRef.current;
    pointerDownRef.current = null;
    if (e.shiftKey && isDraggable) {
      e.preventDefault();
      onShiftSelect?.(task.id);
      return;
    }
    if (pd) {
      const dx = e.clientX - pd.x;
      const dy = e.clientY - pd.y;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_ACTIVATION_PX) {
        e.preventDefault();
      }
    }
  }

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const ageSec = Math.floor(Date.now() / 1000) - task.stage_entered_at;
  const showAge =
    mounted && !TERMINAL.has(task.status) && ageSec >= STALE_THRESHOLD_SEC;

  // Orphaned claim: the worker that claimed this died with its process (its
  // claim_gen no longer matches the running boot id). The task is stranded in
  // its stage until the claim TTL lapses — surface it + offer manual recover.
  // A held claim whose generation isn't this process's was made by a dead one.
  // `claim_gen !== bootId` also catches NULL (legacy claims from before this
  // feature, or in-flight tasks killed by the very restart that deployed it):
  // the new code stamps claim_gen on every claim, so anything else is orphaned.
  const orphaned =
    mounted &&
    !!bootId &&
    !!task.claimed_by &&
    task.claim_gen !== bootId &&
    ACTIVE_CLAIMED.has(task.status);

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!orphaned) return;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [orphaned]);
  const recoverEta = (task.claimed_until ?? 0) - nowSec;

  const Icon = STATUS_ICON[task.status];
  const iconColor = STATUS_COLOR[task.status];
  // Auto-finish armed + still in flight → highlight the whole card, not just the badge.
  const armed = task.auto_publish && !TERMINAL.has(task.status);
  const kind = task.pending_review_kind;
  const skipLabels: string[] = [];
  if (task.skip_plan) skipLabels.push("skip plan");
  if (task.skip_plan_review) skipLabels.push("skip plan review");
  if (task.skip_ai_review) skipLabels.push("skip AI review");

  // Token badge: actual used vs whale's pre-flight estimate. Nothing metered and
  // no estimate → hide. Over the estimate → warning color.
  const showTokens = !(task.tokens_used === 0 && task.est_tokens == null);
  const overBudget =
    task.est_tokens != null && task.tokens_used > task.est_tokens;

  return (
    <Link
      href={`/tasks/${task.id}`}
      ref={setNodeRef}
      style={isDragging ? { visibility: "hidden" as const } : undefined}
      {...attributes}
      {...listeners}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      className={`block border rounded-sm px-3 py-2 hover:border-border-strong ${selected ? "ring-1 ring-primary" : ""} ${
        orphaned
          ? "border-danger/50 bg-danger/5"
          : armed
            ? "border-warning/50 bg-warning/5"
            : "border-border bg-surface-2"
      }`}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={`h-4 w-4 mt-0.5 shrink-0 ${iconColor}`}
          aria-label={task.status}
        />
        <p
          className="text-sm text-text leading-snug font-medium line-clamp-2"
          title={task.status}
        >
          {task.name}
        </p>
        {stuck ? (
          <Tooltip
            title="Stuck"
            description={`In ${stuck.stage} for ${ageLabel(stuck.ageSec)} (max ${ageLabel(stuck.maxSec)}). Unclaimed past stage timeout.`}
            side="top"
          >
            <span
              role="img"
              aria-label={`Stuck in ${stuck.stage}`}
              className="mt-0.5 shrink-0 inline-flex items-center text-danger"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
          </Tooltip>
        ) : null}
        {project?.paused ? (
          <Tooltip
            title="Project paused"
            description={`Parent project "${project.name}" is paused. No new tasks will be picked.`}
            side="top"
          >
            <span
              role="img"
              aria-label="Project paused"
              className="mt-0.5 shrink-0 inline-flex items-center text-warning"
            >
              <Pause className="h-3.5 w-3.5" />
            </span>
          </Tooltip>
        ) : null}
      </div>
      {orphaned ? (
        <div className="mt-1.5 flex items-center justify-between gap-2 rounded-sm border border-danger/40 bg-danger/10 px-2 py-1">
          <Tooltip
            title="Worker dead"
            description={`The krill process running this stage died (restart or crash), orphaning its claim. The task is stranded in ${task.status}${
              recoverEta > 0
                ? ` until the claim lapses — auto-recovers in ${fmtCountdown(recoverEta)}`
                : " — reclaiming now"
            }. Click Recover to release the claim immediately so it can be re-picked.`}
            side="top"
          >
            <span className="inline-flex items-center gap-1 text-[11px] text-danger font-medium min-w-0">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="shrink-0">worker dead</span>
              <span className="truncate text-danger/80">
                ·{" "}
                {recoverEta > 0
                  ? `auto-recovers in ${fmtCountdown(recoverEta)}`
                  : "reclaiming…"}
              </span>
            </span>
          </Tooltip>
          <button
            type="button"
            aria-label={`Recover ${task.id}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRecover?.(task.id);
            }}
            className="shrink-0 px-2 py-0.5 rounded-sm bg-danger text-white text-[11px] font-medium hover:bg-danger/90"
          >
            Recover
          </button>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 mt-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <PriorityBadge priority={task.priority} />
          {task.blocked ? (
            <Tooltip
              title="Paused on a blocker"
              description="Needs an interactive auth/login the runner can't do. Resolve it in the banner above (authenticate, then Resume) to re-run the stage."
              side="top"
            >
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border bg-warning/10 text-warning border-warning/40">
                <AlertTriangle className="h-2.5 w-2.5" /> blocked
              </span>
            </Tooltip>
          ) : null}
          {kind ? (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border ${KIND_COLOR[kind]}`}
            >
              {KIND_LABEL[kind]}
            </span>
          ) : null}
          <span className="font-mono text-[10px] text-text-3 truncate">
            {task.id}
          </span>
          {project ? (
            <span className="font-mono text-[10px] text-text-3 truncate">
              · {project.slug}
            </span>
          ) : null}
          {project?.has_repo ? (
            <Tooltip
              title="Git repo"
              description={`Branch: ${project.default_branch}`}
              side="top"
            >
              <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-text-3 shrink-0">
                <GitBranch className="h-2.5 w-2.5" />
                {project.default_branch}
              </span>
            </Tooltip>
          ) : null}
          {skipLabels.length > 0 ? (
            <Tooltip
              title="Skip flags"
              description={skipLabels.join(", ")}
              side="top"
            >
              <span className="inline-flex items-center gap-0.5 text-[10px] text-text-3 shrink-0">
                <FastForward className="h-2.5 w-2.5" />
                <span className="font-mono">×{skipLabels.length}</span>
              </span>
            </Tooltip>
          ) : null}
          {task.auto_publish ? (
            <Tooltip
              title="Auto-finish armed"
              description="Skips the deliverable review and merges to DONE automatically (still double-gated by the project's allow_auto_finish; AI review stays on)."
              side="top"
            >
              <span
                role="img"
                aria-label="Auto-finish armed"
                className="inline-flex items-center gap-0.5 text-[10px] text-warning shrink-0"
              >
                <Zap className="h-2.5 w-2.5" />
                <span className="font-mono">auto</span>
              </span>
            </Tooltip>
          ) : null}
          {showTokens ? (
            <Tooltip
              title="Tokens"
              description={
                (task.est_tokens != null
                  ? `${task.tokens_used.toLocaleString()} used / ${task.est_tokens.toLocaleString()} estimated${overBudget ? " — over budget" : ""}`
                  : `${task.tokens_used.toLocaleString()} tokens used (no estimate)`) +
                " — raw throughput: ~90% is the cached prefix re-read each agent turn at ~0.1x rates. Real cost is in the task's Usage tab."
              }
              side="top"
            >
              <span
                className={`font-mono text-[10px] shrink-0 ${overBudget ? "text-warning" : "text-text-3"}`}
              >
                {formatTokens(task.tokens_used)}
                {task.est_tokens != null
                  ? ` / ${formatTokens(task.est_tokens)}`
                  : ""}
              </span>
            </Tooltip>
          ) : null}
        </div>
        {showAge ? (
          <span
            className={`font-mono text-[10px] shrink-0 ${ageColor(ageSec)}`}
            title={`In ${task.status} for ${ageLabel(ageSec)}`}
          >
            {ageLabel(ageSec)}
          </span>
        ) : null}
      </div>
      {dependencies.length > 0 && !TERMINAL.has(task.status) ? (
        <Tooltip
          title="Waiting on"
          description={dependencies.map((d) => `${d.id} (${d.status})`).join(", ")}
          side="top"
        >
          <div className="flex items-center gap-1 mt-1">
            <Link2 className="h-2.5 w-2.5 shrink-0 text-text-3" />
            <span className="font-mono text-[10px] text-text-3">
              {dependencies.slice(0, 3).map((d, i) => (
                <span key={d.id}>
                  {i > 0 ? ", " : ""}
                  <span className={TERMINAL.has(d.status) ? "line-through" : ""}>
                    {d.id}
                  </span>
                </span>
              ))}
              {dependencies.length > 3 ? ` (+${dependencies.length - 3})` : ""}
            </span>
          </div>
        </Tooltip>
      ) : null}
      {task.affected_paths.length > 0 ? (
        <p className="text-[10px] text-text-3 mt-1 font-mono truncate">
          {task.affected_paths.slice(0, 2).join(" ")}
          {task.affected_paths.length > 2
            ? ` (+${task.affected_paths.length - 2})`
            : ""}
        </p>
      ) : null}
    </Link>
  );
}

export function TaskCardPreview({ task, count }: { task: Task; count?: number }) {
  const Icon = STATUS_ICON[task.status];
  const iconColor = STATUS_COLOR[task.status];
  const showBatch = count != null && count > 1;
  return (
    <div className="relative">
      {showBatch ? (
        <div
          aria-hidden
          className="absolute inset-0 translate-x-1.5 translate-y-1.5 border border-border bg-surface-2 rounded-sm"
        />
      ) : null}
      <div className="relative block border border-border bg-surface-2 rounded-sm px-3 py-2 shadow-lg">
        <div className="flex items-start gap-2">
          <Icon
            className={`h-4 w-4 mt-0.5 shrink-0 ${iconColor}`}
            aria-label={task.status}
          />
          <p className="text-sm text-text leading-snug font-medium line-clamp-2">
            {task.name}
          </p>
          {showBatch ? (
            <span className="ml-auto shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-mono font-medium bg-primary text-white">
              +{count - 1}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
