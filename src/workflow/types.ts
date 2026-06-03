import {
  CONFLICTS_BLOCKING_STATUSES,
  PARALLEL_SLOT_STATUSES,
  STUCK_WATCHED_STATUSES,
  WORKTREE_RETAINED_STATUSES,
  type TaskStatus,
} from "@/db/schema";

export type Stage =
  | "todo_picker"
  | "planning"
  | "implementing"
  | "ai_review"
  | "publishing";

export const STAGES: Stage[] = [
  "todo_picker",
  "planning",
  "implementing",
  "ai_review",
  "publishing",
];

export const STAGE_TO_PICK_STATUS: Record<Stage, TaskStatus> = {
  todo_picker: "TODO",
  planning: "PLANNING",
  implementing: "IMPLEMENTING",
  ai_review: "AI-REVIEW",
  publishing: "PUBLISHING",
};

export {
  CONFLICTS_BLOCKING_STATUSES,
  PARALLEL_SLOT_STATUSES,
  STUCK_WATCHED_STATUSES,
  WORKTREE_RETAINED_STATUSES,
};

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
