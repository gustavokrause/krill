"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Activity,
  Check,
  ListFilter,
  Maximize2,
  Minimize2,
  Pause,
  Plus,
  User,
} from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import {
  type GlobalConfig,
  type Project,
  type Task,
  type TaskStatus,
  TASK_STATUSES,
} from "@/db/schema";
import { api, type HealthSnapshot, type StuckEntry } from "@/lib/client/api";
import { useEventSource } from "@/lib/client/use-event-source";
import { BlockersBanner } from "@/components/board/blockers-banner";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TaskCard, TaskCardPreview } from "./task-card";
import { DRAG_ACTIVATION_PX } from "./drag-constants";
import { WorkflowModal } from "./workflow-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CancelTaskDialog, type CancelOptions } from "./cancel-task-dialog";

type ColumnDef = {
  title: string;
  statuses: TaskStatus[];
};

const COLUMNS: ColumnDef[] = [
  { title: "Intake", statuses: ["BACKLOG", "TODO"] },
  { title: "In progress", statuses: ["PLANNING", "IMPLEMENTING", "PUBLISHING"] },
  { title: "AI review", statuses: ["AI-REVIEW"] },
  { title: "Needs review", statuses: ["NEEDS_REVIEW"] },
  { title: "Done", statuses: ["DONE"] },
  { title: "Canceled", statuses: ["CANCELED"] },
];

const EXPANDABLE_TITLES = new Set(["Intake", "In progress"]);

