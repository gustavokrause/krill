import { z } from "zod";
import {
  COMMENT_AUTHORS,
  MODES,
  PRIORITIES,
  TASK_STATUSES,
} from "@/db/schema";
import { TERM_WINDOW_VALUES } from "@/lib/term-window";

export const slugSchema = z
  .string()
  .length(2)
  .regex(/^[A-Z][A-Z0-9]$/, "slug must be 2 chars: an uppercase letter then a letter or digit");

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(120),
  slug: slugSchema,
  folder_path: z.string().min(1),
  has_repo: z.boolean().optional(),
  default_branch: z.string().min(1).optional(),
  max_parallel_tasks: z.number().int().min(1).max(5).optional(),
  paused: z.boolean().optional(),
  // Publish policy: null = auto-detect from the repo remote; true/false override.
  create_pr: z.boolean().nullable().optional(),
  push_remote: z.boolean().nullable().optional(),
  merge_to_main: z.boolean().nullable().optional(),
  allow_auto_finish: z.boolean().optional(),
  delete_branch_on_done: z.boolean().optional(),
  draft_pr: z.boolean().optional(),
  pr_description_source: z.enum(["plan", "summary"]).optional(),
});

export const projectPatchSchema = projectCreateSchema
  .partial()
  .omit({ slug: true });

export const repoDetectSchema = z.object({
  folder_path: z.string().min(1),
});

export const taskCreateSchema = z.object({
  project_id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().default(""),
  mode: z.enum(MODES),
  priority: z.enum(PRIORITIES).default("P2"),
  depends_on: z.array(z.string()).default([]),
  conflicts_with: z.array(z.string()).default([]),
  affected_paths: z.array(z.string()).default([]),
  skip_plan: z.boolean().default(false),
  skip_plan_review: z.boolean().default(false),
  skip_ai_review: z.boolean().default(false),
  // Omitted = default by mode (non-dev skips verify, dev verifies); see the
  // tasks POST route.
  skip_verify: z.boolean().optional(),
  acceptance: z.string().nullable().optional(),
  auto_publish: z.boolean().default(false),
  // whale's pre-flight token estimate (sum of stage medians for the stages this
  // task will run). Omitted = no estimate; the board just shows used.
  est_tokens: z.number().int().nonnegative().nullable().optional(),
  // Per-task publish-policy overrides (null = inherit project).
  create_pr: z.boolean().nullable().optional(),
  push_remote: z.boolean().nullable().optional(),
  merge_to_main: z.boolean().nullable().optional(),
  draft_pr: z.boolean().nullable().optional(),
});

export const taskPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  priority: z.enum(PRIORITIES).optional(),
  plan: z.string().optional(),
  checklist: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  conflicts_with: z.array(z.string()).optional(),
  affected_paths: z.array(z.string()).optional(),
  skip_plan: z.boolean().optional(),
  skip_plan_review: z.boolean().optional(),
  skip_ai_review: z.boolean().optional(),
  skip_verify: z.boolean().optional(),
  acceptance: z.string().nullable().optional(),
  auto_publish: z.boolean().optional(),
  create_pr: z.boolean().nullable().optional(),
  push_remote: z.boolean().nullable().optional(),
  merge_to_main: z.boolean().nullable().optional(),
  draft_pr: z.boolean().nullable().optional(),
  delivery_url: z.string().nullable().optional(),
});

export const taskTransitionSchema = z.object({
  from: z.enum(TASK_STATUSES).optional(),
  to: z.enum(TASK_STATUSES),
  comment: z
    .object({
      author: z.enum(COMMENT_AUTHORS),
      text: z.string().min(1),
    })
    .optional(),
  cancel_options: z
    .object({
      close_pr: z.boolean(),
      delete_branch: z.boolean(),
    })
    .optional(),
});

export const commentCreateSchema = z.object({
  author: z.enum(COMMENT_AUTHORS),
  stage: z.enum(TASK_STATUSES),
  text: z.string().min(1),
});

export const configPatchSchema = z.object({
  worktrees_root: z.string().optional(),
  automation_enabled: z.boolean().optional(),
  stage_enabled: z
    .object({
      todo_picker: z.boolean(),
      planning: z.boolean(),
      implementing: z.boolean(),
      ai_review: z.boolean(),
      verify: z.boolean(),
      publishing: z.boolean(),
    })
    .partial()
    .optional(),
  cron_cadence: z
    .object({
      todo_picker: z.number().int().positive(),
      planning: z.number().int().positive(),
      implementing: z.number().int().positive(),
      ai_review: z.number().int().positive(),
      verify: z.number().int().positive(),
      publishing: z.number().int().positive(),
    })
    .partial()
    .optional(),
  max_stage_duration: z
    .object({
      planning: z.number().int().positive(),
      implementing: z.number().int().positive(),
      ai_review: z.number().int().positive(),
      verify: z.number().int().positive(),
      publishing: z.number().int().positive(),
    })
    .partial()
    .optional(),
  claim_ttl: z
    .object({
      planning: z.number().int().positive(),
      implementing: z.number().int().positive(),
      ai_review: z.number().int().positive(),
      verify: z.number().int().positive(),
      publishing: z.number().int().positive(),
    })
    .partial()
    .optional(),
  api_error_backoff: z
    .object({
      sequence: z.array(z.number().int().positive()),
      cap: z.number().int().positive(),
    })
    .optional(),
  max_ai_decline_cycles: z.number().int().min(1).optional(),
  publishing_solve_conflicts: z.boolean().optional(),
  escalation_auto_resolve: z.boolean().optional(),
});

export const taskListQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  project_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const cleanupQuerySchema = z.object({
  window: z.enum(TERM_WINDOW_VALUES),
});
