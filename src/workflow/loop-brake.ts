import { and, eq, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { comments, globalConfig, type TaskStatus } from "@/db/schema";

export { MANUAL_AI_COMMENT_PREFIX } from "@/lib/ai-comments";
import { MANUAL_AI_COMMENT_PREFIX } from "@/lib/ai-comments";

/**
 * Count AI-authored comments since the most recent human comment for the
 * task. If no human comment exists, all AI comments count. Comments authored
 * by a human-triggered CTA (prefixed with MANUAL_AI_COMMENT_PREFIX) are
 * excluded so repeated clicks do not trip the brake.
 *
 * `stage` scopes the count to comments logged under that stage. Each brake
 * consumer (AI-REVIEW decline, VERIFYING fail, PUBLISHING retry) passes its
 * own stage so activity elsewhere (planning notes, escalations, other stages'
 * cycles) doesn't inflate its counter — a cross-stage count either trips a
 * brake early or masks a real loop. The count deliberately spans stage
 * *episodes* (a decline loop leaves and re-enters its stage every cycle);
 * only a human comment resets it.
 */
export function countAiAutoActions(taskId: string, stage?: TaskStatus): number {
  const lastHuman = db
    .select({ at: comments.at })
    .from(comments)
    .where(and(eq(comments.task_id, taskId), eq(comments.author, "human")))
    .orderBy(desc(comments.at))
    .get();

  const rows = db
    .select({ at: comments.at, text: comments.text })
    .from(comments)
    .where(
      and(
        eq(comments.task_id, taskId),
        eq(comments.author, "ai"),
        ...(stage ? [eq(comments.stage, stage)] : []),
      ),
    )
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
