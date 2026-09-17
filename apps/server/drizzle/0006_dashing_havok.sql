CREATE TABLE `trip_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_label` text NOT NULL,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trip_activity_trip_idx` ON `trip_activity` (`trip_id`);