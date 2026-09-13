CREATE TABLE `trip_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trip_notes_trip_idx` ON `trip_notes` (`trip_id`);--> statement-breakpoint
ALTER TABLE `days` ADD `summary` text;