"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  CircleDashed,
  Code2,
  Eye,
  FastForward,
  GitBranch,
  Pause,
  Pencil,
  Upload,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { Project, Task, TaskStatus } from "@/db/schema";
import type { StuckEntry } from "@/lib/client/api";
import { PriorityBadge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";

const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  BACKLOG: CircleDashed,
  TODO: Circle,
  PLANNING: Pencil,
  IMPLEMENTING: Code2,
  "AI-REVIEW": Bot,
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
  PUBLISHING: "text-info",
  NEEDS_REVIEW: "text-warning",
  DONE: "text-success",
  CANCELED: "text-muted",
};

const KIND_LABEL: Record<"plan" | "deliverable" | "conflict", string> = {
  plan: "plan",
  deliverable: "deliverable",
  conflict: "conflict",
};

const KIND_COLOR: Record<"plan" | "deliverable" | "conflict", string> = {
  plan: "bg-info/10 text-info border-info/40",
  deliverable: "bg-success/10 text-success border-success/40",
  conflict: "bg-danger/10 text-danger border-danger/40",
};

const TERMINAL = new Set<TaskStatus>(["DONE", "CANCELED"]);

const STALE_THRESHOLD_SEC = 86400;

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
}: {
  task: Task;
  project?: Project;
  stuck?: StuckEntry;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const ageSec = Math.floor(Date.now() / 1000) - task.stage_entered_at;
  const showAge =
    mounted && !TERMINAL.has(task.status) && ageSec >= STALE_THRESHOLD_SEC;

  const Icon = STATUS_ICON[task.status];
  const iconColor = STATUS_COLOR[task.status];
  const kind = task.pending_review_kind;
  const skipLabels: string[] = [];
  if (task.skip_plan) skipLabels.push("skip plan");
  if (task.skip_plan_review) skipLabels.push("skip plan review");
  if (task.skip_ai_review) skipLabels.push("skip AI review");

  return (
    <Link
      href={`/tasks/${task.id}`}
      className="block border border-border rounded-sm bg-surface-2 px-3 py-2 hover:border-border-strong"
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
      <div className="flex items-center justify-between gap-2 mt-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <PriorityBadge priority={task.priority} />
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
