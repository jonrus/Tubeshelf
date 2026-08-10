CREATE INDEX `videos_status_published_idx` ON `videos` (`status`,`published_at`,`id`);--> statement-breakpoint
CREATE INDEX `videos_status_watched_idx` ON `videos` (`status`,`watched_at`,`id`);--> statement-breakpoint
CREATE INDEX `videos_status_created_idx` ON `videos` (`status`,`created_at`,`id`);