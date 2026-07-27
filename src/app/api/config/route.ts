import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
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
import {
  globalConfig,
  type BackoffConfig,
  type StageEnabled,
  type StageNumberMap,
} from "@/db/schema";
import { ApiError, apiErrorResponse } from "@/lib/api/errors";
import { configPatchSchema } from "@/lib/api/validation";
import { broadcast } from "@/lib/sse";

function readOrInit() {
  let row = db.select().from(globalConfig).where(eq(globalConfig.id, 1)).get();
  if (!row) {
    db.insert(globalConfig)
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
        publishing_solve_conflicts: DEFAULT_PUBLISHING_SOLVE_CONFLICTS,
        escalation_auto_resolve: DEFAULT_ESCALATION_AUTO_RESOLVE,
        limit_guard_enabled: DEFAULT_LIMIT_GUARD_ENABLED,
        limit_soft_pct: DEFAULT_LIMIT_SOFT_PCT,
        limit_hard_pct: DEFAULT_LIMIT_HARD_PCT,
        limit_poll_sec: DEFAULT_LIMIT_POLL_SEC,
        limit_resume_grace_sec: DEFAULT_LIMIT_RESUME_GRACE_SEC,
      })
      .run();
    row = db.select().from(globalConfig).where(eq(globalConfig.id, 1)).get()!;
  }
  return row;
}

export async function GET() {
  try {
    return NextResponse.json({ config: readOrInit() });
  } catch (err) {
    return apiErrorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = configPatchSchema.parse(await req.json());
    const current = readOrInit();

    const stage_enabled: StageEnabled = {
      ...current.stage_enabled,
      ...(body.stage_enabled ?? {}),
    };
    const cron_cadence: StageNumberMap = {
      ...current.cron_cadence,
      ...(body.cron_cadence ?? {}),
    };
    const max_stage_duration: StageNumberMap = {
      ...current.max_stage_duration,
      ...(body.max_stage_duration ?? {}),
    };
    const claim_ttl: StageNumberMap = {
      ...current.claim_ttl,
      ...(body.claim_ttl ?? {}),
    };
    const api_error_backoff: BackoffConfig =
      body.api_error_backoff ?? current.api_error_backoff;

    const mergedSoft = body.limit_soft_pct ?? current.limit_soft_pct;
    const mergedHard = body.limit_hard_pct ?? current.limit_hard_pct;
    if (mergedSoft > mergedHard) {
      throw new ApiError(400, "validation_failed", "limit_soft_pct must be <= limit_hard_pct");
    }

    db.update(globalConfig)
      .set({
        worktrees_root: body.worktrees_root ?? current.worktrees_root,
        automation_enabled:
          body.automation_enabled ?? current.automation_enabled,
        stage_enabled,
        cron_cadence,
        max_stage_duration,
        claim_ttl,
        api_error_backoff,
        max_ai_decline_cycles:
          body.max_ai_decline_cycles ?? current.max_ai_decline_cycles,
        publishing_solve_conflicts:
          body.publishing_solve_conflicts ?? current.publishing_solve_conflicts,
        escalation_auto_resolve:
          body.escalation_auto_resolve ?? current.escalation_auto_resolve,
        limit_guard_enabled:
          body.limit_guard_enabled ?? current.limit_guard_enabled,
        limit_soft_pct: mergedSoft,
        limit_hard_pct: mergedHard,
        limit_poll_sec: body.limit_poll_sec ?? current.limit_poll_sec,
        limit_resume_grace_sec:
          body.limit_resume_grace_sec ?? current.limit_resume_grace_sec,
      })
      .where(eq(globalConfig.id, 1))
      .run();

    const updated = db
      .select()
      .from(globalConfig)
      .where(eq(globalConfig.id, 1))
      .get();
    if (updated) broadcast({ type: "config.changed", config: updated });
    return NextResponse.json({ config: updated });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
