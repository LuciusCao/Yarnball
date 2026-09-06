ALTER TABLE "entries" ADD COLUMN "transit_mode" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "city_name" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "stops" jsonb;--> statement-breakpoint
-- 回填存量行程：stops = [主目的地镜像]（destinationCity/cityAdcode/cityCenter 保留为 stops[0] 镜像，单城市行为不变）
UPDATE "trips" SET "stops" = jsonb_build_array(jsonb_build_object(
  'name', "destination_city",
  'adcode', "city_adcode",
  'center', CASE WHEN "city_center_lng" IS NOT NULL AND "city_center_lat" IS NOT NULL
    THEN jsonb_build_object('lng', "city_center_lng"::float8, 'lat', "city_center_lat"::float8)
    ELSE NULL END
)) WHERE "stops" IS NULL;--> statement-breakpoint
-- 回填存量地点：单城市行程全部归属主目的地（恒正确）
UPDATE "places" p SET "city_name" = t."destination_city" FROM "trips" t WHERE p."trip_id" = t."id" AND p."city_name" IS NULL;