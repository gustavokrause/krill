import type {
  Comment,
  GlobalConfig,
  Project,
  Task,
  TaskStatus,
  UsageLimitSource,
} from "@/db/schema";
import type { LimitsView } from "@/lib/limits-view";

// Kept for backward compatibility with limit-guard.ts and tests.
export type LimitSnapshot = Array<{
  scope: string;
  model_bucket: string | null;
  used_pct: number;
  resets_at: number | null;
  source: UsageLimitSource;
  raw: string | null;
}>;

export type { LimitsView };

export type WorkflowEvent =
  | { type: "task.updated"; task: Task }
  | {
      type: "task.transitioned";
      task: Task;
      from: TaskStatus;
      to: TaskStatus;
    }
  | { type: "comment.appended"; comment: Comment }
  | { type: "config.changed"; config: GlobalConfig }
  | { type: "project.updated"; project: Project }
  | { type: "project.deleted"; projectId: string }
  | { type: "task.deleted"; taskId: string }
  | {
      type: "task.stuck";
      taskId: string;
      stage: string;
      ageSec: number;
      maxSec: number;
    }
  | { type: "limits.changed"; view: LimitsView };

export type EventType = WorkflowEvent["type"];

export const EVENT_TYPES: EventType[] = [
  "task.updated",
  "task.transitioned",
  "comment.appended",
  "config.changed",
  "project.updated",
  "project.deleted",
  "task.deleted",
  "task.stuck",
  "limits.changed",
];
