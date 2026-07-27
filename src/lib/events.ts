import type {
  Comment,
  GlobalConfig,
  Project,
  Task,
  TaskStatus,
  UsageLimitSource,
} from "@/db/schema";

// Inline snapshot type — mirrors LimitRow in claude/limits.ts. Defined here
// to avoid a circular import (limits.ts → sse.ts → events.ts → limits.ts).
export type LimitSnapshot = Array<{
  scope: string;
  model_bucket: string | null;
  used_pct: number;
  resets_at: number | null;
  source: UsageLimitSource;
  raw: string | null;
}>;

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
  | { type: "limits.changed"; snapshot: LimitSnapshot };

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
