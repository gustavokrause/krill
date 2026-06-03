/**
 * Marker prefix on AI comments authored by a human-triggered action (e.g.,
 * the "Solve with Sonnet" CTA). Counted comments skip this prefix so the
 * brake counter does not inflate from human-driven clicks.
 */
export const MANUAL_AI_COMMENT_PREFIX = "[manual] ";

type CommentLike = { author: "ai" | "human"; text: string; at: number };

/**
 * Pure version of `countAiAutoActions` that operates on an in-memory comments
 * list, mirroring the DB-backed implementation in `src/workflow/loop-brake.ts`.
 * Use this in the client where comments are already loaded.
 */
export function countAiAutoActionsFromComments(
  rows: ReadonlyArray<CommentLike>,
): number {
  let lastHumanAt = -Infinity;
  for (const r of rows) {
    if (r.author === "human" && r.at > lastHumanAt) lastHumanAt = r.at;
  }
  let n = 0;
  for (const r of rows) {
    if (r.author !== "ai") continue;
    if (r.text.startsWith(MANUAL_AI_COMMENT_PREFIX)) continue;
    if (r.at > lastHumanAt) n++;
  }
  return n;
}
