import { z } from "zod";
import {
  COMMENT_AUTHORS,
  MODES,
  PRIORITIES,
  TASK_STATUSES,
} from "@/db/schema";

export const slugSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Z][A-Z0-9]*$/, "slug must be UPPERCASE alphanumeric, start with a letter");

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(120),
  slug: slugSchema,
  folder_path: z.string().min(1),
  has_repo: z.boolean().optional(),
  default_branch: z.string().min(1).optional(),
  max_parallel_tasks: z.number().int().min(1).max(5).optional(),
  paused: z.boolean().optional(),
});

export const projectPatchSchema = projectCreateSchema
  .partial()
  .omit({ slug: true });

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
  auto_publish: z.boolean().default(false),
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
      publishing: z.number().int().positive(),
    })
    .partial()
    .optional(),
  max_stage_duration: z
    .object({
      planning: z.number().int().positive(),
      implementing: z.number().int().positive(),
      ai_review: z.number().int().positive(),
      publishing: z.number().int().positive(),
    })
    .partial()
    .optional(),
  claim_ttl: z
    .object({
      planning: z.number().int().positive(),
      implementing: z.number().int().positive(),
      ai_review: z.number().int().positive(),
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
});

export const taskListQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  project_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
