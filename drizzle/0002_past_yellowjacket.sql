ALTER TABLE `youtube_channels` ADD `last_fetched_at` integer;--> statement-breakpoint
ALTER TABLE `youtube_channels` ADD `next_fetch_due_at` integer;