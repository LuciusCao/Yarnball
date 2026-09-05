CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"amap_js_key" text,
	"amap_server_key" text,
	"amap_js_secret" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "status" text DEFAULT 'candidate' NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_legs" ADD COLUMN "mode_override" text;