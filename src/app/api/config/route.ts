import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import {
  DEFAULT_API_ERROR_BACKOFF,
  DEFAULT_CLAIM_TTL,
  DEFAULT_CRON_CADENCE,
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
import { apiErrorResponse } from "@/lib/api/errors";
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
