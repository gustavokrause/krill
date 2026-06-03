import type {
  Comment,
  GlobalConfig,
  Project,
  Task,
  TaskStatus,
} from "@/db/schema";

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
    };

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
];
