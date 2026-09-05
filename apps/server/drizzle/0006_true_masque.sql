ALTER TABLE "entries" ALTER COLUMN "place_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "entry_type" text DEFAULT 'place' NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "duration_min" integer;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "depart_time" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "arrive_time" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "from_place_id" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "to_place_id" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "from_name" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "to_name" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "opening_hours" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "booking_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_from_place_id_places_id_fk" FOREIGN KEY ("from_place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_to_place_id_places_id_fk" FOREIGN KEY ("to_place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;