import type { Stage } from "@/workflow/types";

export type ModelStage = Exclude<Stage, "todo_picker">;

export const MODEL_BY_STAGE: Record<ModelStage, string> = {
  planning: "claude-opus-4-7",
  implementing: "claude-sonnet-4-6",
  ai_review: "claude-opus-4-7",
  // Verify is the most MECHANICAL judgment stage — run the change, observe, compare
  // to acceptance — and a wrong verdict bounces cheaply to IMPLEMENTING. Running it
  // on Sonnet as a measured cost A/B (Opus stays on the static-reasoning stages
  // ai_review/planning where its judgment is load-bearing). Watch the meter +
  // verify comments next batch; revert to opus-4-7 if it starts missing failures.
  verify: "claude-sonnet-4-6",
  publishing: "claude-sonnet-4-6",
};
