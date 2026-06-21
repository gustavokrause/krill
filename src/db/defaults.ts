import type {
  BackoffConfig,
  StageEnabled,
  StageNumberMap,
} from "./schema";

export const DEFAULT_STAGE_ENABLED: StageEnabled = {
  todo_picker: true,
  planning: true,
  implementing: true,
  ai_review: true,
  verify: true,
  publishing: true,
};

export const DEFAULT_CRON_CADENCE: StageNumberMap = {
  todo_picker: 30,
  planning: 60,
  implementing: 60,
  ai_review: 60,
  verify: 60,
  publishing: 60,
};

export const DEFAULT_MAX_STAGE_DURATION: StageNumberMap = {
  planning: 900,
  implementing: 3600,
  ai_review: 900,
  // Verify builds, runs tests, and boots the app — closer to implementing than
  // a diff read.
  verify: 3600,
  publishing: 600,
};

export const DEFAULT_CLAIM_TTL: StageNumberMap = {
  planning: 300,
  implementing: 1800,
  ai_review: 300,
  verify: 1800,
  publishing: 300,
};

export const DEFAULT_API_ERROR_BACKOFF: BackoffConfig = {
  sequence: [30, 60, 120],
  cap: 300,
};

export const DEFAULT_MAX_AI_DECLINE_CYCLES = 3;
export const DEFAULT_WORKTREES_ROOT = "~/.ai-worktrees/";
export const DEFAULT_PUBLISHING_SOLVE_CONFLICTS = false;
export const DEFAULT_ESCALATION_AUTO_RESOLVE = true;
