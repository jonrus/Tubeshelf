ALTER TABLE `subscriptions` ADD `missed_videos_dismissed_at` integer;--> statement-breakpoint
ALTER TABLE `youtube_channels` ADD `possible_missed_videos_detected_at` integer;--> statement-breakpoint
UPDATE `youtube_channels` SET `possible_missed_videos_detected_at` = COALESCE(`last_fetched_at`, unixepoch()) WHERE `possible_missed_videos` = 1;--> statement-breakpoint
ALTER TABLE `youtube_channels` DROP COLUMN `possible_missed_videos`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "name_length_check" CHECK(length("__new_categories"."name") <= 100)
);
--> statement-breakpoint
INSERT INTO `__new_categories`("id", "name", "is_system", "created_at") SELECT "id", "name", "is_system", "created_at" FROM `categories`;--> statement-breakpoint
DROP TABLE `categories`;--> statement-breakpoint
ALTER TABLE `__new_categories` RENAME TO `categories`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);