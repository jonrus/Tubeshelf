PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ignore_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`keyword` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "keyword_length_check" CHECK(length("__new_ignore_rules"."keyword") <= 200)
);
--> statement-breakpoint
INSERT INTO `__new_ignore_rules`("id", "keyword", "created_at") SELECT "id", "keyword", "created_at" FROM `ignore_rules`;--> statement-breakpoint
DROP TABLE `ignore_rules`;--> statement-breakpoint
ALTER TABLE `__new_ignore_rules` RENAME TO `ignore_rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;