ALTER TABLE "transport_legs" ALTER COLUMN "from_entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_legs" ALTER COLUMN "to_entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD COLUMN "from_place_id" text;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD COLUMN "to_place_id" text;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD COLUMN "seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD CONSTRAINT "transport_legs_from_place_id_places_id_fk" FOREIGN KEY ("from_place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD CONSTRAINT "transport_legs_to_place_id_places_id_fk" FOREIGN KEY ("to_place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;