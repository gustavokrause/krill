CREATE TABLE `blockers` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text DEFAULT 'krill' NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`task_id` text,
	`stage` text,
	`summary` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`action_url` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `blockers_status_idx` ON `blockers` (`status`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `blocked` integer DEFAULT false NOT NULL;