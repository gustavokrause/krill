CREATE TABLE `usage_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`scope` text NOT NULL,
	`model_bucket` text,
	`used_pct` real NOT NULL,
	`resets_at` integer,
	`observed_at` integer NOT NULL,
	`raw` text,
	CONSTRAINT "usage_limits_source_enum" CHECK("usage_limits"."source" IN ('cli','oauth','estimate'))
);
--> statement-breakpoint
CREATE INDEX `usage_limits_observed_idx` ON `usage_limits` (`observed_at`);--> statement-breakpoint
CREATE INDEX `usage_limits_scope_idx` ON `usage_limits` (`scope`);--> statement-breakpoint
ALTER TABLE `global_config` ADD `limit_guard_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `limit_soft_pct` integer DEFAULT 75 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `limit_hard_pct` integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `limit_poll_sec` integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `limit_resume_grace_sec` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `paused_by_limit` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `global_config` ADD `limit_resume_at` integer;