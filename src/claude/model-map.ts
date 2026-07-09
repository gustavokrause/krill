import type { Stage } from "@/workflow/types";

export type ModelStage = Exclude<Stage, "todo_picker">;

export const MODEL_BY_STAGE: Record<ModelStage, string> = {
  planning: "claude-opus-4-7",
  implementing: "claude-sonnet-4-6",
  // Ladder default: a task's FIRST review pass runs AI_REVIEW_FIRST_PASS_MODEL
  // (see below); this Opus entry is the contested-review tier once a decline
  // cycle exists. Selection happens in stages/ai-review.ts.
  ai_review: "claude-opus-4-7",
  // Verify is the most MECHANICAL judgment stage — run the change, observe, compare
  // to acceptance — and a wrong verdict bounces cheaply to IMPLEMENTING. Running it
  // on Sonnet as a measured cost A/B (Opus stays on the static-reasoning stages
  // ai_review/planning where its judgment is load-bearing). Watch the meter +
  // verify comments next batch; revert to opus-4-7 if it starts missing failures.
  verify: "claude-sonnet-4-6",
  publishing: "claude-sonnet-4-6",
};

// Cheap-first ladder (tracker B2). First AI-REVIEW pass of a task runs Sonnet:
// most diffs are clean and Opus at ~5× the cost adds nothing to an obvious
// approve. Any later pass — the review is contested (a decline/verify-fail
// cycle exists) — falls back to MODEL_BY_STAGE.ai_review (Opus), where the
// judgment is load-bearing. Quality guard: stage_usage records the model that
// actually ran, so the decline-flip rate (Sonnet approve → later fail) is
// meterable; revert by pointing this at opus-4-7.
export const AI_REVIEW_FIRST_PASS_MODEL = "claude-sonnet-4-6";

// Escalation resolver on Sonnet: it either decides (goes back to work) or
// defers to a HUMAN — there is no downstream AI judgment to protect, so Opus
// on every fork paid ~5× for nothing. A weak decision bounces through the
// normal stage brakes; a defer lands exactly where it would have anyway.
export const RESOLVER_MODEL = "claude-sonnet-4-6";
