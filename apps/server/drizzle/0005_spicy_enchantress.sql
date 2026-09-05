ALTER TABLE "hotel_candidates" ADD COLUMN "selected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hotel_candidates" ADD COLUMN "check_in_day" integer;--> statement-breakpoint
ALTER TABLE "hotel_candidates" ADD COLUMN "check_out_day" integer;--> statement-breakpoint
-- 存量回填：trips.selected_hotel_candidate_id 单选 → 覆盖全部天的 stay（闭开区间 [1, 天数+1)）。
-- 天数取 max(已有 days 最大 dayIndex, 日期范围天数, 1)。selected_hotel_candidate_id 列保留为兼容镜像，由 service 层继续同步。
UPDATE "hotel_candidates" hc
SET "selected" = true,
    "check_in_day" = 1,
    "check_out_day" = (
      SELECT GREATEST(
        COALESCE((SELECT MAX(d."day_index") FROM "days" d WHERE d."trip_id" = t."id"), 0),
        CASE WHEN t."start_date" IS NOT NULL AND t."end_date" IS NOT NULL
             THEN (t."end_date"::date - t."start_date"::date) + 1
             ELSE 0
        END,
        1
      ) + 1
      FROM "trips" t
      WHERE t."selected_hotel_candidate_id" = hc."id"
    )
WHERE EXISTS (
  SELECT 1 FROM "trips" t WHERE t."selected_hotel_candidate_id" = hc."id"
);