import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { globalConfig } from "@/db/schema";
import { DEFAULT_API_ERROR_BACKOFF } from "@/db/defaults";
import { now, type Stage } from "./types";

/**
 * Per-stage exponential backoff state. RateLimitError thrown by the runner
 * bumps the next-attempt timestamp; first success after backoff clears it.
 *
 * State is in-memory — process restart clears the cool-down (intentional;
 * fresh boot retries everything).
 */

const GLOBAL_KEY = "__ai_auto_backoff";
const g = globalThis as unknown as Record<
  string,
  Map<Stage, BackoffEntry>
>;

type BackoffEntry = {
  attempts: number;
  nextAttemptAt: number;
};

const state: Map<Stage, BackoffEntry> =
  g[GLOBAL_KEY] ?? (g[GLOBAL_KEY] = new Map());

function getBackoffConfig() {
  const row = db
    .select({ b: globalConfig.api_error_backoff })
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  return row?.b ?? DEFAULT_API_ERROR_BACKOFF;
}

export function isBackoffActive(stage: Stage): boolean {
  const entry = state.get(stage);
  if (!entry) return false;
  return entry.nextAttemptAt > now();
}

// Delay saturates at the LAST sequence entry once `prev >= sequence.length`,
// so default `{sequence:[30,60,120], cap:300}` yields 30 → 60 → 120 → 120 → …
// The cap only fires when a sequence value itself exceeds it; lengthening
// the sequence is the way to push attempts past 120s.
export function bumpBackoff(stage: Stage): BackoffEntry {
  const cfg = getBackoffConfig();
  const prev = state.get(stage)?.attempts ?? 0;
  const attempts = prev + 1;
  const delaySec =
    cfg.sequence[Math.min(prev, cfg.sequence.length - 1)] ?? cfg.cap;
  const capped = Math.min(delaySec, cfg.cap);
  const entry: BackoffEntry = {
    attempts,
    nextAttemptAt: now() + capped,
  };
  state.set(stage, entry);
  return entry;
}

export function resetBackoff(stage: Stage): void {
  state.delete(stage);
}

export function snapshotBackoff(): Record<
  Stage,
  BackoffEntry | undefined
> {
  return {
    todo_picker: state.get("todo_picker"),
    planning: state.get("planning"),
    implementing: state.get("implementing"),
    ai_review: state.get("ai_review"),
    publishing: state.get("publishing"),
  };
}
