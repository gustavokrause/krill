CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`stage` text NOT NULL,
	`tool` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_calls_task_idx` ON `tool_calls` (`task_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_tool_idx` ON `tool_calls` (`tool`);--> statement-breakpoint
CREATE INDEX `tool_calls_created_idx` ON `tool_calls` (`created_at`);