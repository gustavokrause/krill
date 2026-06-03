import { cn } from "@/lib/utils";
import type { Priority, TaskStatus } from "@/db/schema";

const STATUS_CLASS: Record<TaskStatus, string> = {
  BACKLOG: "border border-border text-text-2",
  TODO: "bg-info text-white",
  PLANNING: "bg-info text-white",
  IMPLEMENTING: "bg-info text-white",
  "AI-REVIEW": "bg-warning text-white",
  PUBLISHING: "bg-info text-white",
  NEEDS_REVIEW: "bg-warning text-white",
  DONE: "bg-success text-white",
  CANCELED: "bg-muted text-white",
};

const PRIORITY_BASE = "border border-border-strong bg-surface";
const PRIORITY_CLASS: Record<Priority, string> = {
  P0: `${PRIORITY_BASE} text-danger`,
  P1: `${PRIORITY_BASE} text-warning`,
  P2: `${PRIORITY_BASE} text-text-2`,
  P3: `${PRIORITY_BASE} text-text-3`,
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium font-mono",
        STATUS_CLASS[status],
      )}
    >
      {status}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium font-mono",
        PRIORITY_CLASS[priority],
      )}
    >
      {priority}
    </span>
  );
}

export function Pill({
  children,
  active = false,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center h-9 px-3 rounded text-sm font-medium border whitespace-nowrap shrink-0",
        active
          ? "bg-text text-bg border-text"
          : "bg-surface text-text-2 border-border hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
