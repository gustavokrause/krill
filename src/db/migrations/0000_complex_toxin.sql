CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`at` integer NOT NULL,
	`stage` text NOT NULL,
	`author` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "comments_author_enum" CHECK("comments"."author" IN ('human','ai'))
);
--> statement-breakpoint
CREATE INDEX `comments_task_at_idx` ON `comments` (`task_id`,`at`);--> statement-breakpoint
CREATE TABLE `global_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`worktrees_root` text DEFAULT '~/.ai-worktrees/' NOT NULL,
	`automation_enabled` integer DEFAULT true NOT NULL,
	`stage_enabled` text NOT NULL,
	`cron_cadence` text NOT NULL,
	`max_stage_duration` text NOT NULL,
	`claim_ttl` text NOT NULL,
	`api_error_backoff` text NOT NULL,
	`max_ai_decline_cycles` integer DEFAULT 3 NOT NULL,
	CONSTRAINT "global_config_singleton" CHECK("global_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`folder_path` text NOT NULL,
	`has_repo` integer DEFAULT false NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`max_parallel_tasks` integer DEFAULT 1 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`task_counter` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "projects_max_parallel_range" CHECK("projects"."max_parallel_tasks" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_uniq` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`status` text NOT NULL,
	`mode` text NOT NULL,
	`plan` text DEFAULT '' NOT NULL,
	`checklist` text DEFAULT '' NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`conflicts_with` text DEFAULT '[]' NOT NULL,
	`affected_paths` text DEFAULT '[]' NOT NULL,
	`branch` text,
	`worktree_path` text,
	`workspace_path` text,
	`delivery_url` text,
	`skip_plan` integer DEFAULT false NOT NULL,
	`skip_plan_review` integer DEFAULT false NOT NULL,
	`skip_ai_review` integer DEFAULT false NOT NULL,
	`claimed_until` integer,
	`claimed_by` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`stage_entered_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_status_enum" CHECK("tasks"."status" IN ('BACKLOG','TODO','PLANNING','PLAN-REVIEW','IMPLEMENTING','AI-REVIEW','PUBLISHING','HUMAN-REVIEW','DONE','CANCELED')),
	CONSTRAINT "tasks_priority_enum" CHECK("tasks"."priority" IN ('P0','P1','P2','P3')),
	CONSTRAINT "tasks_mode_enum" CHECK("tasks"."mode" IN ('dev','non-dev'))
);
--> statement-breakpoint
CREATE INDEX `tasks_status_claim_idx` ON `tasks` (`status`,`claimed_until`);--> statement-breakpoint
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);