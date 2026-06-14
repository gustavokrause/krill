ALTER TABLE `projects` ADD `allow_auto_finish` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `auto_publish` integer DEFAULT false NOT NULL;