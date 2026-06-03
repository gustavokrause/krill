import { db } from "./client";
import {
  DEFAULT_API_ERROR_BACKOFF,
  DEFAULT_CLAIM_TTL,
  DEFAULT_CRON_CADENCE,
  DEFAULT_MAX_AI_DECLINE_CYCLES,
  DEFAULT_MAX_STAGE_DURATION,
  DEFAULT_STAGE_ENABLED,
  DEFAULT_WORKTREES_ROOT,
} from "./defaults";
import { globalConfig } from "./schema";

async function seed() {
  await db
    .insert(globalConfig)
    .values({
      id: 1,
      worktrees_root: DEFAULT_WORKTREES_ROOT,
      automation_enabled: true,
      stage_enabled: DEFAULT_STAGE_ENABLED,
      cron_cadence: DEFAULT_CRON_CADENCE,
      max_stage_duration: DEFAULT_MAX_STAGE_DURATION,
      claim_ttl: DEFAULT_CLAIM_TTL,
      api_error_backoff: DEFAULT_API_ERROR_BACKOFF,
      max_ai_decline_cycles: DEFAULT_MAX_AI_DECLINE_CYCLES,
    })
    .onConflictDoNothing();

  console.log("seed complete (global_config only — projects are user-created)");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
