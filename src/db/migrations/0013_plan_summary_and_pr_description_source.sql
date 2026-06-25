PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`folder_path` text NOT NULL,
	`has_repo` integer DEFAULT false NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`max_parallel_tasks` integer DEFAULT 1 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`create_pr` integer,
	`push_remote` integer,
	`merge_to_main` integer,
	`allow_auto_finish` integer DEFAULT false NOT NULL,
	`delete_branch_on_done` integer DEFAULT true NOT NULL,
	`draft_pr` integer DEFAULT false NOT NULL,
	`pr_description_source` text DEFAULT 'plan' NOT NULL,
	`task_counter` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "projects_max_parallel_range" CHECK("__new_projects"."max_parallel_tasks" BETWEEN 1 AND 5),
	CONSTRAINT "projects_pr_description_source_enum" CHECK("__new_projects"."pr_description_source" IN ('plan','summary'))
);
--> statement-breakpoint
-- `pr_description_source` is NEW in this migration — omit it from the copy so existing rows
-- take the column DEFAULT ('plan'). (drizzle wrongly emits it in the SELECT; corrected, as in 0011/0012.)
INSERT INTO `__new_projects`("id", "name", "slug", "folder_path", "has_repo", "default_branch", "max_parallel_tasks", "paused", "create_pr", "push_remote", "merge_to_main", "allow_auto_finish", "delete_branch_on_done", "draft_pr", "task_counter", "created_at", "updated_at") SELECT "id", "name", "slug", "folder_path", "has_repo", "default_branch", "max_parallel_tasks", "paused", "create_pr", "push_remote", "merge_to_main", "allow_auto_finish", "delete_branch_on_done", "draft_pr", "task_counter", "created_at", "updated_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_uniq` ON `projects` (`slug`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `plan_summary` text DEFAULT '' NOT NULL;