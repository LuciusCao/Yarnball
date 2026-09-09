CREATE TABLE `agent_registry` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`command` text NOT NULL,
	`args` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_session_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`chat_session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_tokens_hash_idx` ON `agent_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_session_idx` ON `chat_messages` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_session_seq_uq` ON `chat_messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`agent_registry_id` text NOT NULL,
	`agent_label` text NOT NULL,
	`acp_session_id` text,
	`status` text DEFAULT 'starting' NOT NULL,
	`allow_all_permissions` integer DEFAULT false NOT NULL,
	`has_mcp_call` integer DEFAULT false NOT NULL,
	`last_error` text,
	`ui_context` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_sessions_trip_idx` ON `chat_sessions` (`trip_id`);--> statement-breakpoint
CREATE TABLE `days` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`day_index` integer NOT NULL,
	`date` text,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `days_trip_index_uq` ON `days` (`trip_id`,`day_index`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`day_id` text NOT NULL,
	`place_id` text,
	`entry_type` text DEFAULT 'place' NOT NULL,
	`position` integer NOT NULL,
	`start_time` text,
	`duration_min` integer,
	`note` text,
	`depart_time` text,
	`arrive_time` text,
	`from_place_id` text,
	`to_place_id` text,
	`from_name` text,
	`to_name` text,
	`transit_mode` text,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`to_place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `entries_day_idx` ON `entries` (`day_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `entries_day_position_uq` ON `entries` (`day_id`,`position`);--> statement-breakpoint
CREATE TABLE `hotel_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`place_id` text NOT NULL,
	`price_per_night` integer,
	`notes` text,
	`selected` integer DEFAULT false NOT NULL,
	`check_in_day` integer,
	`check_out_day` integer,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hotel_cand_trip_idx` ON `hotel_candidates` (`trip_id`);--> statement-breakpoint
CREATE TABLE `places` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`lng` real NOT NULL,
	`lat` real NOT NULL,
	`address` text,
	`website` text,
	`booking_url` text,
	`phone` text,
	`city_name` text,
	`amap_poi_id` text,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`source_url` text,
	`notes` text,
	`duration_min` integer,
	`visit_duration_min` integer,
	`price_cny` integer,
	`booking_info` text,
	`opening_hours` text,
	`booking_status` text DEFAULT 'none' NOT NULL,
	`created_by` text DEFAULT 'human' NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `places_trip_idx` ON `places` (`trip_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`amap_js_key` text,
	`amap_server_key` text,
	`amap_js_secret` text,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transport_legs` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`day_id` text NOT NULL,
	`from_entry_id` text,
	`to_entry_id` text,
	`from_place_id` text,
	`to_place_id` text,
	`seq` integer DEFAULT 0 NOT NULL,
	`mode` text NOT NULL,
	`mode_override` text,
	`distance_m` integer,
	`duration_s` integer,
	`polyline` text,
	`transit_detail` text,
	`computed_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`day_id`) REFERENCES `days`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `legs_day_idx` ON `transport_legs` (`day_id`);--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`destination_city` text NOT NULL,
	`city_adcode` text,
	`geo_provider` text DEFAULT 'osm' NOT NULL,
	`city_center_lng` real,
	`city_center_lat` real,
	`stops` text,
	`start_date` text,
	`end_date` text,
	`selected_hotel_candidate_id` text,
	`budget_cny` integer,
	`traveler_count` integer DEFAULT 1 NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`share_token` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
