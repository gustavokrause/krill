PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`status` text NOT NULL,
	`pending_review_kind` text,
	`mode` text NOT NULL,
	`plan` text DEFAULT '' NOT NULL,
	`checklist` text DEFAULT '' NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`conflicts_with` text DEFAULT '[]' NOT NULL,
	`affected_paths` text DEFAULT '[]' NOT NULL,
	`branch` text,
	`worktree_path` text,
	`workspace_path` text,
	`delivery_url` text,
	`skip_plan` integer DEFAULT false NOT NULL,
	`skip_plan_review` integer DEFAULT false NOT NULL,
	`skip_ai_review` integer DEFAULT false NOT NULL,
	`claimed_until` integer,
	`claimed_by` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`stage_entered_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_status_enum" CHECK("__new_tasks"."status" IN ('BACKLOG','TODO','PLANNING','IMPLEMENTING','AI-REVIEW','PUBLISHING','NEEDS_REVIEW','DONE','CANCELED')),
	CONSTRAINT "tasks_priority_enum" CHECK("__new_tasks"."priority" IN ('P0','P1','P2','P3')),
	CONSTRAINT "tasks_mode_enum" CHECK("__new_tasks"."mode" IN ('dev','non-dev')),
	CONSTRAINT "tasks_pending_review_kind_enum" CHECK("__new_tasks"."pending_review_kind" IS NULL OR "__new_tasks"."pending_review_kind" IN ('plan','deliverable','conflict')),
	CONSTRAINT "tasks_pending_review_kind_requires_status" CHECK(("__new_tasks"."status" = 'NEEDS_REVIEW' AND "__new_tasks"."pending_review_kind" IS NOT NULL) OR ("__new_tasks"."status" <> 'NEEDS_REVIEW' AND "__new_tasks"."pending_review_kind" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`(
	"id", "project_id", "name", "description", "priority",
	"status", "pending_review_kind",
	"mode", "plan", "checklist",
	"depends_on", "conflicts_with", "affected_paths",
	"branch", "worktree_path", "workspace_path", "delivery_url",
	"skip_plan", "skip_plan_review", "skip_ai_review",
	"claimed_until", "claimed_by",
	"created_at", "started_at", "stage_entered_at", "updated_at", "ended_at"
)
SELECT
	t."id", t."project_id", t."name", t."description", t."priority",
	CASE
		WHEN t."status" IN ('PLAN-REVIEW', 'HUMAN-REVIEW') THEN 'NEEDS_REVIEW'
		ELSE t."status"
	END AS "status",
	CASE
		WHEN t."status" = 'PLAN-REVIEW' THEN 'plan'
		WHEN t."status" = 'HUMAN-REVIEW' AND COALESCE((
			SELECT c."text"
			FROM "comments" c
			WHERE c."task_id" = t."id"
			  AND c."stage" = 'PUBLISHING'
			  AND c."author" = 'ai'
			ORDER BY c."at" DESC
			LIMIT 1
		), '') LIKE '%conflict resolver disabled%' THEN 'conflict'
		WHEN t."status" = 'HUMAN-REVIEW' AND COALESCE((
			SELECT c."text"
			FROM "comments" c
			WHERE c."task_id" = t."id"
			  AND c."stage" = 'PUBLISHING'
			  AND c."author" = 'ai'
			ORDER BY c."at" DESC
			LIMIT 1
		), '') LIKE '%conflict resolution failed%' THEN 'conflict'
		WHEN t."status" = 'HUMAN-REVIEW' THEN 'deliverable'
		ELSE NULL
	END AS "pending_review_kind",
	t."mode", t."plan", t."checklist",
	t."depends_on", t."conflicts_with", t."affected_paths",
	t."branch", t."worktree_path", t."workspace_path", t."delivery_url",
	t."skip_plan", t."skip_plan_review", t."skip_ai_review",
	t."claimed_until", t."claimed_by",
	t."created_at", t."started_at", t."stage_entered_at", t."updated_at", t."ended_at"
FROM `tasks` t;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_status_claim_idx` ON `tasks` (`status`,`claimed_until`);--> statement-breakpoint
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);--> statement-breakpoint
UPDATE `comments` SET `stage` = 'NEEDS_REVIEW' WHERE `stage` IN ('PLAN-REVIEW', 'HUMAN-REVIEW');
