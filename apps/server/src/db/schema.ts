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
  selectedHotelCandidateId: text("selected_hotel_candidate_id"),
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
    createdBy: text("created_by").notNull().default("human"), // human | agent
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
    fromEntryId: text("from_entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    toEntryId: text("to_entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(), // TransportMode
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
