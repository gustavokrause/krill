CREATE TABLE `followups` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `followups_status_idx` ON `followups` (`status`);