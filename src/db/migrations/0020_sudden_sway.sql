ALTER TABLE `stage_usage` ADD `resumed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `session_map` text;