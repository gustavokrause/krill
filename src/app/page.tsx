import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  globalConfig,
  projects,
  tasks,
  type BackoffConfig,
  type StageEnabled,
  type StageNumberMap,
} from "@/db/schema";
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
import { Board } from "@/components/board/board";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const allProjects = db
    .select()
    .from(projects)
    .orderBy(asc(projects.slug))
    .all();
  const allTasks = db
    .select()
    .from(tasks)
    .orderBy(asc(tasks.priority), desc(tasks.created_at))
    .all();
  const config =
    db.select().from(globalConfig).where(eq(globalConfig.id, 1)).get() ?? {
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
    };

  return (
    <Board
      initialTasks={allTasks}
      projects={allProjects}
      initialConfig={config}
    />
  );
}
