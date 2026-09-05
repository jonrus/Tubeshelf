PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`youtube_video_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`published_at` integer,
	`status` text DEFAULT 'unwatched' NOT NULL,
	`ignore_method` text,
	`watched_at` integer,
	`duration_seconds` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `youtube_channels`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "status_check" CHECK("__new_videos"."status" in ('unwatched','watching','watched','ignored')),
	CONSTRAINT "ignore_method_check" CHECK("__new_videos"."ignore_method" is null or "__new_videos"."ignore_method" in ('manual','auto')),
	CONSTRAINT "watched_at_check" CHECK(("__new_videos"."status" = 'watched') = ("__new_videos"."watched_at" is not null)),
	CONSTRAINT "duration_seconds_check" CHECK("__new_videos"."duration_seconds" is null or "__new_videos"."duration_seconds" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_videos`("id", "channel_id", "youtube_video_id", "title", "description", "published_at", "status", "ignore_method", "watched_at", "created_at") SELECT "id", "channel_id", "youtube_video_id", "title", "description", "published_at", "status", "ignore_method", "watched_at", "created_at" FROM `videos`;--> statement-breakpoint
DROP TABLE `videos`;--> statement-breakpoint
ALTER TABLE `__new_videos` RENAME TO `videos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `videos_youtube_video_id_unique` ON `videos` (`youtube_video_id`);--> statement-breakpoint
CREATE INDEX `videos_status_published_idx` ON `videos` (`status`,`published_at`,`id`);--> statement-breakpoint
CREATE INDEX `videos_status_watched_idx` ON `videos` (`status`,`watched_at`,`id`);--> statement-breakpoint
CREATE INDEX `videos_status_created_idx` ON `videos` (`status`,`created_at`,`id`);