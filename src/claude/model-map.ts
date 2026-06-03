import type { Stage } from "@/workflow/types";

export type ModelStage = Exclude<Stage, "todo_picker">;

export const MODEL_BY_STAGE: Record<ModelStage, string> = {
  planning: "claude-opus-4-7",
  implementing: "claude-sonnet-4-6",
  ai_review: "claude-opus-4-7",
  publishing: "claude-sonnet-4-6",
};