// Terminal columns (DONE/CANCELED) accumulate forever — a time window keeps them
// lean. Active columns self-drain, so the window NEVER touches them.
const TERMINAL_STATUSES = new Set<TaskStatus>(["DONE", "CANCELED"]);
type TermWindow = "week" | "lastweek" | "month" | "all";
const TERM_WINDOWS: { value: TermWindow; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "lastweek", label: "Last week" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

// [start, end) in unix seconds for a window; weeks start Monday.
function termRange(w: TermWindow): { start: number; end: number } {
  if (w === "all") return { start: -Infinity, end: Infinity };
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const mondayOffset = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  const startOfWeek = new Date(d);
  startOfWeek.setDate(d.getDate() - mondayOffset);
  const sow = startOfWeek.getTime() / 1000;
  if (w === "week") return { start: sow, end: Infinity };
  if (w === "lastweek") {
    const prev = new Date(startOfWeek);
    prev.setDate(startOfWeek.getDate() - 7);
    return { start: prev.getTime() / 1000, end: sow };
  }
  // month
  const som = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
  return { start: som, end: Infinity };
}

const EXPANDED_STORAGE_KEY = "board.expandedColumns";
const PROJECT_FILTER_KEY = "board.projectFilter";

const COLUMN_MIN_WIDTH_PX = 220;
const CANCELED_MIN_WIDTH_PX = 140;

const SPAN_BY_COUNT: Record<number, string> = {
  2: "col-span-2",
  3: "col-span-3",
};

const COLUMN_TITLE_COLOR: Record<string, string> = {
  "In progress": "text-info",
  "AI review": "text-warning",
  "Needs review": "text-warning",
  Canceled: "text-text-3",
};

const COLUMN_DIM: Record<string, string> = {
  Canceled: "opacity-75",
};

const SUB_GRID_BY_COUNT: Record<number, string> = {
  2: "p-2 grid grid-cols-2 gap-2 flex-1 min-h-0 bg-neutral-100 dark:bg-neutral-950",
  3: "p-2 grid grid-cols-3 gap-2 flex-1 min-h-0 bg-neutral-100 dark:bg-neutral-950",
};

type Owner = "human" | "ai";

const HUMAN_STATUSES = new Set<TaskStatus>([
  "BACKLOG",
  "NEEDS_REVIEW",
]);
const AI_STATUSES = new Set<TaskStatus>([
  "PLANNING",
  "IMPLEMENTING",
  "AI-REVIEW",
]);

// Drag-and-drop transition matrix. Humans can drag from `source` to any status
// in `DRAG_ALLOWED_TO[source]`. AI-owned columns (PLANNING/IMPLEMENTING/
// AI-REVIEW/PUBLISHING) and terminals (DONE/CANCELED) are not drag sources —
// automation or workflow rules own those transitions.
const DRAG_ALLOWED_TO: Record<TaskStatus, TaskStatus[]> = {
  BACKLOG: ["TODO", "CANCELED"],
  TODO: ["BACKLOG", "CANCELED"],
  NEEDS_REVIEW: ["DONE", "IMPLEMENTING", "CANCELED"],
  PLANNING: [],
  IMPLEMENTING: [],
  "AI-REVIEW": [],
  PUBLISHING: [],
  DONE: [],
  CANCELED: [],
};

const DROPPABLE_STATUSES: Set<TaskStatus> = new Set(
  Object.values(DRAG_ALLOWED_TO).flat(),
);

function ownerOf(status: TaskStatus): Owner | null {
  if (HUMAN_STATUSES.has(status)) return "human";
  if (AI_STATUSES.has(status)) return "ai";
  return null;
}

function wrapperOwner(statuses: TaskStatus[]): Owner | null {
  const owners = statuses.map(ownerOf);
  const first = owners[0];
  if (!first) return null;
  return owners.every((o) => o === first) ? first : null;
}

function TodoPickerToggle({
  enabled,
  saving,
  onToggle,
}: {
  enabled: boolean;
  saving: boolean;
  onToggle: () => void;
}) {
  const label = enabled
    ? "Disable auto TODO picker"
    : "Enable auto TODO picker";
  const hint = enabled
    ? "Stop auto-picking new TODOs. In-flight tasks keep running — use when planning a new batch."
    : "Resume auto-picking new TODOs for in-progress work.";
  return (
    <Tooltip title={label} description={hint} side="bottom">
      <button
        type="button"
        onClick={onToggle}
        disabled={saving}
        aria-label={label}
        aria-pressed={enabled}
        className={cn(
          "relative inline-flex items-center justify-center h-5 px-1.5 rounded leading-none text-[10px] font-mono font-medium uppercase tracking-wide",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
          "disabled:opacity-50",
          enabled
            ? "text-success hover:bg-success/10"
            : "text-primary hover:bg-primary/10",
        )}
      >
        {enabled ? "Running" : "Play"}
      </button>
    </Tooltip>
  );
}

function MasterKillSwitch({
  enabled,
  saving,
  onToggle,
}: {
  enabled: boolean;
  saving: boolean;
  onToggle: () => Promise<void> | void;
}) {
  const label = enabled ? "Pause automation" : "Resume automation";
  const hint = enabled
    ? "Master kill switch. Click to pause every stage (handlers exit no-op). In-flight subprocesses keep running until they finish."
    : "Resume automation. Cron lanes will pick up their schedules.";

  const button = (
    <button
      type="button"
      onClick={enabled ? undefined : () => onToggle()}
      disabled={saving}
      aria-label={label}
      aria-pressed={enabled}
      className={cn(
        "inline-flex items-center gap-1.5 h-9 px-2 sm:px-2.5 rounded border border-border bg-surface",
        "text-xs font-mono font-medium uppercase tracking-wide leading-none",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
        "disabled:opacity-50",
        enabled
          ? "text-success hover:bg-success/5 hover:border-success/40"
          : "text-danger hover:bg-danger/5 hover:border-danger/40",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          enabled ? "bg-success" : "bg-danger",
        )}
      />
      <span className="hidden sm:inline">
        {enabled ? "Automation" : "Paused"}
      </span>
    </button>
  );

  if (!enabled) {
    return (
      <Tooltip title={label} description={hint} side="bottom">
        {button}
      </Tooltip>
    );
  }

  return (
    <ConfirmDialog
      title="Pause automation?"
      description="Every stage will exit no-op. In-flight subprocesses keep running until they finish. You can resume any time."
      confirmLabel="Pause automation"
      busyLabel="Pausing…"
      confirmVariant="danger"
      trigger={button}
      onConfirm={onToggle}
    />
  );
}

function OwnerBadge({ owner }: { owner: Owner }) {
  const cls =
    owner === "human"
      ? "border border-border-strong bg-surface text-human"
      : "border border-border-strong bg-surface text-ai";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide ${cls}`}
    >
      {owner}
    </span>
  );
}

function FilterMenu({
  selected,
  onChange,
}: {
  selected: Set<TaskStatus>;
  onChange: (next: Set<TaskStatus>) => void;
}) {
  const toggle = (s: TaskStatus) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onChange(next);
  };
  const count = selected.size;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Filter by status"
          title="Filter by status"
          className="relative inline-flex items-center justify-center h-9 w-9 rounded text-text hover:bg-surface focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          <ListFilter className="h-4 w-4" />
          {count > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full bg-primary text-white text-[10px] font-mono inline-flex items-center justify-center">
              {count}
            </span>
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[200px] rounded border border-border bg-surface p-1 shadow-md"
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-xs font-medium text-text-2">Status</span>
            {count > 0 ? (
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="text-xs text-text-2 hover:text-text"
              >
                Clear
              </button>
            ) : null}
          </div>
          <div className="h-px bg-border my-1" />
          {TASK_STATUSES.map((s) => {
            const checked = selected.has(s);
            return (
              <DropdownMenu.CheckboxItem
                key={s}
                checked={checked}
                onCheckedChange={() => toggle(s)}
                onSelect={(e) => e.preventDefault()}
                className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer outline-none data-[highlighted]:bg-border"
              >
                <span className="inline-flex items-center justify-center h-4 w-4">
                  {checked ? <Check className="h-3.5 w-3.5" /> : null}
                </span>
                <span className="font-mono text-xs">{s}</span>
              </DropdownMenu.CheckboxItem>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function useNowSec(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      intervalMs,
    );
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function fmtCountdown(sec: number): string {
  if (sec <= 0) return "0s";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60 ? ` ${sec % 60}s` : ""}`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function ActiveRunsPill({
  health,
  tasks,
  projects,
}: {
  health: HealthSnapshot | null;
  tasks: Task[];
  projects: Map<string, Project>;
}) {
  const nowSec = useNowSec();
  const claimed = useMemo(
    () =>
      tasks.filter(
        (t) => t.claimed_until != null && t.claimed_until > nowSec,
      ),
    [tasks, nowSec],
  );
  const count = health?.active_tasks ?? claimed.length;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Active runs: ${count}`}
          className={cn(
            "inline-flex items-center gap-1.5 h-9 px-2 sm:px-2.5 rounded border border-border bg-surface",
            "text-xs font-mono font-medium uppercase tracking-wide leading-none",
            "hover:border-border-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
            count > 0 ? "text-info" : "text-text-3",
          )}
        >
          <Activity className="h-3.5 w-3.5" />
          <span className="font-mono">{count}</span>
          <span className="hidden sm:inline">active</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[280px] max-w-[360px] rounded border border-border bg-surface p-2 shadow-md"
        >
          <div className="flex items-center justify-between px-1 pb-2 mb-1 border-b border-border">
            <span className="text-xs font-medium text-text-2">
              Active runs ({count})
            </span>
            {health ? (
              <span className="text-[10px] text-text-3 font-mono">
                health.active_tasks
              </span>
            ) : null}
          </div>
          {claimed.length === 0 ? (
            <p className="text-xs text-text-3 px-1 py-2">No claimed tasks.</p>
          ) : (
            <ul className="space-y-1">
              {claimed.map((t) => {
                const ttl = (t.claimed_until ?? 0) - nowSec;
                const proj = projects.get(t.project_id);
                return (
                  <li
                    key={t.id}
                    className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-2"
                  >
                    <Link
                      href={`/tasks/${t.id}`}
                      className="flex-1 min-w-0 flex items-center gap-1.5"
                    >
                      <span className="font-mono text-[10px] text-text-3 shrink-0">
                        {proj?.slug ?? "—"}
                      </span>
                      <span className="text-xs truncate">{t.name}</span>
                    </Link>
                    <Tooltip
                      title="Claim TTL"
                      description={`Claimed by ${t.claimed_by ?? "?"} for ${t.status}. Expires in ${fmtCountdown(ttl)}.`}
                      side="left"
                    >
                      <span
                        className={cn(
                          "font-mono text-[10px] shrink-0",
                          ttl < 30 ? "text-warning" : "text-text-3",
                        )}
                      >
                        {fmtCountdown(ttl)}
                      </span>
                    </Tooltip>
                    {t.claimed_by ? (
                      <Tooltip
                        title="Worker"
                        description={t.claimed_by}
                        side="left"
                      >
                        <span className="inline-flex items-center text-text-3">
                          <User className="h-3 w-3" />
                        </span>
                      </Tooltip>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function BackoffBanner({ health }: { health: HealthSnapshot | null }) {
  const nowSec = useNowSec();
  const active = useMemo(() => {
    if (!health) return [];
    return Object.entries(health.backoff)
      .filter(([, v]) => v != null && v.nextAttemptAt > nowSec)
      .map(([stage, v]) => ({
        stage,
        remaining: v!.nextAttemptAt - nowSec,
        attempts: v!.attempts,
      }));
  }, [health, nowSec]);

  if (active.length === 0) return null;

  return (
    <div className="mb-3 rounded border border-warning/40 bg-warning/5 px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <Pause className="h-3.5 w-3.5 text-warning" />
        <span className="text-xs font-medium text-warning">
          {active.length === 1
            ? "1 stage in backoff"
            : `${active.length} stages in backoff`}
        </span>
      </div>
      <ul className="space-y-0.5">
        {active.map((b) => (
          <li
            key={b.stage}
            className="flex items-center gap-2 text-[11px] font-mono text-text-2"
          >
            <span className="text-text">{b.stage}</span>
            <span>paused for {fmtCountdown(b.remaining)}</span>
            <span className="text-text-3">
              (attempts: {b.attempts})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Board({
  initialTasks,
  projects,
  initialConfig,
}: {
  initialTasks: Task[];
  projects: Project[];
  initialConfig: GlobalConfig;
}) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [config, setConfig] = useState<GlobalConfig>(initialConfig);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const activeStatus = activeTask?.status ?? null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_PX } }),
  );
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [stuckMap, setStuckMap] = useState<Map<string, StuckEntry>>(
    () => new Map(),
  );
  const [filter, setFilter] = useState<Set<TaskStatus>>(() => new Set());
  const [termWindow, setTermWindow] = useState<TermWindow>("week");
  const [expandedColumns, setExpandedColumns] = useState<Set<string>>(
    () => new Set(EXPANDABLE_TITLES),
  );
  const toast = useToast();
  const [pickerSaving, setPickerSaving] = useState(false);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [pendingCancel, setPendingCancel] = useState<{ task: Task; snapshot: Task } | null>(null);

  // useState seeds once on mount; re-sync when the server prop changes so
  // router.refresh() (fired after create/edit) surfaces new rows. Without
  // this, only a full reload remounts and picks up fresh data.
  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);

  const toggleAutomation = useCallback(async () => {
    const next = !config.automation_enabled;
    setAutomationSaving(true);
    try {
      const updated = await api.patchConfig({ automation_enabled: next });
      setConfig(updated);
      toast.push({
        variant: "success",
        title: next ? "Automation enabled" : "Automation paused",
      });
    } catch (err) {
      toast.push({
        variant: "danger",
        title: "Save failed",
        description: (err as Error).message,
      });
    } finally {
      setAutomationSaving(false);
    }
  }, [config.automation_enabled, toast]);

  const toggleTodoPicker = useCallback(async () => {
    const next = !config.stage_enabled.todo_picker;
    setPickerSaving(true);
    try {
      const updated = await api.patchConfig({
        stage_enabled: { ...config.stage_enabled, todo_picker: next },
      });
      setConfig(updated);
      toast.push({
        variant: "success",
        title: `TODO picker ${next ? "enabled" : "disabled"}`,
      });
    } catch (err) {
      toast.push({
        variant: "danger",
        title: "Save failed",
        description: (err as Error).message,
      });
    } finally {
      setPickerSaving(false);
    }
  }, [config.stage_enabled, toast]);

  useEffect(() => {
    let cancelled = false;
    const fetchHealth = () =>
      api
        .getHealth()
        .then((h) => {
          if (cancelled) return;
          setHealth(h);
          setStuckMap(new Map(h.stuck.map((s) => [s.taskId, s])));
        })
        .catch(() => {
          // health endpoint failure is non-fatal; badges simply absent
        });
    fetchHealth();
    const id = setInterval(fetchHealth, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const valid = parsed.filter(
        (t): t is string => typeof t === "string" && EXPANDABLE_TITLES.has(t),
      );
      setExpandedColumns(new Set(valid));
    } catch {
      // ignore corrupt storage
    }
  }, []);

  const toggleExpanded = useCallback((title: string) => {
    setExpandedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      try {
        window.localStorage.setItem(
          EXPANDED_STORAGE_KEY,
          JSON.stringify(Array.from(next)),
        );
      } catch {
        // ignore quota / disabled storage
      }
      return next;
    });
  }, []);

  const upsertTask = useCallback((next: Task) => {
    setTasks((prev) => {
      const i = prev.findIndex((t) => t.id === next.id);
      if (i === -1) return [next, ...prev];
      const copy = prev.slice();
      copy[i] = next;
      return copy;
    });
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Recover an orphaned-claim task: force-release the dead worker's claim so the
  // next stage tick re-picks it now instead of waiting out the claim TTL.
  const recover = useCallback(
    async (id: string) => {
      try {
        upsertTask(await api.recoverTask(id));
      } catch {
        // SSE / next focus reconcile if the request raced a real change
      }
    },
    [upsertTask],
  );

  const byProject = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const onDragStart = useCallback(({ active }: DragStartEvent) => {
    setActiveTask(tasks.find((t) => t.id === active.id) ?? null);
  }, [tasks]);

  const fireCancelTransition = useCallback(
    (task: Task, snapshot: Task, cancelOpts?: CancelOptions) => {
      void api.transitionTask(task.id, { to: "CANCELED", ...(cancelOpts ? { cancel_options: cancelOpts } : {}) }).then(
        (updated) => {
          upsertTask(updated);
          toast.push({ variant: "success", title: "Moved to CANCELED" });
        },
        (err) => {
          upsertTask(snapshot);
          toast.push({
            variant: "danger",
            title: "Transition failed",
            description: (err as Error).message,
          });
        },
      );
    },
    [upsertTask, toast],
  );

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      setActiveTask(null);
      if (!over) return;
      const task = tasks.find((t) => t.id === active.id);
      if (!task) return;
      const from = task.status;
      const to = over.id as TaskStatus;
      if (!DRAG_ALLOWED_TO[from].includes(to)) return;
      const snapshot = task;

      // When dragging to CANCELED on a repo project with a PR or branch,
      // pause and open the cancel dialog instead of firing immediately.
      if (to === "CANCELED") {
        const proj = byProject.get(task.project_id);
        const hasPrUrl = !!(task.delivery_url?.startsWith("http"));
        const hasBranch = !!task.branch;
        if (proj?.has_repo && (hasPrUrl || hasBranch)) {
          upsertTask({ ...task, status: to });
          setPendingCancel({ task, snapshot });
          return;
        }
      }

      upsertTask({ ...task, status: to });
      void api.transitionTask(task.id, { to }).then(
        (updated) => {
          upsertTask(updated);
          toast.push({ variant: "success", title: `Moved to ${to}` });
        },
        (err) => {
          upsertTask(snapshot);
          toast.push({
            variant: "danger",
            title: "Transition failed",
            description: (err as Error).message,
          });
        },
      );
    },
    [tasks, upsertTask, toast, byProject],
  );

  const onDragCancel = useCallback(() => setActiveTask(null), []);

  // SSE has no replay: a task pushed from whale (or any external create) while
  // this tab is backgrounded/disconnected emits a task.updated we never see, so
  // the board looks stale until a manual reload. Resync the authoritative list
  // whenever the tab regains visibility/focus or the stream reconnects.
  const resync = useCallback(async () => {
    try {
      setTasks(await api.listTasks());
    } catch {
      // transient — SSE + the next focus/visibility tick will recover
    }
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void resync();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", resync);
    };
  }, [resync]);

  const clearStuck = useCallback((id: string) => {
    setStuckMap((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  useEventSource({
    onOpen: resync,
    "task.updated": (e) => e.type === "task.updated" && upsertTask(e.task),
    "task.transitioned": (e) => {
      if (e.type !== "task.transitioned") return;
      upsertTask(e.task);
      clearStuck(e.task.id);
    },
    "task.deleted": (e) => {
      if (e.type !== "task.deleted") return;
      removeTask(e.taskId);
      clearStuck(e.taskId);
    },
    "task.stuck": (e) => {
      if (e.type !== "task.stuck") return;
      setStuckMap((prev) => {
        const next = new Map(prev);
        next.set(e.taskId, {
          taskId: e.taskId,
          stage: e.stage,
          ageSec: e.ageSec,
          maxSec: e.maxSec,
        });
        return next;
      });
    },
    "config.changed": (e) => e.type === "config.changed" && setConfig(e.config),
  });

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const bySlug = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.slug, p);
    return map;
  }, [projects]);

  const rawSlug = searchParams.get("project");
  const projectFilter =
    rawSlug && bySlug.has(rawSlug) ? rawSlug : "all";

  const setProjectFilter = useCallback(
    (v: string) => {
      // Persist the choice so it sticks across reloads / nav back to a bare `/`
      // (the URL alone is lost the moment you leave the board and return).
      try {
        window.localStorage.setItem(PROJECT_FILTER_KEY, v);
      } catch {
        // ignore quota / disabled storage
      }
      const next = new URLSearchParams(searchParams.toString());
      if (v === "all") next.delete("project");
      else next.set("project", v);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Restore the last project filter on mount when the URL carries none. The URL
  // wins if present (shareable/explicit); otherwise fall back to localStorage.
  const restoredFilter = useRef(false);
  useEffect(() => {
    if (restoredFilter.current) return;
    if (searchParams.get("project")) {
      restoredFilter.current = true; // explicit URL filter — leave it
      return;
    }
    if (bySlug.size === 0) return; // wait until projects are known
    restoredFilter.current = true;
    try {
      const stored = window.localStorage.getItem(PROJECT_FILTER_KEY);
      if (stored && stored !== "all" && bySlug.has(stored)) setProjectFilter(stored);
    } catch {
      // ignore
    }
  }, [bySlug, searchParams, setProjectFilter]);

  const byTaskId = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  const filteredProjectId =
    projectFilter === "all" ? null : bySlug.get(projectFilter)?.id ?? null;

  const scopedTasks = useMemo(
    () =>
      filteredProjectId == null
        ? tasks
        : tasks.filter((t) => t.project_id === filteredProjectId),
    [tasks, filteredProjectId],
  );

  const visible = useMemo(() => {
    if (filter.size === 0) return scopedTasks;
    return scopedTasks.filter((t) => filter.has(t.status));
  }, [scopedTasks, filter]);

  // Apply the time window to terminal tasks only; active tasks always show.
  const windowed = useMemo(() => {
    if (termWindow === "all") return visible;
    const { start, end } = termRange(termWindow);
    return visible.filter(
      (t) =>
        !TERMINAL_STATUSES.has(t.status) ||
        (t.ended_at != null && t.ended_at >= start && t.ended_at < end),
    );
  }, [visible, termWindow]);

  const newTaskHref =
    projectFilter === "all"
      ? "/tasks/new"
      : `/tasks/new?project=${projectFilter}`;

  return (
    <main className="flex-1 flex flex-col min-h-0 px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <BlockersBanner />
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h1 className="hidden lg:block text-xl font-bold mr-2">Board</h1>
        <Link
          href="/projects"
          className="hidden lg:inline text-sm text-text-2 hover:text-text underline-offset-2 hover:underline"
        >
          {projects.length} project{projects.length === 1 ? "" : "s"}
        </Link>
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.slug}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <ActiveRunsPill
          health={health}
          tasks={scopedTasks}
          projects={byProject}
        />
        <MasterKillSwitch
          enabled={config.automation_enabled}
          saving={automationSaving}
          onToggle={toggleAutomation}
        />
        <Select value={termWindow} onValueChange={(v) => setTermWindow(v as TermWindow)}>
          <SelectTrigger className="h-9 w-[128px]" title="Done / Canceled time window (by finish date)">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TERM_WINDOWS.map((w) => (
              <SelectItem key={w.value} value={w.value}>
                {w.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FilterMenu selected={filter} onChange={setFilter} />
        <WorkflowModal />
        <Link href={newTaskHref}>
          <Button size="default">New task</Button>
        </Link>
      </div>

      <BackoffBanner health={health} />

      {/* Mobile + tablet: single-column list */}
      <div className="lg:hidden">
        <div className="space-y-2">
          {windowed.length === 0 ? (
            <EmptyState filter={filter} newTaskHref={newTaskHref} />
          ) : (
            windowed.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                project={byProject.get(t.project_id)}
                stuck={stuckMap.get(t.id)}
                bootId={health?.boot_id ?? null}
                onRecover={recover}
                isDraggable={DRAG_ALLOWED_TO[t.status].length > 0}
                dependencies={t.depends_on
                  .map((id) => byTaskId.get(id))
                  .filter((d): d is Task => d != null)
                  .map((d) => ({ id: d.id, status: d.status, name: d.name }))}
              />
            ))
          )}
        </div>
      </div>

      {/* Desktop: kanban; each expanded wrapper spans its statuses count */}
      {(() => {
        const nonCanceledCols = COLUMNS.filter((c) => c.title !== "Canceled").reduce(
          (acc, c) =>
            acc +
            (EXPANDABLE_TITLES.has(c.title) && expandedColumns.has(c.title)
              ? c.statuses.length
              : 1),
          0,
        );
        const hasCanceled = COLUMNS.some((c) => c.title === "Canceled");
        const gridTemplateColumns = hasCanceled
          ? `repeat(${nonCanceledCols}, minmax(${COLUMN_MIN_WIDTH_PX}px, 1fr)) minmax(${CANCELED_MIN_WIDTH_PX}px, 0.55fr)`
          : `repeat(${nonCanceledCols}, minmax(${COLUMN_MIN_WIDTH_PX}px, 1fr))`;
        return (
          <>
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
            autoScroll={{ threshold: { x: 0, y: 0.2 } }}
          >
          <div className="hidden lg:flex flex-col flex-1 min-h-0 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <div
              className="grid gap-4 flex-1 min-h-0"
              style={{ gridTemplateColumns }}
            >
            {COLUMNS.map((col) => {
              const list = windowed.filter((t) => col.statuses.includes(t.status));
              const isTerminal = col.statuses.some((s) => TERMINAL_STATUSES.has(s));
              const total =
                isTerminal && termWindow !== "all"
                  ? visible.filter((t) => col.statuses.includes(t.status)).length
                  : list.length;
              const isExpandable = EXPANDABLE_TITLES.has(col.title);
              const expanded = isExpandable && expandedColumns.has(col.title);
              const span = expanded ? SPAN_BY_COUNT[col.statuses.length] : "";
              const dim = COLUMN_DIM[col.title] ?? "";
              const titleColor = COLUMN_TITLE_COLOR[col.title] ?? "";
              const droppableInCol = col.statuses.filter((s) =>
                DROPPABLE_STATUSES.has(s),
              );
              const collapsedDropTarget =
                !expanded && droppableInCol.length === 1
                  ? droppableInCol[0]
                  : null;
              return (
                <section
                  key={col.title}
                  className={`${span} ${dim} border border-border dark:border-border-strong rounded-sm bg-surface flex flex-col min-h-0 h-full`}
                >
              <header className="flex items-center justify-between px-3 py-2 border-b border-border">
                <div className="flex items-center gap-2 min-w-0">
                  {col.title === "In progress" ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-info shrink-0" />
                  ) : null}
                  <h2 className={`text-sm font-medium truncate ${titleColor}`}>
                    {col.title}
                  </h2>
                  {(() => {
                    const o = wrapperOwner(col.statuses);
                    return o ? <OwnerBadge owner={o} /> : null;
                  })()}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs text-text-2 font-mono"
                    title={total !== list.length ? `${list.length} in window · ${total} total` : undefined}
                  >
                    {total !== list.length ? `${list.length} of ${total}` : list.length}
                  </span>
                  {isExpandable ? (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(col.title)}
                      aria-expanded={expanded}
                      aria-label={
                        expanded
                          ? `Collapse ${col.title} states`
                          : `Expand ${col.title} states`
                      }
                      className="inline-flex items-center justify-center h-5 w-5 rounded text-text-2 hover:text-text hover:bg-surface leading-none"
                    >
                      {expanded ? (
                        <Minimize2 className="h-3.5 w-3.5" />
                      ) : (
                        <Maximize2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : null}
                </div>
              </header>
              {expanded ? (
                <div className={SUB_GRID_BY_COUNT[col.statuses.length]}>
                  {col.statuses.map((status) => {
                    const subList = visible.filter((t) => t.status === status);
                    return (
                      <DroppableSubColumn
                        key={status}
                        status={status}
                        activeStatus={activeStatus}
                      >
                        <header className="flex items-center justify-between px-2 py-1 border-b border-border">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <h3 className="text-[11px] font-mono uppercase tracking-wide text-text-2 truncate">
                              {status}
                            </h3>
                            {(() => {
                              const o = ownerOf(status);
                              return o ? <OwnerBadge owner={o} /> : null;
                            })()}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {status === "TODO" ? (
                              <TodoPickerToggle
                                enabled={config.stage_enabled.todo_picker}
                                saving={pickerSaving}
                                onToggle={toggleTodoPicker}
                              />
                            ) : null}
                            <span className="text-[11px] text-text-2 font-mono">
                              {subList.length}
                            </span>
                          </div>
                        </header>
                        <div className="p-2 space-y-2 flex-1 min-h-0 overflow-y-auto">
                          {subList.length === 0 && status !== "BACKLOG" ? (
                            <div className="border border-dashed border-border rounded-sm h-10" />
                          ) : (
                            subList.map((t) => (
                              <TaskCard
                                key={t.id}
                                task={t}
                                project={byProject.get(t.project_id)}
                                stuck={stuckMap.get(t.id)}
                                bootId={health?.boot_id ?? null}
                                onRecover={recover}
                                isDraggable={DRAG_ALLOWED_TO[t.status].length > 0}
                                dependencies={t.depends_on
                                  .map((id) => byTaskId.get(id))
                                  .filter((d): d is Task => d != null)
                                  .map((d) => ({ id: d.id, status: d.status, name: d.name }))}
                              />
                            ))
                          )}
                          {status === "BACKLOG" ? (
                            <Link
                              href={newTaskHref}
                              aria-label="New task"
                              className="flex items-center justify-center w-full h-10 border border-dashed border-primary/40 bg-primary/5 text-primary rounded-sm hover:bg-primary/10"
                            >
                              <Plus className="h-4 w-4" />
                            </Link>
                          ) : null}
                        </div>
                      </DroppableSubColumn>
                    );
                  })}
                </div>
              ) : (
                <CollapsedDropBody
                  droppableId={collapsedDropTarget ?? col.statuses[0]}
                  enabled={!!collapsedDropTarget}
                  activeStatus={activeStatus}
                >
                  {list.length === 0 ? (
                    <p className="text-xs text-text-3 px-2 py-1">No tasks.</p>
                  ) : (
                    list.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        project={byProject.get(t.project_id)}
                        stuck={stuckMap.get(t.id)}
                        bootId={health?.boot_id ?? null}
                        onRecover={recover}
                        isDraggable={DRAG_ALLOWED_TO[t.status].length > 0}
                        dependencies={t.depends_on
                          .map((id) => byTaskId.get(id))
                          .filter((d): d is Task => d != null)
                          .map((d) => ({ id: d.id, status: d.status, name: d.name }))}
                      />
                    ))
                  )}
                </CollapsedDropBody>
              )}
            </section>
          );
        })}
            </div>
          </div>
          <DragOverlay>
            {activeTask ? <TaskCardPreview task={activeTask} /> : null}
          </DragOverlay>
          </DndContext>
          {pendingCancel ? (
            <CancelTaskDialog
              open
              onOpenChange={(open) => {
                if (!open) {
                  upsertTask(pendingCancel.snapshot);
                  setPendingCancel(null);
                }
              }}
              hasPrUrl={!!(pendingCancel.task.delivery_url?.startsWith("http"))}
              hasBranch={!!pendingCancel.task.branch}
              prUrl={pendingCancel.task.delivery_url?.startsWith("http") ? pendingCancel.task.delivery_url : undefined}
              branchName={pendingCancel.task.branch ?? undefined}
              onConfirm={async (opts) => {
                const { task, snapshot } = pendingCancel;
                setPendingCancel(null);
                fireCancelTransition(task, snapshot, opts);
              }}
            />
          ) : null}
          </>
        );
      })()}
    </main>
  );
}

function DroppableSubColumn({
  status,
  activeStatus,
  children,
}: {
  status: TaskStatus;
  activeStatus: TaskStatus | null;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: status,
    disabled: !DROPPABLE_STATUSES.has(status),
  });
  const canDrop =
    activeStatus != null && DRAG_ALLOWED_TO[activeStatus].includes(status);
  const dim = activeStatus != null && !canDrop;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "border border-border dark:border-border-strong rounded-sm bg-surface flex flex-col min-h-0",
        isOver && canDrop && "ring-1 ring-primary border-primary",
        dim && "opacity-40 pointer-events-none",
      )}
    >
      {children}
    </div>
  );
}

function CollapsedDropBody({
  droppableId,
  enabled,
  activeStatus,
  children,
}: {
  droppableId: TaskStatus;
  enabled: boolean;
  activeStatus: TaskStatus | null;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
    disabled: !enabled,
  });
  const canDrop =
    enabled &&
    activeStatus != null &&
    DRAG_ALLOWED_TO[activeStatus].includes(droppableId);
  const dim = activeStatus != null && !canDrop;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "p-2 space-y-2 flex-1 min-h-0 overflow-y-auto",
        isOver && canDrop && "ring-1 ring-primary border-primary",
        dim && "opacity-40 pointer-events-none",
      )}
    >
      {children}
    </div>
  );
}

function EmptyState({
  filter,
  newTaskHref,
}: {
  filter: Set<TaskStatus>;
  newTaskHref: string;
}) {
  const filtered = filter.size > 0;
  return (
    <div className="border border-dashed border-border rounded-sm p-8 text-center">
      <p className="text-sm font-medium">No tasks</p>
      <p className="text-xs text-text-2 mt-1">
        {filtered
          ? `No tasks match the selected status${filter.size === 1 ? "" : "es"}.`
          : "Create a task to get started."}
      </p>
      <Link href={newTaskHref} className="inline-block mt-3">
        <Button size="default">New task</Button>
      </Link>
    </div>
  );
}
