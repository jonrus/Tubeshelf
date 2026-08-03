CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "name_length_check" CHECK(length("categories"."name") <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `ignore_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`keyword` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`youtube_channel_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`unsubscribed_at` integer,
	`missed_videos_dismissed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`youtube_channel_id`) REFERENCES `youtube_channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_channel_unique` ON `subscriptions` (`user_id`,`youtube_channel_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`failed_login_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`youtube_video_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`published_at` integer,
	`status` text DEFAULT 'unwatched' NOT NULL,
	`ignore_method` text,
	`watched_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `youtube_channels`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "status_check" CHECK("videos"."status" in ('unwatched','watching','watched','ignored')),
	CONSTRAINT "ignore_method_check" CHECK("videos"."ignore_method" is null or "videos"."ignore_method" in ('manual','auto')),
	CONSTRAINT "watched_at_check" CHECK(("videos"."status" = 'watched') = ("videos"."watched_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `videos_youtube_video_id_unique` ON `videos` (`youtube_video_id`);--> statement-breakpoint
CREATE TABLE `youtube_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`youtube_channel_id` text NOT NULL,
	`name` text NOT NULL,
	`rss_url` text NOT NULL,
	`possible_missed_videos_detected_at` integer,
	`last_fetched_at` integer,
	`next_fetch_due_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `youtube_channels_youtube_channel_id_unique` ON `youtube_channels` (`youtube_channel_id`);