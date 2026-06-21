import type { Stage } from "@/workflow/types";

export type ModelStage = Exclude<Stage, "todo_picker">;

export const MODEL_BY_STAGE: Record<ModelStage, string> = {
  planning: "claude-opus-4-7",
  implementing: "claude-sonnet-4-6",
  ai_review: "claude-opus-4-7",
  // Verify runs the change + reasons about whether behavior meets acceptance —
  // an Opus judgment call like AI-REVIEW, not a mechanical shell step.
  verify: "claude-opus-4-7",
  publishing: "claude-sonnet-4-6",
};
