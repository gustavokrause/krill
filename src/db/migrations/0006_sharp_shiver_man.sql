ALTER TABLE `projects` ADD `delete_branch_on_done` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `draft_pr` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `create_pr` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `push_remote` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `merge_to_main` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `draft_pr` integer;