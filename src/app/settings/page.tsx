import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  globalConfig,
  type BackoffConfig,
  type StageEnabled,
  type StageNumberMap,
} from "@/db/schema";
import {
  DEFAULT_API_ERROR_BACKOFF,
  DEFAULT_CLAIM_TTL,
  DEFAULT_CRON_CADENCE,
  DEFAULT_ESCALATION_AUTO_RESOLVE,
  DEFAULT_LIMIT_GUARD_ENABLED,
  DEFAULT_LIMIT_HARD_PCT,
  DEFAULT_LIMIT_POLL_SEC,
  DEFAULT_LIMIT_RESUME_GRACE_SEC,
  DEFAULT_LIMIT_SOFT_PCT,
  DEFAULT_MAX_AI_DECLINE_CYCLES,
  DEFAULT_MAX_STAGE_DURATION,
  DEFAULT_PUBLISHING_SOLVE_CONFLICTS,
  DEFAULT_STAGE_ENABLED,
  DEFAULT_WORKTREES_ROOT,
} from "@/db/defaults";
import { Settings } from "@/components/settings/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let row = db
    .select()
    .from(globalConfig)
    .where(eq(globalConfig.id, 1))
    .get();
  if (!row) {
    // Synthesize defaults for first-render before seed has run.
    row = {
      id: 1,
      worktrees_root: DEFAULT_WORKTREES_ROOT,
      automation_enabled: true,
      stage_enabled: DEFAULT_STAGE_ENABLED satisfies StageEnabled,
      cron_cadence: DEFAULT_CRON_CADENCE satisfies StageNumberMap,
      max_stage_duration: DEFAULT_MAX_STAGE_DURATION satisfies StageNumberMap,
      claim_ttl: DEFAULT_CLAIM_TTL satisfies StageNumberMap,
      api_error_backoff: DEFAULT_API_ERROR_BACKOFF satisfies BackoffConfig,
      max_ai_decline_cycles: DEFAULT_MAX_AI_DECLINE_CYCLES,
      publishing_solve_conflicts: DEFAULT_PUBLISHING_SOLVE_CONFLICTS,
      escalation_auto_resolve: DEFAULT_ESCALATION_AUTO_RESOLVE,
      limit_guard_enabled: DEFAULT_LIMIT_GUARD_ENABLED,
      limit_soft_pct: DEFAULT_LIMIT_SOFT_PCT,
      limit_hard_pct: DEFAULT_LIMIT_HARD_PCT,
      limit_poll_sec: DEFAULT_LIMIT_POLL_SEC,
      limit_resume_grace_sec: DEFAULT_LIMIT_RESUME_GRACE_SEC,
      paused_by_limit: false,
      limit_resume_at: null,
    };
  }
  return <Settings initial={row} />;
}
