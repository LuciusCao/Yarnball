CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"amap_js_key" text,
	"amap_server_key" text,
	"amap_js_secret" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "status" text DEFAULT 'candidate' NOT NULL;--> statement-breakpoint
-- 存量数据回填：人类手动创建的地点视为已确认（locked），保持与 service 层「human 建点默认 locked」一致
UPDATE "places" SET "status" = 'locked' WHERE "created_by" = 'human';--> statement-breakpoint
ALTER TABLE "transport_legs" ADD COLUMN "mode_override" text;