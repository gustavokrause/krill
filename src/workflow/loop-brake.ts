import { and, eq, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { comments, globalConfig } from "@/db/schema";

export { MANUAL_AI_COMMENT_PREFIX } from "@/lib/ai-comments";
import { MANUAL_AI_COMMENT_PREFIX } from "@/lib/ai-comments";

/**
 * Count AI-authored comments since the most recent human comment for the
 * task. If no human comment exists, all AI comments count. Comments authored
 * by a human-triggered CTA (prefixed with MANUAL_AI_COMMENT_PREFIX) are
 * excluded so repeated clicks do not trip the brake.
 *
 * Approximation per OVERVIEW.md ai_auto_actions definition: also resets
 * on forward state transitions, but tracking those requires an audit
 * log (deferred). Stage handlers can still observe forward progress
 * via task.stage_entered_at if needed later.
 */
export function countAiAutoActions(taskId: string): number {
  const lastHuman = db
    .select({ at: comments.at })
    .from(comments)
    .where(and(eq(comments.task_id, taskId), eq(comments.author, "human")))
    .orderBy(desc(comments.at))
    .get();

  const rows = db
    .select({ at: comments.at, text: comments.text })
    .from(comments)
    .where(and(eq(comments.task_id, taskId), eq(comments.author, "ai")))
    .all();

  const auto = rows.filter((r) => !r.text.startsWith(MANUAL_AI_COMMENT_PREFIX));
  if (!lastHuman) return auto.length;
  return auto.filter((r) => r.at > lastHuman.at).length;
}

/**
 * The configured AI auto-action brake: after this many self-driven cycles a
 * stage stops looping and parks at NEEDS_REVIEW for a human. Shared by the
 * AI-REVIEW / verify decline brakes and the publishing retry brake.
 */
export function getMaxAiDeclineCycles(): number {
  const row = db
    .select({ n: globalConfig.max_ai_decline_cycles })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  return row?.n ?? 3;
}
