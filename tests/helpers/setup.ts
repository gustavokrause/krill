import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import * as schema from "@/db/schema";
import * as defaults from "@/db/defaults";

/**
 * Tests share `data/test.db`. Migrations are idempotent via drizzle's
 * `__drizzle_migrations` table; seed uses onConflictDoNothing. Each test
 * file gets its own subprocess (node:test default) and calls `cleanData()`
 * in `beforeEach`, so cross-file isolation comes from --test-concurrency=1
 * plus row-level cleanup rather than file deletion.
 */
const DB_PATH = process.env.DB_PATH;
if (!DB_PATH || !DB_PATH.endsWith("test.db")) {
  throw new Error(
    `tests must set DB_PATH to a test.db file (got ${DB_PATH ?? "<unset>"})`,
  );
}

migrate(db, {
  migrationsFolder: resolve(process.cwd(), "src/db/migrations"),
});

db.insert(schema.globalConfig)
  .values({
    id: 1,
    worktrees_root: defaults.DEFAULT_WORKTREES_ROOT,
    automation_enabled: true,
    stage_enabled: defaults.DEFAULT_STAGE_ENABLED,
    cron_cadence: defaults.DEFAULT_CRON_CADENCE,
    max_stage_duration: defaults.DEFAULT_MAX_STAGE_DURATION,
    claim_ttl: defaults.DEFAULT_CLAIM_TTL,
    api_error_backoff: defaults.DEFAULT_API_ERROR_BACKOFF,
    max_ai_decline_cycles: defaults.DEFAULT_MAX_AI_DECLINE_CYCLES,
  })
  .onConflictDoNothing()
  .run();

export { db };
export const tables = schema;

export function cleanData(): void {
  db.run(sql`DELETE FROM comments`);
  db.run(sql`DELETE FROM tasks`);
  db.run(sql`DELETE FROM projects`);
}

export function createProject(opts: {
  slug: string;
  has_repo?: boolean;
  max_parallel_tasks?: number;
  paused?: boolean;
  folder_path?: string;
  create_pr?: boolean | null;
  push_remote?: boolean | null;
  merge_to_main?: boolean | null;
  allow_auto_finish?: boolean;
  delete_branch_on_done?: boolean;
  draft_pr?: boolean;
}): schema.Project {
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .insert(schema.projects)
    .values({
      id: randomUUID(),
      name: opts.slug,
      slug: opts.slug,
      folder_path: opts.folder_path ?? `/tmp/test-${opts.slug.toLowerCase()}`,
      has_repo: opts.has_repo ?? false,
      default_branch: "main",
      max_parallel_tasks: opts.max_parallel_tasks ?? 1,
      paused: opts.paused ?? false,
      create_pr: opts.create_pr ?? null,
      push_remote: opts.push_remote ?? null,
      merge_to_main: opts.merge_to_main ?? null,
      allow_auto_finish: opts.allow_auto_finish ?? false,
      delete_branch_on_done: opts.delete_branch_on_done ?? true,
      draft_pr: opts.draft_pr ?? false,
      task_counter: 0,
      created_at: now,
      updated_at: now,
    })
    .returning()
    .all();
  return rows[0];
}

export function createTask(
  project: schema.Project,
  opts: Partial<schema.NewTask> & {
    name: string;
    status: schema.TaskStatus;
    mode?: schema.Mode;
  },
): schema.Task {
  const now = Math.floor(Date.now() / 1000);
  // Re-read the live counter; tests reuse the in-memory project object
  // across createTask calls and the field is otherwise stale.
  const live = db
    .select({ counter: schema.projects.task_counter })
    .from(schema.projects)
    .where(sql`id = ${project.id}`)
    .get();
  const nextN = (live?.counter ?? 0) + 1;
  db.update(schema.projects)
    .set({ task_counter: nextN })
    .where(sql`id = ${project.id}`)
    .run();
  const rows = db
    .insert(schema.tasks)
    .values({
      id: opts.id ?? `${project.slug}-${nextN}`,
      project_id: project.id,
      name: opts.name,
      description: opts.description ?? "",
      priority: opts.priority ?? "P2",
      status: opts.status,
      mode: opts.mode ?? "non-dev",
      plan: opts.plan ?? "",
      checklist: opts.checklist ?? "",
      depends_on: opts.depends_on ?? [],
      conflicts_with: opts.conflicts_with ?? [],
      affected_paths: opts.affected_paths ?? [],
      branch: opts.branch ?? null,
      worktree_path: opts.worktree_path ?? null,
      workspace_path: opts.workspace_path ?? null,
      delivery_url: opts.delivery_url ?? null,
      skip_plan: opts.skip_plan ?? false,
      skip_plan_review: opts.skip_plan_review ?? false,
      skip_ai_review: opts.skip_ai_review ?? false,
      auto_publish: opts.auto_publish ?? false,
      create_pr: opts.create_pr ?? null,
      push_remote: opts.push_remote ?? null,
      merge_to_main: opts.merge_to_main ?? null,
      draft_pr: opts.draft_pr ?? null,
      claimed_until: opts.claimed_until ?? null,
      claimed_by: opts.claimed_by ?? null,
      pending_review_kind: opts.pending_review_kind ?? null,
      created_at: now,
      started_at: opts.started_at ?? null,
      stage_entered_at: opts.stage_entered_at ?? now,
      updated_at: now,
      ended_at: opts.ended_at ?? null,
    })
    .returning()
    .all();
  return rows[0];
}
