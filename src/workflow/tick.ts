import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { globalConfig } from "@/db/schema";
import { RateLimitError } from "@/claude/errors";
import {
  bumpBackoff,
  isBackoffActive,
  resetBackoff,
} from "./backoff";
import { runAiReview } from "./stages/ai-review";
import { runImplementing } from "./stages/implementing";
import { runPlanning } from "./stages/planning";
import { runPublishing } from "./stages/publishing";
import { runTodoPicker } from "./stages/todo-picker";
import type { Stage } from "./types";

const HANDLERS: Record<Stage, (workerId: string) => Promise<string | null>> = {
  todo_picker: runTodoPicker,
  planning: runPlanning,
  implementing: runImplementing,
  ai_review: runAiReview,
  publishing: runPublishing,
};

export type TickResult =
  | {
      ran: false;
      reason:
        | "automation_disabled"
        | "stage_disabled"
        | "backoff_active"
        | "no_task";
    }
  | { ran: true; taskId: string }
  | { ran: false; reason: "rate_limited"; until: number };

export async function tick(stage: Stage): Promise<TickResult> {
  const cfg = db
    .select({
      automation_enabled: globalConfig.automation_enabled,
      stage_enabled: globalConfig.stage_enabled,
    })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();

  if (!cfg || !cfg.automation_enabled) {
    return { ran: false, reason: "automation_disabled" };
  }
  if (!cfg.stage_enabled[stage]) {
    return { ran: false, reason: "stage_disabled" };
  }
  if (isBackoffActive(stage)) {
    return { ran: false, reason: "backoff_active" };
  }

  const workerId = `worker-${randomUUID().slice(0, 8)}`;
  try {
    const taskId = await HANDLERS[stage](workerId);
    if (!taskId) return { ran: false, reason: "no_task" };
    resetBackoff(stage);
    return { ran: true, taskId };
  } catch (err) {
    if (err instanceof RateLimitError) {
      const entry = bumpBackoff(stage);
      console.warn(
        `[tick:${stage}] rate-limit; backoff until ${entry.nextAttemptAt} (attempt ${entry.attempts})`,
      );
      return { ran: false, reason: "rate_limited", until: entry.nextAttemptAt };
    }
    console.error(`[tick:${stage}] handler error:`, err);
    throw err;
  }
}
