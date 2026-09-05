import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * 行 → DTO 映射统一在 services/mappers.ts；列名显式 snake_case。
 * 主键用应用侧生成的 UUID（crypto.randomUUID），便于 SSE/前端直接引用。
 */

export const trips = pgTable("trips", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  destinationCity: text("destination_city").notNull(),
  cityAdcode: text("city_adcode"),
  /** 地理 provider：amap（国内）| osm（海外） */
  geoProvider: text("geo_provider").notNull().default("osm"),
  cityCenterLng: numeric("city_center_lng", { precision: 10, scale: 6 }),
  cityCenterLat: numeric("city_center_lat", { precision: 10, scale: 6 }),
  startDate: text("start_date"), // YYYY-MM-DD
  endDate: text("end_date"),
  /**
   * 兼容镜像（deprecated）：指向 checkInDay 最早的已选定酒店候选，供旧前端过渡。
   * 权威数据在 hotel_candidates.selected + check_in_day/check_out_day；由 service 层同步维护。
   */
  selectedHotelCandidateId: text("selected_hotel_candidate_id"),
  /** 总预算（币种为 currency） */
  budgetCny: integer("budget_cny"),
  travelerCount: integer("traveler_count").notNull().default(1),
  currency: text("currency").notNull().default("CNY"),
  shareToken: text("share_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const places = pgTable(
  "places",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category").notNull(), // PlaceCategory
    lng: numeric("lng", { precision: 10, scale: 6 }).notNull(),
    lat: numeric("lat", { precision: 10, scale: 6 }).notNull(),
    address: text("address"),
    amapPoiId: text("amap_poi_id"),
    sourceType: text("source_type").notNull().default("manual"),
    sourceUrl: text("source_url"),
    notes: text("notes"),
    durationMin: integer("duration_min"),
    priceCny: integer("price_cny"),
    bookingInfo: text("booking_info"),
    createdBy: text("created_by").notNull().default("human"), // human | agent
    /** 候选状态机：candidate | locked；human 手动创建在 service 层置 locked */
    status: text("status").notNull().default("candidate"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("places_trip_idx").on(t.tripId)],
);

export const days = pgTable(
  "days",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    dayIndex: integer("day_index").notNull(),
    date: text("date"),
  },
  (t) => [uniqueIndex("days_trip_index_uq").on(t.tripId, t.dayIndex)],
);

export const entries = pgTable(
  "entries",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    dayId: text("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    placeId: text("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    startTime: text("start_time"), // HH:MM
    note: text("note"),
  },
  (t) => [
    index("entries_day_idx").on(t.dayId),
    uniqueIndex("entries_day_position_uq").on(t.dayId, t.position),
  ],
);

export const transportLegs = pgTable(
  "transport_legs",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    dayId: text("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    /** 出发端点：行程内地点（entry）或酒店（place），fromEntryId/fromPlaceId 二选一 */
    fromEntryId: text("from_entry_id").references(() => entries.id, { onDelete: "cascade" }),
    toEntryId: text("to_entry_id").references(() => entries.id, { onDelete: "cascade" }),
    fromPlaceId: text("from_place_id").references(() => places.id, { onDelete: "cascade" }),
    toPlaceId: text("to_place_id").references(() => places.id, { onDelete: "cascade" }),
    /** 天内的段序号（含酒店往返段） */
    seq: integer("seq").notNull().default(0),
    mode: text("mode").notNull(), // TransportMode
    /** 手动覆盖的交通方式：非空时 recalcDayLegs 保留它，不被自动规则冲掉 */
    modeOverride: text("mode_override"),
    distanceM: integer("distance_m"),
    durationS: integer("duration_s"),
    polyline: jsonb("polyline"), // LngLat[] | null
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("legs_day_idx").on(t.dayId)],
);

export const hotelCandidates = pgTable(
  "hotel_candidates",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    placeId: text("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    pricePerNight: integer("price_per_night"),
    notes: text("notes"),
    /** 是否已选定（多酒店：同一行程可选定多家，各覆盖一段天数） */
    selected: boolean("selected").notNull().default(false),
    /** 入住天序号（1-based）；闭开区间 [checkInDay, checkOutDay) 覆盖每晚住宿，仅 selected 时有意义 */
    checkInDay: integer("check_in_day"),
    /** 离店天序号（1-based，不含当天住宿）；换酒店日 = 旧酒店 checkOutDay = 新酒店 checkInDay */
    checkOutDay: integer("check_out_day"),
  },
  (t) => [index("hotel_cand_trip_idx").on(t.tripId)],
);

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    agentRegistryId: text("agent_registry_id").notNull(),
    agentLabel: text("agent_label").notNull(),
    acpSessionId: text("acp_session_id"), // agent 侧返回的 sessionId（resume 用）
    status: text("status").notNull().default("starting"),
    allowAllPermissions: boolean("allow_all_permissions").notNull().default(false),
    lastError: text("last_error"),
    uiContext: jsonb("ui_context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_sessions_trip_idx").on(t.tripId)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id"),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(), // ChatMessageKind
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_messages_session_idx").on(t.sessionId),
    uniqueIndex("chat_messages_session_seq_uq").on(t.sessionId, t.seq),
  ],
);

export const agentRegistry = pgTable("agent_registry", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  command: text("command").notNull(),
  args: jsonb("args").notNull().default([]), // string[]
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 全局设置（单行，id 固定 "global"）。
 * 存的值覆盖同名 env（读取优先级 DB > env），null = 未覆盖回退 env。
 */
export const settings = pgTable("settings", {
  id: text("id").primaryKey(),
  amapJsKey: text("amap_js_key"),
  amapServerKey: text("amap_server_key"),
  amapJsSecret: text("amap_js_secret"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(), // sha256 hex
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_tokens_hash_idx").on(t.tokenHash)],
);
