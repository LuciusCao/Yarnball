ALTER TABLE "places" ADD COLUMN "booking_info" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "budget_cny" integer;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "traveler_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "currency" text DEFAULT 'CNY' NOT NULL;