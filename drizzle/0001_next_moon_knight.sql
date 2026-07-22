CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`youtube_channel_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`unsubscribed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`youtube_channel_id`) REFERENCES `youtube_channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_channel_unique` ON `subscriptions` (`user_id`,`youtube_channel_id`);--> statement-breakpoint
CREATE TABLE `youtube_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`youtube_channel_id` text NOT NULL,
	`name` text NOT NULL,
	`rss_url` text NOT NULL,
	`possible_missed_videos` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `youtube_channels_youtube_channel_id_unique` ON `youtube_channels` (`youtube_channel_id`);--> statement-breakpoint
DROP TABLE `channels`;--> statement-breakpoint
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
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `youtube_channels`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "status_check" CHECK("__new_videos"."status" in ('unwatched','watching','watched','ignored')),
	CONSTRAINT "ignore_method_check" CHECK("__new_videos"."ignore_method" is null or "__new_videos"."ignore_method" in ('manual','auto'))
);
--> statement-breakpoint
INSERT INTO `__new_videos`("id", "channel_id", "youtube_video_id", "title", "description", "published_at", "status", "ignore_method", "created_at") SELECT "id", "channel_id", "youtube_video_id", "title", "description", "published_at", "status", "ignore_method", "created_at" FROM `videos`;--> statement-breakpoint
DROP TABLE `videos`;--> statement-breakpoint
ALTER TABLE `__new_videos` RENAME TO `videos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `videos_youtube_video_id_unique` ON `videos` (`youtube_video_id`);