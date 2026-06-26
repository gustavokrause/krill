CREATE TABLE `stage_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`stage` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`num_turns` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stage_usage_task_idx` ON `stage_usage` (`task_id`);--> statement-breakpoint
CREATE INDEX `stage_usage_project_idx` ON `stage_usage` (`project_id`);--> statement-breakpoint
CREATE INDEX `stage_usage_stage_idx` ON `stage_usage` (`stage`);--> statement-breakpoint
CREATE INDEX `stage_usage_created_idx` ON `stage_usage` (`created_at`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `est_tokens` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tokens_used` integer DEFAULT 0 NOT NULL;