import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// -- ENUMS (string unions, enforced via CHECK constraints) --

export const TASK_STATUSES = [
  "BACKLOG",
  "TODO",
  "PLANNING",
  "IMPLEMENTING",
  "AI-REVIEW",
  "PUBLISHING",
  "NEEDS_REVIEW",
  "DONE",
  "CANCELED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REVIEW_KINDS = ["plan", "deliverable", "conflict"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

// Statuses where the worktree is preserved (cleanup gate must skip these).
export const WORKTREE_RETAINED_STATUSES: TaskStatus[] = [
  "PLANNING",
  "IMPLEMENTING",
  "AI-REVIEW",
  "PUBLISHING",
  "NEEDS_REVIEW",
];

// Statuses that consume a project's `max_parallel_tasks` slot.
// NEEDS_REVIEW is parked on human action and does not occupy a slot.
export const PARALLEL_SLOT_STATUSES: TaskStatus[] = [
  "PLANNING",
  "IMPLEMENTING",
  "AI-REVIEW",
  "PUBLISHING",
];

// Statuses considered "in flight" for conflicts_with peer-checks and
// MCP affected_paths peer queries. NEEDS_REVIEW still blocks dependents.
export const CONFLICTS_BLOCKING_STATUSES: TaskStatus[] = [
  "PLANNING",
  "IMPLEMENTING",
  "AI-REVIEW",
  "PUBLISHING",
  "NEEDS_REVIEW",
];

// Statuses watched by the stuck-task scanner. NEEDS_REVIEW is human-parked.
export const STUCK_WATCHED_STATUSES: TaskStatus[] = [
  "PLANNING",
  "IMPLEMENTING",
  "AI-REVIEW",
  "PUBLISHING",
];

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MODES = ["dev", "non-dev"] as const;
export type Mode = (typeof MODES)[number];

export const COMMENT_AUTHORS = ["human", "ai"] as const;
export type CommentAuthor = (typeof COMMENT_AUTHORS)[number];

// -- CONFIG JSON SHAPES --

export type StageEnabled = {
  todo_picker: boolean;
  planning: boolean;
  implementing: boolean;
  ai_review: boolean;
  publishing: boolean;
};

export type StageNumberMap = {
  todo_picker?: number;
  planning: number;
  implementing: number;
  ai_review: number;
  publishing: number;
};

export type BackoffConfig = {
  sequence: number[];
  cap: number;
};

// -- GLOBAL CONFIG (singleton, id=1) --

export const globalConfig = sqliteTable(
  "global_config",
  {
    id: integer("id").primaryKey(),
    worktrees_root: text("worktrees_root").notNull().default("~/.ai-worktrees/"),
    automation_enabled: integer("automation_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    stage_enabled: text("stage_enabled", { mode: "json" })
      .$type<StageEnabled>()
      .notNull(),
    cron_cadence: text("cron_cadence", { mode: "json" })
      .$type<StageNumberMap>()
      .notNull(),
    max_stage_duration: text("max_stage_duration", { mode: "json" })
      .$type<StageNumberMap>()
      .notNull(),
    claim_ttl: text("claim_ttl", { mode: "json" })
      .$type<StageNumberMap>()
      .notNull(),
    api_error_backoff: text("api_error_backoff", { mode: "json" })
      .$type<BackoffConfig>()
      .notNull(),
    max_ai_decline_cycles: integer("max_ai_decline_cycles")
      .notNull()
      .default(3),
    publishing_solve_conflicts: integer("publishing_solve_conflicts", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
  },
  (t) => [check("global_config_singleton", sql`${t.id} = 1`)],
);

// -- PROJECTS --

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    folder_path: text("folder_path").notNull(),
    has_repo: integer("has_repo", { mode: "boolean" }).notNull().default(false),
    default_branch: text("default_branch").notNull().default("main"),
    max_parallel_tasks: integer("max_parallel_tasks").notNull().default(1),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    // Publish policy (A1). NULL = auto-detect from whether a git remote exists:
    // remote -> PR flow; no remote -> local merge. Non-null overrides detection.
    create_pr: integer("create_pr", { mode: "boolean" }),
    push_remote: integer("push_remote", { mode: "boolean" }),
    merge_to_main: integer("merge_to_main", { mode: "boolean" }),
    task_counter: integer("task_counter").notNull().default(0),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("projects_slug_uniq").on(t.slug),
    check(
      "projects_max_parallel_range",
      sql`${t.max_parallel_tasks} BETWEEN 1 AND 5`,
    ),
  ],
);

// -- TASKS --

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priority: text("priority").notNull().default("P2").$type<Priority>(),
    status: text("status").notNull().$type<TaskStatus>(),
    pending_review_kind: text("pending_review_kind").$type<ReviewKind>(),
    mode: text("mode").notNull().$type<Mode>(),
    plan: text("plan").notNull().default(""),
    checklist: text("checklist").notNull().default(""),
    depends_on: text("depends_on", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    conflicts_with: text("conflicts_with", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    affected_paths: text("affected_paths", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    branch: text("branch"),
    worktree_path: text("worktree_path"),
    workspace_path: text("workspace_path"),
    delivery_url: text("delivery_url"),
    skip_plan: integer("skip_plan", { mode: "boolean" }).notNull().default(false),
    skip_plan_review: integer("skip_plan_review", { mode: "boolean" })
      .notNull()
      .default(false),
    skip_ai_review: integer("skip_ai_review", { mode: "boolean" })
      .notNull()
      .default(false),
    claimed_until: integer("claimed_until"),
    claimed_by: text("claimed_by"),
    created_at: integer("created_at").notNull(),
    started_at: integer("started_at"),
    stage_entered_at: integer("stage_entered_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    ended_at: integer("ended_at"),
  },
  (t) => [
    index("tasks_status_claim_idx").on(t.status, t.claimed_until),
    index("tasks_project_status_idx").on(t.project_id, t.status),
    check(
      "tasks_status_enum",
      sql`${t.status} IN ('BACKLOG','TODO','PLANNING','IMPLEMENTING','AI-REVIEW','PUBLISHING','NEEDS_REVIEW','DONE','CANCELED')`,
    ),
    check(
      "tasks_priority_enum",
      sql`${t.priority} IN ('P0','P1','P2','P3')`,
    ),
    check("tasks_mode_enum", sql`${t.mode} IN ('dev','non-dev')`),
    check(
      "tasks_pending_review_kind_enum",
      sql`${t.pending_review_kind} IS NULL OR ${t.pending_review_kind} IN ('plan','deliverable','conflict')`,
    ),
    check(
      "tasks_pending_review_kind_requires_status",
      sql`(${t.status} = 'NEEDS_REVIEW' AND ${t.pending_review_kind} IS NOT NULL) OR (${t.status} <> 'NEEDS_REVIEW' AND ${t.pending_review_kind} IS NULL)`,
    ),
  ],
);

// -- COMMENTS (append-only) --

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    task_id: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    stage: text("stage").notNull().$type<TaskStatus>(),
    author: text("author").notNull().$type<CommentAuthor>(),
    text: text("text").notNull(),
  },
  (t) => [
    index("comments_task_at_idx").on(t.task_id, t.at),
    check("comments_author_enum", sql`${t.author} IN ('human','ai')`),
  ],
);

// -- types --

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type GlobalConfig = typeof globalConfig.$inferSelect;
