PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_global_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`worktrees_root` text DEFAULT '~/.ai-worktrees/' NOT NULL,
	`automation_enabled` integer DEFAULT true NOT NULL,
	`stage_enabled` text NOT NULL,
	`cron_cadence` text NOT NULL,
	`max_stage_duration` text NOT NULL,
	`claim_ttl` text NOT NULL,
	`api_error_backoff` text NOT NULL,
	`max_ai_decline_cycles` integer DEFAULT 3 NOT NULL,
	`publishing_solve_conflicts` integer DEFAULT false NOT NULL,
	CONSTRAINT "global_config_singleton" CHECK("__new_global_config"."id" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_global_config`("id", "worktrees_root", "automation_enabled", "stage_enabled", "cron_cadence", "max_stage_duration", "claim_ttl", "api_error_backoff", "max_ai_decline_cycles", "publishing_solve_conflicts") SELECT "id", "worktrees_root", "automation_enabled", "stage_enabled", "cron_cadence", "max_stage_duration", "claim_ttl", "api_error_backoff", "max_ai_decline_cycles", "publishing_solve_conflicts" FROM `global_config`;--> statement-breakpoint
DROP TABLE `global_config`;--> statement-breakpoint
ALTER TABLE `__new_global_config` RENAME TO `global_config`;--> statement-breakpoint
UPDATE `global_config` SET `publishing_solve_conflicts` = false WHERE `id` = 1;--> statement-breakpoint
PRAGMA foreign_keys=ON;