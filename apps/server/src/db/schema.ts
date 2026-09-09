import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 行 → DTO 映射统一在 services/mappers.ts；列名显式 snake_case。
 * 主键用应用侧生成的 UUID（crypto.randomUUID），便于 SSE/前端直接引用。
 */

export const trips = sqliteTable("trips", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  destinationCity: text("destination_city").notNull(),
  cityAdcode: text("city_adcode"),
  /** 地理 provider：amap（国内）| osm（海外） */
  geoProvider: text("geo_provider").notNull().default("osm"),
  cityCenterLng: real("city_center_lng"),
  cityCenterLat: real("city_center_lat"),
  /**
   * 有序途经地节点（TripStop[] = [{ name, adcode, center }]，多城市/环线）。
   * destinationCity/cityAdcode/cityCenterLng/Lat 保留为 stops[0] 的兼容镜像，
   * 旧前端/搜索/自愈逻辑零破坏（同 selected_hotel_candidate_id 镜像模式）；由 service 层同步维护。
   * 单城市行程恒为单元素；环线闭合不落库（由末段 transit 讫点 == stops[0] 推断）。
   */
  stops: text("stops", { mode: "json" }),
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
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const places = sqliteTable(
  "places",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category").notNull(), // PlaceCategory
    lng: real("lng").notNull(),
    lat: real("lat").notNull(),
    address: text("address"),
    /** 官网链接 */
    website: text("website"),
    /** 预订链接（可直接跳转下单/预约） */
    bookingUrl: text("booking_url"),
    /** 联系电话 */
    phone: text("phone"),
    /** 归属途经地/城市展示名（多城市分组依据）：建点时自动填充（显式传 > 最近 stop ≤150km > null），可改 */
    cityName: text("city_name"),
    amapPoiId: text("amap_poi_id"),
    sourceType: text("source_type").notNull().default("manual"),
    sourceUrl: text("source_url"),
    notes: text("notes"),
    durationMin: integer("duration_min"),
    /** 预计游览/用餐分钟数（景点/美食的参观时长预估，排天参考输入） */
    visitDurationMin: integer("visit_duration_min"),
    priceCny: integer("price_cny"),
    bookingInfo: text("booking_info"),
    /** 营业时间（v1 自由文本，如「09:00-17:00 周一闭馆」） */
    openingHours: text("opening_hours"),
    /** 预订状态流转：none | pending | booked（以用户界面标记为准） */
    bookingStatus: text("booking_status").notNull().default("none"),
    createdBy: text("created_by").notNull().default("human"), // human | agent
    /** 候选状态机：candidate | locked；human 手动创建在 service 层置 locked */
    status: text("status").notNull().default("candidate"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [index("places_trip_idx").on(t.tripId)],
);

export const days = sqliteTable(
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

export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    dayId: text("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    /** entryType=place 时非空；transit 可为 null（纯自由文本起讫点） */
    placeId: text("place_id").references(() => places.id, { onDelete: "cascade" }),
    /** place=常规地点节点；transit=大交通节点（航班/高铁/城际移动），不建新表 */
    entryType: text("entry_type").notNull().default("place"),
    position: integer("position").notNull(),
    startTime: text("start_time"), // HH:MM
    /** 单条停留时长覆盖（分钟）；null = 用 place.durationMin */
    durationMin: integer("duration_min"),
    note: text("note"),
    // ---- transit entry 字段（entryType=transit 时有意义） ----
    departTime: text("depart_time"), // HH:MM
    arriveTime: text("arrive_time"), // HH:MM
    /** 起点：行程内地点（参与路线锚定走真实坐标）；引用地点删除时退回纯文本 */
    fromPlaceId: text("from_place_id").references(() => places.id, { onDelete: "set null" }),
    toPlaceId: text("to_place_id").references(() => places.id, { onDelete: "set null" }),
    fromName: text("from_name"),
    toName: text("to_name"),
    /** 大交通方式：flight|train|drive|bus；null=未指定（直线段）。drive=自驾：城际段走真实路由 */
    transitMode: text("transit_mode"),
  },
  (t) => [
    index("entries_day_idx").on(t.dayId),
    uniqueIndex("entries_day_position_uq").on(t.dayId, t.position),
  ],
);

export const transportLegs = sqliteTable(
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
    polyline: text("polyline", { mode: "json" }), // LngLat[] | null
    /** 公交分段详情（TransitSegment[] | null）：仅 amap transit 真实公交路由填充，osm/降级/旧数据为 null */
    transitDetail: text("transit_detail", { mode: "json" }),
    computedAt: integer("computed_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [index("legs_day_idx").on(t.dayId)],
);

export const hotelCandidates = sqliteTable(
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
    selected: integer("selected", { mode: "boolean" }).notNull().default(false),
    /** 入住天序号（1-based）；闭开区间 [checkInDay, checkOutDay) 覆盖每晚住宿，仅 selected 时有意义 */
    checkInDay: integer("check_in_day"),
    /** 离店天序号（1-based，不含当天住宿）；换酒店日 = 旧酒店 checkOutDay = 新酒店 checkInDay */
    checkOutDay: integer("check_out_day"),
  },
  (t) => [index("hotel_cand_trip_idx").on(t.tripId)],
);

export const chatSessions = sqliteTable(
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
    allowAllPermissions: integer("allow_all_permissions", { mode: "boolean" }).notNull().default(false),
    /** 会话是否命中过 yarnball MCP 工具调用（/mcp 层置位的持久化 ground truth，冒烟提示据此免误报） */
    hasMcpCall: integer("has_mcp_call", { mode: "boolean" }).notNull().default(false),
    lastError: text("last_error"),
    uiContext: text("ui_context", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [index("chat_sessions_trip_idx").on(t.tripId)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id"),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(), // ChatMessageKind
    content: text("content", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_messages_session_idx").on(t.sessionId),
    uniqueIndex("chat_messages_session_seq_uq").on(t.sessionId, t.seq),
  ],
);

export const agentRegistry = sqliteTable("agent_registry", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  command: text("command").notNull(),
  args: text("args", { mode: "json" }).notNull().default([]), // string[]
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

/**
 * 全局设置（单行，id 固定 "global"）。
 * 存的值覆盖同名 env（读取优先级 DB > env），null = 未覆盖回退 env。
 */
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(),
  amapJsKey: text("amap_js_key"),
  amapServerKey: text("amap_server_key"),
  amapJsSecret: text("amap_js_secret"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const agentTokens = sqliteTable(
  "agent_tokens",
  {
    id: text("id").primaryKey(),
    chatSessionId: text("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(), // sha256 hex
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [index("agent_tokens_hash_idx").on(t.tokenHash)],
);
