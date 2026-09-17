/**
 * 毛线团（Yarnball）领域模型 —— zod schema 单一定义点。
 * 服务端（REST 入参校验、MCP 工具入参、DB 行映射）与前端（API 类型）共用。
 */
import { z } from "zod";

// ---------- 枚举 ----------

export const PLACE_CATEGORIES = [
  "attraction",
  "restaurant",
  "hotel",
  "activity",
  "other",
] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

/** 地点信息来源：用户粘贴的攻略平台 / 手动 / agent 创建 */
export const SOURCE_TYPES = [
  "xiaohongshu",
  "ctrip",
  "manual",
  "agent",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * 市内交通段方式（TransportLegDto.mode / set_leg_mode 的取值）。
 * 基础四值保留兼容：walk=步行 / taxi=出租车 / transit=泛公交（旧数据与未细分场景的兜底）/ drive=驾车；
 * transit 的细分子类型：ferry=渡轮 / metro=地铁 / light_rail=轻轨 / train=火车（市内线/机场线）/ bus=公交。
 * 自动判定只会产出 walk/transit/drive/ferry/train（场景化启发式，见服务端 recalcDayLegs），
 * metro/light_rail/bus 主要由用户或 agent 手动覆盖指定。
 */
export const TRANSPORT_MODES = [
  "walk",
  "taxi",
  "transit",
  "drive",
  "ferry",
  "metro",
  "light_rail",
  "train",
  "bus",
] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** 市内交通方式中文文案（行程列表 / 导出打印共用，单一定义点） */
export const TRANSPORT_MODE_LABELS: Record<TransportMode, string> = {
  walk: "步行",
  taxi: "打车/网约车",
  transit: "公交",
  drive: "驾车",
  ferry: "渡轮",
  metro: "地铁",
  light_rail: "轻轨",
  train: "火车",
  bus: "公交",
};

/** 是否公共交通类方式（含兜底 transit 与全部细分子类型）：路由/展示层按同一族处理 */
export function isTransitLikeMode(mode: TransportMode): boolean {
  return (
    mode === "transit" ||
    mode === "bus" ||
    mode === "metro" ||
    mode === "light_rail" ||
    mode === "train" ||
    mode === "ferry"
  );
}

/** 是否轨道类方式（地铁/轻轨/火车）：地图上画铁路样式而非公路线 */
export function isRailMode(mode: TransportMode): boolean {
  return mode === "metro" || mode === "light_rail" || mode === "train";
}

/**
 * 大交通方式（transit entry 的移动方式）：flight=航班 / train=火车高铁 / drive=自驾 / bus=大巴。
 * null = 未指定（保持直线段行为）。transitMode=drive 的城际段走真实路由拿公路 polyline/里程，
 * 是自驾环线体验的关键；枚举刻意收窄（不加 other/ship），引导更准。
 */
export const TRANSIT_MODES = ["flight", "train", "drive", "bus"] as const;
export type TransitMode = (typeof TRANSIT_MODES)[number];

/**
 * 变更由谁触发（人类直接编辑 or agent 经 MCP）。
 * issue #19 起带标签形态：`{ guest: "小红" }` 表示持协作链接的同伴（昵称来自 join 入口的
 * displayName）。places.created_by 等 DB 列仍只存 "human" | "agent" 二值（列宽窄、语义稳定），
 * guest 单独落在 trip_activity.actor_label——本类型只用于服务层入参传递。
 */
export type Actor = "human" | "agent" | { guest: string };

/** Actor 的类别（DB/DTO 层形态）：human=本机主人、agent=agent、guest=协作同伴 */
export const ACTOR_KINDS = ["human", "agent", "guest"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Actor 归一化：类型 + 展示标签（human→"主人"、agent→"agent"、guest→昵称） */
export function actorKindOf(actor: Actor): ActorKind {
  return typeof actor === "string" ? actor : "guest";
}

/** actor 展示标签（activity/动态流文案用）：guest 用昵称，其余用固定文案 */
export function actorLabelOf(actor: Actor): string {
  return typeof actor === "string" ? (actor === "agent" ? "agent" : "主人") : actor.guest;
}

/**
 * 地点状态机：candidate（候选池，agent 解析攻略/推荐的默认值）
 * → joined（已加入行程 = 用户确认要去；界面与 agent 话术均为「加入行程/已加入行程」）。
 * 纪律：agent 只建候选；已加入行程地点的信息字段 agent 可随时补全/修改（update_place），
 * 仅「已排进行程（有 entry 引用）的地点」agent 不可直接删除（须先移出行程）；
 * 只有已加入行程的地点才应排入某天行程。
 */
export const PLACE_STATUSES = ["candidate", "joined"] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

/**
 * entry 类型：place=常规地点节点；transit=大交通节点（航班/高铁/城际移动）。
 * transit 不建新表：复用 entries 行，起讫点挂在 fromPlaceId/toPlaceId（行程内地点，走真实坐标）
 * 或 fromName/toName（自由文本，如「萧山机场」「家」）。未来跨城市移动同样是 transit entry。
 */
export const ENTRY_TYPES = ["place", "transit"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** 预订状态流转：none=无需/未考虑预订 → pending=待预订 → booked=已预订。以用户在界面上的标记为准 */
export const BOOKING_STATUSES = ["none", "pending", "booked"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * 地理服务 provider：amap（国内，配齐 key 时启用，GCJ-02）| osm（海外，以及未配 key 的国内
 * 零配置回退，WGS84）。引擎在建行程时定死（trips.geoProvider），单行程不混坐标系。
 */
export const GEO_PROVIDERS = ["amap", "osm"] as const;
export type GeoProviderName = (typeof GEO_PROVIDERS)[number];

/**
 * 国内 + 开源引擎行程（M113 零配置回退）：目的地在中国但创建时未配齐高德 key，
 * 全链走 OSM 栈（WGS84）。前端用它给降级提示/徽标，server 用它给 bootstrap prompt 加纪律。
 * country 由建行程时的目的地解析落库（中国归一为「中国」）；存量行程该列为 null，不命中。
 */
export function isDomesticOsmTrip(trip: {
  geoProvider: GeoProviderName;
  country: string | null;
}): boolean {
  return trip.geoProvider === "osm" && trip.country === "中国";
}

/**
 * 行程级注意事项分类（trip_notes.category）：agent 按目的地/出行日期预填与更新。
 * communication=通讯（电话卡/漫游/网络）、climate=气候（着装/防晒/雨季）、power=用电（电压/插座/转换头）、
 * visa=签证（入境证件/免签政策）、currency=货币（汇率/支付习惯/小费）、transport=交通（驾照/靠左行/交通卡）、
 * other=其他（安全/习俗/健康等兜底）。
 */
export const TRIP_NOTE_CATEGORIES = [
  "communication",
  "climate",
  "power",
  "visa",
  "currency",
  "transport",
  "other",
] as const;
export type TripNoteCategory = (typeof TRIP_NOTE_CATEGORIES)[number];

/** 注意事项分类中文文案（单一定义点，三端共用） */
export const TRIP_NOTE_CATEGORY_LABELS: Record<TripNoteCategory, string> = {
  communication: "通讯",
  climate: "气候",
  power: "用电",
  visa: "签证",
  currency: "货币",
  transport: "交通",
  other: "其他",
};

export const CHAT_SESSION_STATUSES = [
  "starting",
  "idle",
  "running",
  "closed",
  "error",
] as const;
export type ChatSessionStatus = (typeof CHAT_SESSION_STATUSES)[number];

/**
 * 行程访问链接角色（v0.4 多人协作，issue #16）：
 * viewer=只读同伴（行程读端点：bundle/weather/budget/SSE）
 * editor=可编辑同伴（viewer 之上加全部行程编辑端点：places/entries/notes/legs/hotels/budget 写、
 * search、analyze/suggest 只读族）。
 * owner-only 端点（删行程/agents/settings/chat-sessions/access-links/owner-token）对 guest 一律 403。
 */
export const ACCESS_LINK_ROLES = ["viewer", "editor"] as const;
export type AccessLinkRole = (typeof ACCESS_LINK_ROLES)[number];

export const CHAT_MESSAGE_KINDS = [
  "user_text",
  "agent_text",
  "agent_thought",
  "tool_call",
  "tool_call_update",
  "plan",
  "permission_request",
  "permission_result",
  "advisory",
  "error",
  /** 上下文滚动标记：agent 侧会话压缩换新后落一条，content = { text: 交接摘要, throughSeq: 摘要覆盖到的 seq } */
  "context_summary",
] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

// ---------- 基础 schema ----------

export const LngLatSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});
export type LngLat = z.infer<typeof LngLatSchema>;

/**
 * 途经地节点（多城市/环线）：有序列表 = 用户意图的游览顺序，stops[0] = 主目的地。
 * 「城市」建模为节点而非行政区——青海湖/大柴旦这类非行政区住宿点也是 stop。
 * trips.destinationCity / cityCenter 保留为 stops[0] 的兼容镜像（同 selectedHotelCandidateId 镜像模式）。
 * 环线闭合不落库：由末段 transit 讫点 == stops[0] 推断。
 * center 为 null = 解析失败（网络/未找到），自愈时重解析。
 */
export const TripStopSchema = z.object({
  name: z.string(),
  adcode: z.string().nullable(),
  center: LngLatSchema.nullable(),
});
export type TripStop = z.infer<typeof TripStopSchema>;

/** 高德 POI 搜索结果里的候选 */
export const PoiCandidateSchema = z.object({
  poiId: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  location: LngLatSchema,
  cityName: z.string().nullable(),
  type: z.string().nullable(),
  tel: z.string().nullable(),
});
export type PoiCandidate = z.infer<typeof PoiCandidateSchema>;

// ---------- 币种与金额 ----------

export const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  AUD: "A$",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  NZD: "NZ$",
  SGD: "S$",
  HKD: "HK$",
  THB: "฿",
  KRW: "₩",
};

/** 行程常用币种（预算面板选择用） */
export const TRIP_CURRENCIES = Object.keys(CURRENCY_SYMBOLS);

export function formatMoney(amount: number | null | undefined, currency = "CNY"): string {
  if (amount == null) return "";
  return `${CURRENCY_SYMBOLS[currency] ?? currency} ${amount.toLocaleString("zh-CN")}`;
}

/** 预计游览/用餐时长展示：按半小时粒度四舍五入；不足 1 小时显示「约 X 分钟」，否则「约 X 小时」 */
export function formatVisitDuration(minutes: number | null | undefined): string {
  if (minutes == null || minutes <= 0) return "";
  const rounded = Math.max(30, Math.round(minutes / 30) * 30);
  if (rounded < 60) return `约 ${rounded} 分钟`;
  const hours = rounded / 60;
  return `约 ${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
}

// ---------- 实体 DTO（API 返回形状） ----------

export const TripDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  destinationCity: z.string(),
  cityAdcode: z.string().nullable(),
  geoProvider: z.enum(GEO_PROVIDERS),
  /** 目的地国家（建行程解析落库，中国归一为「中国」）；存量行程为 null。国内 + osm 引擎判定见 isDomesticOsmTrip */
  country: z.string().nullable(),
  location: LngLatSchema.nullable(),
  /** 有序途经地节点（多城市/环线）；单城市行程恒为 1 个元素，destinationCity/location 是 stops[0] 镜像 */
  stops: z.array(TripStopSchema),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  /** @deprecated 兼容镜像：checkInDay 最早的已选定酒店候选 id；多酒店请看 hotelCandidates[].selected/checkInDay/checkOutDay */
  selectedHotelCandidateId: z.string().nullable(),
  /** 总预算（币种为 currency） */
  budgetCny: z.number().nullable(),
  travelerCount: z.number(),
  currency: z.string(),
  shareToken: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TripDto = z.infer<typeof TripDtoSchema>;

export const PlaceDtoSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  name: z.string(),
  category: z.enum(PLACE_CATEGORIES),
  location: LngLatSchema,
  address: z.string().nullable(),
  /** 官网链接 */
  website: z.string().nullable(),
  /** 预订链接（可直接跳转下单/预约的 URL） */
  bookingUrl: z.string().nullable(),
  /** 联系电话 */
  phone: z.string().nullable(),
  /** 归属途经地/城市展示名（多城市分组依据）：建点时自动填充（显式传 > 最近 stop ≤150km > null），可改 */
  cityName: z.string().nullable(),
  amapPoiId: z.string().nullable(),
  sourceType: z.enum(SOURCE_TYPES),
  sourceUrl: z.string().nullable(),
  notes: z.string().nullable(),
  /** 停留时长（分钟）——排程口径：时间轴推算唯一依据（entry.durationMin 单条覆盖 > 本字段 > 默认 90 分钟）。M72 起 DTO 层从 visitDurationMin 兜底 */
  durationMin: z.number().nullable(),
  /** 预计游览/用餐分钟数——展示/参考口径（信息卡「约 X 小时」）。与 durationMin 在 DTO 层互相兜底；新写入统一用 durationMin */
  visitDurationMin: z.number().nullable(),
  /** 价格：餐厅=人均 / 景点=门票 / 酒店=每晚，币种为行程 currency */
  priceCny: z.number().nullable(),
  /** 预约方式（平台/电话/网站 + 提前天数建议） */
  bookingInfo: z.string().nullable(),
  /** 营业时间（v1 自由文本，如「09:00-17:00 周一闭馆」）；排天硬约束依据 */
  openingHours: z.string().nullable(),
  /** 预订状态流转，见 BOOKING_STATUSES */
  bookingStatus: z.enum(BOOKING_STATUSES),
  /** 候选（candidate）或已加入行程（joined），见 PLACE_STATUSES */
  status: z.enum(PLACE_STATUSES),
  /** 建点者（human | agent；guest 建点在 DB 层归为 human，归属昵称只记在 trip_activity） */
  createdBy: z.enum(["human", "agent"]),
  createdAt: z.string(),
});
export type PlaceDto = z.infer<typeof PlaceDtoSchema>;

export const EntryDtoSchema = z.object({
  id: z.string(),
  dayId: z.string(),
  tripId: z.string(),
  entryType: z.enum(ENTRY_TYPES),
  /** entryType=place 时非空；transit 可为 null（纯自由文本起讫点） */
  placeId: z.string().nullable(),
  position: z.number(),
  startTime: z.string().nullable(),
  note: z.string().nullable(),
  /** 单条停留时长覆盖（分钟）；null = 用 place.durationMin */
  durationMin: z.number().nullable(),
  // ---- transit entry 字段（entryType=transit 时有意义） ----
  /** 出发时间（HH:MM）；到达日排天容量约束依据 */
  departTime: z.string().nullable(),
  /** 到达时间（HH:MM） */
  arriveTime: z.string().nullable(),
  /** 起点：行程内地点（走真实坐标参与路线锚定） */
  fromPlaceId: z.string().nullable(),
  /** 讫点：行程内地点 */
  toPlaceId: z.string().nullable(),
  /** 起点自由文本（fromPlaceId 为空时展示用，如「家」「杭州东站」） */
  fromName: z.string().nullable(),
  /** 讫点自由文本 */
  toName: z.string().nullable(),
  /** 大交通方式（见 TRANSIT_MODES）；null=未指定（直线段）。drive=自驾：城际段走真实路由 */
  transitMode: z.enum(TRANSIT_MODES).nullable(),
  /**
   * 大交通费用（行程币种，**总价口径不按人数计**，如两人往返机票填两人总价）。
   * issue #14：transit entry 的票价/油费等大件支出，预算面板「交通」行汇总依据；
   * null=未填（不计入预算，计入 transitUnpricedCount 提醒）。
   */
  priceCny: z.number().int().min(0).nullable(),
});
export type EntryDto = z.infer<typeof EntryDtoSchema>;

/**
 * 公交分段详情（TransportLegDto.transitDetail 的元素）：
 * 真实公交路由返回的完整分段 —— walk=步行接驳段（起点→上车站 / 下车站→终点），
 * line=公交/地铁线路段（线路名、上下车站、途经站数、分段距离/时长）。
 * 填充来源：amap 公共交通族（transit/bus/metro/light_rail/train）真实公交路由，
 * 或 osm 侧 transitous（MOTIS 2）真实公交换乘命中；
 * osm 未命中（OSRM 估算）与降级场景整条 transitDetail 为 null，前端按「估算」口径展示。
 */
export const TRANSIT_SEGMENT_KINDS = ["walk", "line"] as const;
export type TransitSegmentKind = (typeof TRANSIT_SEGMENT_KINDS)[number];

export const TransitSegmentSchema = z.object({
  kind: z.enum(TRANSIT_SEGMENT_KINDS),
  /** 该分段里程（米） */
  distanceM: z.number().nullable(),
  /** 该分段时长（秒） */
  durationS: z.number().nullable(),
  /** 以下字段仅 kind=line 有意义（walk 段为 null） */
  /** 线路名（高德原文如「地铁2号线(内环)」，或 transitous 的 displayName/routeShortName 如「F2」「T8」「333」） */
  lineName: z.string().nullable(),
  /** 线路类型（高德原文如「地铁线路」，或 transitous 方式中文标签如「渡轮」「城际铁路」） */
  lineType: z.string().nullable(),
  /** 上车站名 */
  boardStop: z.string().nullable(),
  /** 下车站名 */
  alightStop: z.string().nullable(),
  /** 途经站数（上车后至下车间经过的站数） */
  viaStops: z.number().nullable(),
});
export type TransitSegment = z.infer<typeof TransitSegmentSchema>;

export const TransportLegDtoSchema = z.object({
  id: z.string(),
  dayId: z.string(),
  tripId: z.string(),
  /** entry 端点（二选一：entryId 或 placeId） */
  fromEntryId: z.string().nullable(),
  toEntryId: z.string().nullable(),
  /** place 端点（酒店往返段用） */
  fromPlaceId: z.string().nullable(),
  toPlaceId: z.string().nullable(),
  seq: z.number(),
  mode: z.enum(TRANSPORT_MODES),
  /** 手动覆盖的交通方式：非空时重算交通段保留该模式，不被自动规则（<2km 步行）冲掉 */
  modeOverride: z.enum(TRANSPORT_MODES).nullable(),
  distanceM: z.number().nullable(),
  durationS: z.number().nullable(),
  polyline: z.array(LngLatSchema).nullable(),
  /**
   * 公交分段详情（见 TransitSegmentSchema）：公共交通族（transit/bus/metro/light_rail/train）
   * 真实公交路由成功时非空（amap 真实公交路由，或 osm 侧 transitous 命中）；
   * osm 估算、路由降级、walk/drive/taxi/ferry 段及旧数据均为
   * null —— null 即「无详情，按估算口径展示」。
   */
  transitDetail: z.array(TransitSegmentSchema).nullable(),
  computedAt: z.string(),
});
export type TransportLegDto = z.infer<typeof TransportLegDtoSchema>;

export const HotelCandidateDtoSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  placeId: z.string(),
  pricePerNight: z.number().nullable(),
  notes: z.string().nullable(),
  /** 是否已选定；多酒店场景同一行程可选定多家，各覆盖一段天数 */
  selected: z.boolean(),
  /** 入住天序号（1-based，含）；仅 selected 时非空 */
  checkInDay: z.number().nullable(),
  /** 离店天序号（1-based，不含当晚）；闭开区间 [checkInDay, checkOutDay) 覆盖每晚住宿 */
  checkOutDay: z.number().nullable(),
});
export type HotelCandidateDto = z.infer<typeof HotelCandidateDtoSchema>;

export const DayDtoSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  dayIndex: z.number(),
  date: z.string().nullable(),
  /**
   * 每日概要（一句话：当日区域/主线 + 主景点）。持久化值为 agent（set_day_summary）或用户撰写；
   * 未撰写时服务端在 bundle 里自动生成兜底（summaryAuto=true，不落库，随行程变化实时重算）。
   */
  summary: z.string().nullable(),
  /** true = summary 为服务端自动兜底生成（非人工/agent 撰写），前端可据此区分展示 */
  summaryAuto: z.boolean(),
});
export type DayDto = z.infer<typeof DayDtoSchema>;

/** 行程级注意事项（trip_notes）：按分类预填的目的地出行提示（签证/货币/用电等，见 TRIP_NOTE_CATEGORIES） */
export const TripNoteDtoSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  category: z.enum(TRIP_NOTE_CATEGORIES),
  content: z.string(),
  /** 展示顺序（同类内按 position 再按创建时间） */
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TripNoteDto = z.infer<typeof TripNoteDtoSchema>;

/** 行程全量快照：前端一次拉齐 + SSE 增量 upsert */
export const TripBundleSchema = z.object({
  trip: TripDtoSchema,
  days: z.array(DayDtoSchema),
  places: z.array(PlaceDtoSchema),
  entries: z.array(EntryDtoSchema),
  legs: z.array(TransportLegDtoSchema),
  hotelCandidates: z.array(HotelCandidateDtoSchema),
  /** 行程级注意事项（按分类，见 TRIP_NOTE_CATEGORIES） */
  notes: z.array(TripNoteDtoSchema),
});
export type TripBundle = z.infer<typeof TripBundleSchema>;

// ---------- REST 请求体 ----------

/**
 * 日历日期（YYYY-MM-DD）：z.iso.date() 做真实日历校验（拒绝 2025-13-40、2026-02-29 这类不存在的日期，
 * 含闰年判定）——入库的 startDate/endDate 直接驱动 formatDayLabel 的星期展示，非法日期会静默进位串天。
 * REST（创建/更新行程）与 MCP（set_start_date）共用。
 */
export const CalendarDateSchema = z.iso.date();

export const CreateTripInputSchema = z.object({
  title: z.string().min(1).max(120),
  destinationCity: z.string().min(1).max(60),
  /**
   * 有序途经地节点名列表（多城市/环线，如 ["西宁","茶卡","大柴旦"]），逐个解析中心 + 同侧校验。
   * 缺省 = [destinationCity]（单城市，完全向后兼容）；提供时首元素即主目的地（镜像到 destinationCity）。
   */
  stops: z.array(z.string().min(1).max(60)).min(1).max(20).optional(),
  /** 显式指定地理 provider；缺省按目的地自动判定（国内→amap，未配 key 的国内→osm 零配置回退，海外→osm） */
  geoProvider: z.enum(GEO_PROVIDERS).optional(),
  startDate: CalendarDateSchema.nullable().optional(),
  endDate: CalendarDateSchema.nullable().optional(),
});
export type CreateTripInput = z.infer<typeof CreateTripInputSchema>;

/**
 * 更新行程（PATCH /api/trips/:tripId 与 MCP set_start_date / set_end_date）。
 * title 行程标题（约束与 CreateTripInputSchema.title 一致；M101 起收敛进通用更新端点，
 * 独立 PATCH /trips/:tripId/title 保留兼容）。
 * startDate 出发日期 / endDate 结束日期：YYYY-MM-DD；传 null 清除。
 * 两者同时非空且区间为正时，行程天数按日期区间计（天数口径、select_hotel 上界、聚类分天都依赖它）；
 * 只设一个时天数回退已建天兜底。清掉 startDate 天标签退化为「Day N」（见 formatDayLabel）。
 */
export const UpdateTripInputSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  startDate: CalendarDateSchema.nullable().optional(),
  endDate: CalendarDateSchema.nullable().optional(),
});
export type UpdateTripInput = z.infer<typeof UpdateTripInputSchema>;

/**
 * http(s) URL 白名单：agent 从不可信内容收集的链接会在前端以 <a href> 渲染，
 * z.string().url() 接受 javascript:/data: 等危险 scheme，必须收窄（防 stored XSS）。
 */
const HttpUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), { message: "仅支持 http/https 链接" });

export const CreatePlaceInputSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.enum(PLACE_CATEGORIES).default("other"),
  location: LngLatSchema,
  address: z.string().max(300).nullable().optional(),
  /** 官网链接 */
  website: HttpUrlSchema.nullable().optional(),
  /** 预订链接（可直接跳转下单/预约的 URL） */
  bookingUrl: HttpUrlSchema.nullable().optional(),
  /** 联系电话（含国家/区号更佳，如 +61 2 9250 7111） */
  phone: z.string().max(50).nullable().optional(),
  /** 归属途经地/城市名（多城市行程建议从 search_poi 返回的 cityName 带过来；缺省服务端按最近 stop ≤150km 自动填充） */
  cityName: z.string().max(120).nullable().optional(),
  amapPoiId: z.string().max(64).nullable().optional(),
  sourceType: z.enum(SOURCE_TYPES).default("manual"),
  sourceUrl: HttpUrlSchema.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  /** 停留时长（分钟）——排程口径：时间轴推算依据，景点务必填写（建议游玩时长） */
  durationMin: z.number().int().min(0).max(24 * 60).nullable().optional(),
  /** 预计游览/用餐分钟数——展示/参考口径（信息卡展示）；与 durationMin 在 DTO 层互相兜底，新写入统一用 durationMin */
  visitDurationMin: z.number().int().min(0).max(24 * 60).nullable().optional(),
  priceCny: z.number().min(0).nullable().optional(),
  bookingInfo: z.string().max(2000).nullable().optional(),
  /** 营业时间（v1 自由文本，如「09:00-17:00 周一闭馆」） */
  openingHours: z.string().max(200).nullable().optional(),
  /** 预订状态；agent 可填（如已核实可订），但以用户在界面上的标记为准 */
  bookingStatus: z.enum(BOOKING_STATUSES).optional(),
  /** 显式指定初始状态；缺省由服务端按创建者决定（human→joined，agent→candidate） */
  status: z.enum(PLACE_STATUSES).optional(),
  /** 跳过模糊判重强制新建（默认 false：规范化名称相同/互为前缀 + 坐标 ≤200m 时返回 409 疑似重复信号，不创建新行） */
  allowDuplicate: z.boolean().optional(),
});
export type CreatePlaceInput = z.infer<typeof CreatePlaceInputSchema>;

export const UpdatePlaceInputSchema = CreatePlaceInputSchema.partial();
export type UpdatePlaceInput = z.infer<typeof UpdatePlaceInputSchema>;

/** 加入/移出行程（PATCH /api/places/:id/status 与 MCP add_to_trip/remove_from_trip） */
export const SetPlaceStatusInputSchema = z.object({
  status: z.enum(PLACE_STATUSES),
});
export type SetPlaceStatusInput = z.infer<typeof SetPlaceStatusInputSchema>;

/** 移出行程（POST /api/places/:id/unschedule，M20）响应：撤销该地点的全部日程 entry，地点退回候选态 */
export const UnschedulePlaceResultSchema = z.object({
  ok: z.literal(true),
  removedEntries: z.number().int().min(0),
});
export type UnschedulePlaceResult = z.infer<typeof UnschedulePlaceResultSchema>;

/** 疑似重复信号的 error.code 值（REST 409 与 MCP add_place 结构化错误共用） */
export const POSSIBLE_DUPLICATE_CODE = "possible_duplicate" as const;

/**
 * POST /places 疑似重复（409）响应体：模糊判重（规范化名称相同/互为前缀 + 坐标 ≤200m）
 * 命中已有 place 时不创建新行、不回填，把已有 place 带回给前端弹确认框；
 * 用户确认是不同地点后带 allowDuplicate=true 重试强制创建。
 * amapPoiId 精确匹配不走此信号（保持幂等返回已有 place）。
 */
export const PossibleDuplicatePayloadSchema = z.object({
  error: z.string(),
  code: z.literal(POSSIBLE_DUPLICATE_CODE),
  existingPlace: PlaceDtoSchema,
});
export type PossibleDuplicatePayload = z.infer<typeof PossibleDuplicatePayloadSchema>;

/** HH:MM（24 小时制） */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 排入某天（POST /api/trips/:tripId/entries）。
 * entryType=place（默认）：placeId 必填。
 * entryType=transit（大交通：航班/高铁/城际移动）：placeId 不用传；
 * 起讫点各给 fromPlaceId（行程内地点，走真实坐标）或 fromName（自由文本）之一，讫点同理。
 */
export const AddEntryInputSchema = z
  .object({
    entryType: z.enum(ENTRY_TYPES).default("place"),
    placeId: z.string().nullable().optional(),
    dayIndex: z.number().int().min(1),
    position: z.number().int().min(0).nullable().optional(),
    /** 可选开始时间（HH:MM，24 小时制）；transit 缺省取 departTime */
    startTime: z.string().regex(HHMM).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    // ---- transit 字段 ----
    departTime: z.string().regex(HHMM).nullable().optional(),
    arriveTime: z.string().regex(HHMM).nullable().optional(),
    fromPlaceId: z.string().nullable().optional(),
    toPlaceId: z.string().nullable().optional(),
    fromName: z.string().min(1).max(120).nullable().optional(),
    toName: z.string().min(1).max(120).nullable().optional(),
    /** 大交通方式（仅 transit 有意义）；drive=自驾城际段走真实路由 */
    transitMode: z.enum(TRANSIT_MODES).nullable().optional(),
    /** 大交通费用（仅 transit 有意义；总价口径不按人数计，传 null 清除） */
    priceCny: z.number().int().min(0).nullable().optional(),
  })
  .refine((v) => v.entryType !== "place" || !!v.placeId, {
    message: "entryType=place 时必须提供 placeId",
  })
  .refine((v) => v.entryType !== "transit" || !!(v.fromPlaceId || v.fromName), {
    message: "transit entry 需要 fromPlaceId 或 fromName（起点）",
  })
  .refine((v) => v.entryType !== "transit" || !!(v.toPlaceId || v.toName), {
    message: "transit entry 需要 toPlaceId 或 toName（讫点）",
  });
export type AddEntryInput = z.infer<typeof AddEntryInputSchema>;

/**
 * 编辑 entry（PATCH /api/entries/:id）。
 * startTime/durationMin/note 对两类 entry 通用；transit 时间字段仅 entryType=transit 可改。
 * fromPlaceId/toPlaceId 传 null = 清除地点引用（退回纯文本）；fromName/toName 传 null = 清除文本。
 */
export const UpdateEntryInputSchema = z.object({
  startTime: z.string().regex(HHMM).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  /** 单条停留时长覆盖（分钟）；null = 恢复用 place.durationMin */
  durationMin: z.number().int().min(0).max(24 * 60).nullable().optional(),
  departTime: z.string().regex(HHMM).nullable().optional(),
  arriveTime: z.string().regex(HHMM).nullable().optional(),
  fromPlaceId: z.string().nullable().optional(),
  toPlaceId: z.string().nullable().optional(),
  fromName: z.string().min(1).max(120).nullable().optional(),
  toName: z.string().min(1).max(120).nullable().optional(),
  /** 大交通方式（仅 transit entry 可改）；null=清除恢复直线段 */
  transitMode: z.enum(TRANSIT_MODES).nullable().optional(),
  /** 大交通费用（仅 transit entry 可改；总价口径不按人数计，传 null 清除） */
  priceCny: z.number().int().min(0).nullable().optional(),
});
export type UpdateEntryInput = z.infer<typeof UpdateEntryInputSchema>;

/** 手动覆盖交通段方式（PATCH /api/legs/:id/mode）；mode=null 清除覆盖恢复自动计算 */
export const SetLegModeInputSchema = z.object({
  mode: z.enum(TRANSPORT_MODES).nullable(),
});
export type SetLegModeInput = z.infer<typeof SetLegModeInputSchema>;

export const ReorderDayInputSchema = z.object({
  entryIds: z.array(z.string()).min(1),
});
export type ReorderDayInput = z.infer<typeof ReorderDayInputSchema>;

// ---------- 每日概要（PATCH /api/days/:dayId/summary 与 MCP set_day_summary） ----------

/** 撰写/更新每日概要；传 null = 清除撰写值，恢复服务端自动兜底（summaryAuto） */
export const UpdateDaySummaryInputSchema = z.object({
  summary: z.string().trim().min(1).max(500).nullable(),
});
export type UpdateDaySummaryInput = z.infer<typeof UpdateDaySummaryInputSchema>;

// ---------- 行程级注意事项（REST CRUD 与 MCP add/update/remove_trip_note） ----------

export const CreateTripNoteInputSchema = z.object({
  category: z.enum(TRIP_NOTE_CATEGORIES),
  content: z.string().trim().min(1).max(2000),
  /** 展示顺序；缺省排到末尾 */
  position: z.number().int().min(0).optional(),
});
export type CreateTripNoteInput = z.infer<typeof CreateTripNoteInputSchema>;

export const UpdateTripNoteInputSchema = z.object({
  category: z.enum(TRIP_NOTE_CATEGORIES).optional(),
  content: z.string().trim().min(1).max(2000).optional(),
  position: z.number().int().min(0).optional(),
});
export type UpdateTripNoteInput = z.infer<typeof UpdateTripNoteInputSchema>;

// ---------- 天气（GET /api/trips/:tripId/weather 与 MCP get_weather） ----------

/** 单日天气预报（Open-Meteo daily）：温度区间（°C）、降水（mm）、最大风速（km/h）、WMO 天气码与中文标签 */
export const WeatherForecastSchema = z.object({
  tempMinC: z.number(),
  tempMaxC: z.number(),
  precipitationMm: z.number(),
  windMaxKmh: z.number(),
  /** WMO Weather interpretation code（Open-Meteo weather_code 原值） */
  weatherCode: z.number(),
  /** 中文标签（如「晴」「多云」「小雨」），由 weatherCode 映射 */
  weatherLabel: z.string(),
});
export type WeatherForecast = z.infer<typeof WeatherForecastSchema>;

/** 某行程日的天气：available=false 时 reason 说明原因（超出 16 天预报期 / 日期已过 / 上游无数据） */
export const DayWeatherSchema = z.object({
  date: CalendarDateSchema,
  /** 对应行程第几天（1-based）；日期不在已建天范围内时为 null */
  dayIndex: z.number().nullable(),
  /** 预报坐标取自哪个途经地/当日活动重心（展示用） */
  anchorName: z.string().nullable(),
  available: z.boolean(),
  reason: z.string().optional(),
  forecast: WeatherForecastSchema.nullable(),
});
export type DayWeather = z.infer<typeof DayWeatherSchema>;

/** 行程天气预报（GET /api/trips/:tripId/weather 响应）：按天一条，仅未来约 16 天可信 */
export const TripWeatherSchema = z.object({
  generatedAt: z.string(),
  days: z.array(DayWeatherSchema),
  /** 行程未设置出发日期等场景的整体说明 */
  note: z.string().optional(),
});
export type TripWeather = z.infer<typeof TripWeatherSchema>;

// ---------- 区域聚类（suggest_day_clusters / GET /api/trips/:tripId/suggest-clusters） ----------

/** 一个地理聚类：未排期地点按位置聚成的一片区域 + 建议排入的天 */
export const DayClusterSchema = z.object({
  clusterIndex: z.number(),
  /** 归属途经地/城市（M72：同城才同簇，多城市行程不跨城错配）；null = 未能归属（离所有途经地 >150km） */
  cityName: z.string().nullable(),
  places: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      category: z.enum(PLACE_CATEGORIES),
      location: LngLatSchema,
    }),
  ),
  /** 簇质心（成员坐标均值） */
  centroid: LngLatSchema,
  /** 建议排入的天（1-based，同城天优先、再按负载最轻）；行程无天信息或簇多于天数时为 null */
  suggestedDayIndex: z.number().nullable(),
});
export type DayCluster = z.infer<typeof DayClusterSchema>;

/** 区域聚类建议（只建议不落库）：未排期非酒店地点先按途经地分组（同城才同簇），组内按地理聚成 1-4 片（簇数按点数自适应），建议每天一片 */
export const SuggestDayClustersResultSchema = z.object({
  clusters: z.array(DayClusterSchema),
  /** 参与聚类的未排期地点数（不含酒店、不含已排入某天行程的） */
  unscheduledCount: z.number(),
  dayCount: z.number(),
  note: z.string().optional(),
});
export type SuggestDayClustersResult = z.infer<typeof SuggestDayClustersResultSchema>;

// ---------- 住宿区域推荐（recommend_hotel_area / GET /api/trips/:tripId/hotel-area） ----------

/** 推荐依据的一个信号点（权重高的对圆心拉力大） */
export const HotelAreaSignalPointSchema = z.object({
  /**
   * 信号来源：
   * day-anchor = 某天的首个/最后一个活动点（每天动线的起讫，住宿离它们近最省往返）；
   * transit = 大交通节点（航班/车站等到发点，首末天到达离开锚点）；
   * activity = 天内普通活动点；candidate = 候选池中未排期的非酒店地点。
   */
  kind: z.enum(["day-anchor", "transit", "activity", "candidate"]),
  name: z.string(),
  location: LngLatSchema,
  weight: z.number(),
  /** 关联天序号（1-based）；候选点等不属任何天为 null */
  dayIndex: z.number().nullable(),
});
export type HotelAreaSignalPoint = z.infer<typeof HotelAreaSignalPointSchema>;

/** 分天段（多酒店区间）的区域建议：一段连续未被已选定酒店覆盖的天 → 一个建议居住片区 */
export const HotelAreaSegmentSchema = z.object({
  /** 覆盖天范围，闭开区间 [fromDay, toDay)，口径与 select_hotel 的 checkInDay/checkOutDay 一致 */
  fromDay: z.number(),
  toDay: z.number(),
  /** 该段主导城市/途经地名（无法判断为 null） */
  cityName: z.string().nullable(),
  center: LngLatSchema,
  radiusM: z.number(),
  /** 参与该段推荐的信号点（已按段过滤，多城市行程不跨城混算） */
  points: z.array(HotelAreaSignalPointSchema),
});
export type HotelAreaSegment = z.infer<typeof HotelAreaSegmentSchema>;

/**
 * 住宿区域推荐结果（只建议不落库）。
 * 多信号加权：每日首/末活动点（weight 2）> 大交通到发节点（weight 1.5）
 * > 天内普通活动点（weight 1）> 候选池未排期点（weight 0.5）。
 * 顶层 center/radiusM 为全域加权结果（兼容旧契约，前端画圈直用）；
 * segments 为分天段建议（多酒店行程按未被覆盖的连续天段各给一片区域）。
 */
export const HotelAreaRecommendationSchema = z.object({
  center: LngLatSchema,
  radiusM: z.number(),
  segments: z.array(HotelAreaSegmentSchema),
  /** 信号统计（各类信号点数量，便于 agent 解释推荐依据） */
  signals: z.object({
    dayAnchor: z.number(),
    transit: z.number(),
    activity: z.number(),
    candidate: z.number(),
  }),
  note: z.string().optional(),
});
export type HotelAreaRecommendation = z.infer<typeof HotelAreaRecommendationSchema>;

export const CreateHotelCandidateInputSchema = CreatePlaceInputSchema.extend({
  pricePerNight: z.number().min(0).nullable().optional(),
});
export type CreateHotelCandidateInput = z.infer<
  typeof CreateHotelCandidateInputSchema
>;

/**
 * 回填酒店候选信息（PATCH /api/hotel-candidates/:id 与 MCP update_hotel_candidate，issue #13）。
 * 订完酒店拿到真实房价往往晚于建候选：这里支持改 pricePerNight（预算面板住宿项计价依据）
 * 与 notes；传 null 清除。selected/checkInDay/checkOutDay 的流转走 select/unselect，不放这里。
 */
export const UpdateHotelCandidateInputSchema = z.object({
  pricePerNight: z.number().min(0).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type UpdateHotelCandidateInput = z.infer<typeof UpdateHotelCandidateInputSchema>;

/**
 * 选定酒店（POST /api/trips/:tripId/select-hotel 与 MCP select_hotel）。
 * 天序号为 1-based 闭开区间 [checkInDay, checkOutDay)：覆盖第 checkInDay..checkOutDay-1 晚。
 * checkInDay/checkOutDay 必须同给或同缺（同缺时服务端智能建议覆盖尚未被覆盖的最长连续天段）；
 * 同一行程已选定酒店的天数区间不得重叠。candidateId=null 表示取消全部选定（兼容旧契约）。
 */
export const SelectHotelInputSchema = z
  .object({
    candidateId: z.string().nullable(),
    checkInDay: z.number().int().min(1).optional(),
    checkOutDay: z.number().int().min(2).optional(),
  })
  .refine((v) => (v.checkInDay == null) === (v.checkOutDay == null), {
    message: "checkInDay 与 checkOutDay 必须同时提供或同时省略",
  })
  .refine(
    (v) =>
      v.checkInDay == null ||
      v.checkOutDay == null ||
      v.checkInDay < v.checkOutDay,
    { message: "checkInDay 必须小于 checkOutDay" },
  );
export type SelectHotelInput = z.infer<typeof SelectHotelInputSchema>;

/** 取消单个酒店的选定（POST /api/trips/:tripId/unselect-hotel） */
export const UnselectHotelInputSchema = z.object({
  candidateId: z.string(),
});
export type UnselectHotelInput = z.infer<typeof UnselectHotelInputSchema>;

// ---------- 设置与 Agent 注册 ----------

/**
 * 全局设置（GET /api/settings 返回生效值：DB 覆盖优先，env 兜底）。
 * amapServerKey 永不出明文：已配置时返回固定掩码 "********"（配置态看非空 + overridden），
 * 未配置为空串；amapJsKey / amapJsSecret 因高德 JSAPI 必须在浏览器端初始化，明文返回属设计使然。
 */
export const SettingsDtoSchema = z.object({
  amapJsKey: z.string(),
  amapServerKey: z.string(),
  amapJsSecret: z.string(),
  /** 三个 key 是否齐备（DB 覆盖 + env 合并后判定） */
  amapConfigured: z.boolean(),
  /** 各字段当前值是否来自 DB 覆盖（false = env 兜底或未配置） */
  overridden: z.object({
    amapJsKey: z.boolean(),
    amapServerKey: z.boolean(),
    amapJsSecret: z.boolean(),
  }),
});
export type SettingsDto = z.infer<typeof SettingsDtoSchema>;

/** PUT /api/settings：写字段 = DB 覆盖 env；传 null = 清除覆盖回退 env */
export const UpdateSettingsInputSchema = z.object({
  amapJsKey: z.string().max(128).nullable().optional(),
  amapServerKey: z.string().max(128).nullable().optional(),
  amapJsSecret: z.string().max(128).nullable().optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInputSchema>;

/** Agent 注册项（GET /api/agents；ACP 子进程启动命令） */
export const AgentRegistryDtoSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type AgentRegistryDto = z.infer<typeof AgentRegistryDtoSchema>;

export const CreateAgentInputSchema = z.object({
  label: z.string().min(1).max(60),
  /** 可执行命令（如 "kimi"）；可用性用 GET /api/agents/detect 检测 */
  command: z.string().min(1).max(200),
  args: z.array(z.string().max(200)).max(20).default([]),
  enabled: z.boolean().default(true),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

export const UpdateAgentInputSchema = CreateAgentInputSchema.partial();
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;

/** GET /api/agents/detect 返回项：注册项 + 本机 which 检测结果 */
export const AgentAvailabilitySchema = AgentRegistryDtoSchema.extend({
  available: z.boolean(),
});
export type AgentAvailability = z.infer<typeof AgentAvailabilitySchema>;

// ---------- 访问链接与 owner token（issue #16：多人协作地基） ----------

/**
 * 行程访问链接（GET /api/trips/:tripId/access-links，owner-only）。
 * 含 token 明文：该端点仅 owner 可达，owner 需要随时重新复制完整链接发给同伴
 * （token 在 DB 也是明文存储，见 schema 注释；hash 方案会把「找回」变成「吊销重建」）。
 */
export const TripAccessLinkDtoSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  /** 访问令牌（Bearer 或 SSE ?token=）；同伴入口 URL 的组成部分 */
  token: z.string(),
  role: z.enum(ACCESS_LINK_ROLES),
  /** owner 给链接的备注名（如「给小红的」）；null = 未填 */
  label: z.string().nullable(),
  /** 同伴打开链接时填的昵称（#18 同伴入口写入）；null = 尚未填写 */
  displayName: z.string().nullable(),
  /** 吊销时间；非空 = 已失效（吊销即终态） */
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  /** 同伴最近一次鉴权成功时间（写入有 60s 节流）；null = 从未使用 */
  lastSeenAt: z.string().nullable(),
});
export type TripAccessLinkDto = z.infer<typeof TripAccessLinkDtoSchema>;

/** 创建访问链接（POST /api/trips/:tripId/access-links，owner-only） */
export const CreateAccessLinkInputSchema = z.object({
  role: z.enum(ACCESS_LINK_ROLES),
  /** 备注名缺省为「只读分享」/「可编辑链接」按角色给默认 */
  label: z.string().trim().min(1).max(60).nullable().optional(),
});
export type CreateAccessLinkInput = z.infer<typeof CreateAccessLinkInputSchema>;

/** 更新访问链接（PATCH /api/access-links/:linkId，owner-only）：目前仅改备注名 */
export const UpdateAccessLinkInputSchema = z.object({
  label: z.string().trim().min(1).max(60).nullable().optional(),
});
export type UpdateAccessLinkInput = z.infer<typeof UpdateAccessLinkInputSchema>;

/** owner token 状态（GET /api/owner-token，owner-only）：明文永不回显，只报配置态 */
export const OwnerTokenStatusSchema = z.object({
  /** true = 已设置（存在有效 owner token） */
  configured: z.boolean(),
});
export type OwnerTokenStatus = z.infer<typeof OwnerTokenStatusSchema>;

/**
 * 生成/重置 owner token（POST /api/owner-token/reset，owner-only）。
 * token 明文仅此一次返回（DB 只存 sha256 hash）；重置后旧 token 立即失效。
 */
export const OwnerTokenResetResultSchema = z.object({
  token: z.string(),
});
export type OwnerTokenResetResult = z.infer<typeof OwnerTokenResetResultSchema>;

// ---------- 同伴入口（issue #18：/join/:token 打开 → 填昵称 → 进入行程） ----------

/**
 * join 端点的可区分错误码（HTTP 状态 + code 双保险，前端据此出不同文案）：
 *   not_found —— token 不存在（链接打错/从未存在）→ 404
 *   revoked   —— 链接已被行程主人吊销（终态）→ 410
 */
export const JOIN_LINK_ERROR_CODES = ["join_link_not_found", "join_link_revoked"] as const;
export type JoinLinkErrorCode = (typeof JOIN_LINK_ERROR_CODES)[number];

/**
 * 链接信息（GET /api/join/:token/info，公开端点：token 在 URL 即凭证）。
 * 刻意只给标题/角色/已填昵称——不泄 bundle、不泄 owner 信息、不泄真实 tripId
 * （tripId 在 activate 成功后才返回，用于前端重定向）。
 */
export const JoinInfoSchema = z.object({
  /** 行程标题（同伴确认「这是不是那个行程」的唯一线索） */
  tripTitle: z.string(),
  /** 链接角色：editor=可编辑同伴 / viewer=只读同伴 */
  role: z.enum(ACCESS_LINK_ROLES),
  /** 该链接已填过的昵称（null = 从未激活）；同伴改昵称重进时的预填值 */
  displayName: z.string().nullable(),
});
export type JoinInfo = z.infer<typeof JoinInfoSchema>;

/** 激活链接（POST /api/join/:token/activate）：昵称即可，无密码 */
export const JoinActivateInputSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "昵称不能为空")
    .max(30, "昵称最长 30 个字符"),
});
export type JoinActivateInput = z.infer<typeof JoinActivateInputSchema>;

/**
 * 激活结果（POST /api/join/:token/activate）。
 * token 不回传（同伴手里已经有——就在 URL 里）；tripId 此时才下发，用于前端按角色重定向：
 * editor → /trip/:tripId（guest 模式），viewer → /share/:token（只读页）。
 */
export const JoinActivateResultSchema = z.object({
  tripId: z.string(),
  role: z.enum(ACCESS_LINK_ROLES),
  displayName: z.string(),
});
export type JoinActivateResult = z.infer<typeof JoinActivateResultSchema>;

// ---------- 动态流与在线名单（issue #19） ----------

/**
 * 动作枚举（trip_activity.action）：狭义「谁改了什么」只记结构性变更，
 * 不记字段级编辑（update 系列统一 place_updated/entry_updated 等，防止动态流被高频微调刷屏）。
 */
export const TRIP_ACTIVITY_ACTIONS = [
  // 地点
  "place_added",
  "place_removed",
  "place_joined",
  "place_unjoined",
  // 日程
  "entry_added",
  "entry_removed",
  "day_reordered",
  // 大交通
  "transit_added",
  // 酒店
  "hotel_selected",
  "hotel_unselected",
  // 须知/概要/行程字段
  "note_added",
  "note_removed",
  "day_summary_updated",
  "trip_updated",
  "budget_updated",
] as const;
export type TripActivityAction = (typeof TRIP_ACTIVITY_ACTIONS)[number];

/** 动作中文文案（单一定义点，三端共用；summary 完整句子在服务端生成） */
export const TRIP_ACTIVITY_ACTION_LABELS: Record<TripActivityAction, string> = {
  place_added: "添加了地点",
  place_removed: "删除了地点",
  place_joined: "加入了行程",
  place_unjoined: "移出了行程",
  entry_added: "排了日程",
  entry_removed: "移除了日程",
  day_reordered: "重排了日程顺序",
  transit_added: "添加了大交通",
  hotel_selected: "选定了酒店",
  hotel_unselected: "取消了酒店",
  note_added: "添加了注意事项",
  note_removed: "删除了注意事项",
  day_summary_updated: "撰写了每日概要",
  trip_updated: "更新了行程信息",
  budget_updated: "更新了预算",
};

/** 动态流条目（trip_activity 行的 DTO 形态；REST 拉取与 SSE activity 事件共用） */
export const TripActivityDtoSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  actorKind: z.enum(ACTOR_KINDS),
  /** 展示标签：guest 昵称 / "agent" / "主人"（三端文案一致，服务端生成） */
  actorLabel: z.string(),
  action: z.enum(TRIP_ACTIVITY_ACTIONS),
  /** 服务端生成的完整句子（如「小红 添加了地点 悉尼歌剧院」），前端直接展示 */
  summary: z.string(),
  createdAt: z.string(),
});
export type TripActivityDto = z.infer<typeof TripActivityDtoSchema>;

/**
 * 在线名单条目（presence）：一个正在订阅本行程 SSE 的会话。
 * key 用连接序号 + 身份标签（同一人开两个标签页算两条连接，名单聚合展示时按 label 去重）。
 */
export const PresenceEntrySchema = z.object({
  /** 名单展示标签："主人" / guest 昵称（脱敏端点下同 GET /share 的角色口径） */
  label: z.string(),
  /** 身份类别（前端区分头像/排序用） */
  kind: z.enum(ACTOR_KINDS),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

/** presence 事件（行程频道）：join/leave 携带事件后的全量名单，前端整包替换 */
export const PresenceEventSchema = z.object({
  kind: z.enum(["join", "leave"]),
  entry: PresenceEntrySchema,
  /** 当前全部在线连接（含本次事件的结果），前端直接整体替换名单 */
  viewers: z.array(PresenceEntrySchema),
});
export type PresenceEvent = z.infer<typeof PresenceEventSchema>;

// ---------- SSE 事件 ----------

export const TripEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bundle"), bundle: TripBundleSchema }),
  z.object({ type: z.literal("deleted"), tripId: z.string() }),
  // 动态流（issue #19）：tripService 写操作完成后随行程频道广播（summary 文案服务端生成，三端一致）
  z.object({ type: z.literal("activity"), activity: TripActivityDtoSchema }),
  // 在线名单（issue #19）：SSE 连接建立/断开时广播（kind=join/leave，viewers 为当前全量名单）
  z.object({ type: z.literal("presence"), presence: PresenceEventSchema }),
]);
export type TripEvent = z.infer<typeof TripEventSchema>;

export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    message: z.unknown(), // ChatMessageDto，宽松校验，见 chat.ts
  }),
  z.object({
    type: z.literal("session"),
    session: z.unknown(), // ChatSessionDto 快照
  }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

// ---------- Chat DTO ----------

export const ChatSessionDtoSchema = z.object({
  id: z.string(),
  tripId: z.string(),
  agentRegistryId: z.string(),
  agentLabel: z.string(),
  status: z.enum(CHAT_SESSION_STATUSES),
  allowAllPermissions: z.boolean(),
  lastError: z.string().nullable(),
  uiContext: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatSessionDto = z.infer<typeof ChatSessionDtoSchema>;

/**
 * content 按 kind 不同：
 * - user_text / agent_text / agent_thought / advisory / error: { text }
 * - tool_call: { toolCallId, title, kind, status, rawInput, rawOutput, content? }
 * - tool_call_update: { toolCallId, status, ...patch }
 * - plan: { entries: [{ content, status }] }
 * - permission_request: { sessionId, requestId, toolCall, options }
 * - permission_result: { requestId, outcome }
 * - context_summary: { text: 交接摘要, throughSeq: 摘要覆盖到的最大 seq }
 */
export const ChatMessageDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number(),
  turnId: z.string().nullable(),
  kind: z.enum(CHAT_MESSAGE_KINDS),
  content: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type ChatMessageDto = z.infer<typeof ChatMessageDtoSchema>;

/**
 * 消息分页（keyset）：GET /chat-sessions/:id/messages?beforeSeq=&limit=
 * - 缺省取最新一页（limit 默认 200，上限 500）
 * - beforeSeq：取 seq 严格小于它的更早一页
 */
export const ChatMessagesQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type ChatMessagesQuery = z.infer<typeof ChatMessagesQuerySchema>;

export const ChatMessagesPageSchema = z.object({
  messages: z.array(ChatMessageDtoSchema),
  /** 服务器端是否还有比本页更早的消息（驱动「加载更早」翻页） */
  hasMore: z.boolean(),
});
export type ChatMessagesPage = z.infer<typeof ChatMessagesPageSchema>;

/** 预算汇总（服务端按地点价格计算） */
export const BudgetSummarySchema = z.object({
  currency: z.string(),
  budgetCny: z.number().nullable(),
  travelerCount: z.number(),
  /** 晚数：有已选定酒店时 = 覆盖晚数合计（与 hotelCny 计费口径一致）；无覆盖时 = 行程天数-1（N 天行程 N-1 晚，末日离店不住） */
  nights: z.number(),
  hotelSelected: z.boolean(),
  hotelCny: z.number().nullable(),
  diningCny: z.number(),
  ticketsCny: z.number(),
  /** 大交通费用合计（transit entry 的 priceCny 总价口径求和，不按人数计，issue #14） */
  transitCny: z.number(),
  totalCny: z.number(),
  remainingCny: z.number().nullable(),
  /** 还没填价格的餐厅/景点数（预算低估提醒） */
  unpricedCount: z.number(),
  /** 还没填价格的大交通段数（transit entry priceCny 为空的条数，预算低估提醒，issue #14） */
  transitUnpricedCount: z.number(),
});
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;

/**
 * 分享只读负载（GET /api/share/:token）：
 * bundle.trip.id 与 shareToken 已由服务端置空，其余实体 id（place/entry/leg/day/
 * hotelCandidate 及 tripId/placeId/dayId 等引用字段）全部替换为不透明别名
 * （sha256(token:id) 截断，同一真实 id 全包一致映射）——分享链接是公开凭证，
 * 不能把可写标识发给访客（实体级写端点无鉴权，真实 id 泄露即可越权写）；
 * 前端仅把 id 当 React key/选中态/关联键使用。预算汇总随包下发，无需再按 tripId 拉取。
 */
export const SharePayloadSchema = z.object({
  bundle: TripBundleSchema,
  budget: BudgetSummarySchema,
});
export type SharePayload = z.infer<typeof SharePayloadSchema>;

// ---------- 工具函数 ----------

export function formatDuration(durationS: number | null | undefined): string {
  if (durationS == null) return "";
  const minutes = Math.round(durationS / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

export function formatDistance(distanceM: number | null | undefined): string {
  if (distanceM == null) return "";
  if (distanceM < 1000) return `${Math.round(distanceM)} 米`;
  return `${(distanceM / 1000).toFixed(1)} 公里`;
}

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"] as const;

/**
 * 天标签：由 trip.startDate + dayIndex（1-based）推导日期与星期，如「D1 · 9/23 周三」；
 * startDate 缺失或非法时退化为「Day 1」。日期按本地时区逐日相加（直接构造 Date(y, m, d+n)
 * 由引擎处理跨月/跨年进位），避免 UTC 解析串天。
 */
export function formatDayLabel(
  startDate: string | null | undefined,
  dayIndex: number,
): string {
  const m = startDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate) : null;
  if (!m) return `Day ${dayIndex}`;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dayIndex - 1);
  return `D${dayIndex} · ${date.getMonth() + 1}/${date.getDate()} 周${WEEKDAY_NAMES[date.getDay()]}`;
}
