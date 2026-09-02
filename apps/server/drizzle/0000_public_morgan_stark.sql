CREATE TABLE "agent_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"command" text NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_session_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"agent_registry_id" text NOT NULL,
	"agent_label" text NOT NULL,
	"acp_session_id" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"allow_all_permissions" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"ui_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "days" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"day_index" integer NOT NULL,
	"date" text
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"day_id" text NOT NULL,
	"place_id" text NOT NULL,
	"position" integer NOT NULL,
	"start_time" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "hotel_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"place_id" text NOT NULL,
	"price_per_night" integer,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"lng" numeric(10, 6) NOT NULL,
	"lat" numeric(10, 6) NOT NULL,
	"address" text,
	"amap_poi_id" text,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_url" text,
	"notes" text,
	"duration_min" integer,
	"price_cny" integer,
	"created_by" text DEFAULT 'human' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_legs" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"day_id" text NOT NULL,
	"from_entry_id" text NOT NULL,
	"to_entry_id" text NOT NULL,
	"mode" text NOT NULL,
	"distance_m" integer,
	"duration_s" integer,
	"polyline" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"destination_city" text NOT NULL,
	"city_adcode" text,
	"city_center_lng" numeric(10, 6),
	"city_center_lat" numeric(10, 6),
	"start_date" text,
	"end_date" text,
	"selected_hotel_candidate_id" text,
	"share_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "days" ADD CONSTRAINT "days_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_day_id_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_candidates" ADD CONSTRAINT "hotel_candidates_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_candidates" ADD CONSTRAINT "hotel_candidates_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD CONSTRAINT "transport_legs_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD CONSTRAINT "transport_legs_day_id_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD CONSTRAINT "transport_legs_from_entry_id_entries_id_fk" FOREIGN KEY ("from_entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD CONSTRAINT "transport_legs_to_entry_id_entries_id_fk" FOREIGN KEY ("to_entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tokens_hash_idx" ON "agent_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_session_seq_uq" ON "chat_messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "chat_sessions_trip_idx" ON "chat_sessions" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "days_trip_index_uq" ON "days" USING btree ("trip_id","day_index");--> statement-breakpoint
CREATE INDEX "entries_day_idx" ON "entries" USING btree ("day_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entries_day_position_uq" ON "entries" USING btree ("day_id","position");--> statement-breakpoint
CREATE INDEX "hotel_cand_trip_idx" ON "hotel_candidates" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "places_trip_idx" ON "places" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "legs_day_idx" ON "transport_legs" USING btree ("day_id");