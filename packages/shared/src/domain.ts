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

export const TRANSPORT_MODES = ["walk", "taxi", "transit", "drive"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/**
 * 大交通方式（transit entry 的移动方式）：flight=航班 / train=火车高铁 / drive=自驾 / bus=大巴。
 * null = 未指定（保持直线段行为）。transitMode=drive 的城际段走真实路由拿公路 polyline/里程，
 * 是自驾环线体验的关键；枚举刻意收窄（不加 other/ship），引导更准。
 */
export const TRANSIT_MODES = ["flight", "train", "drive", "bus"] as const;
export type TransitMode = (typeof TRANSIT_MODES)[number];

/** 变更由谁触发（人类直接编辑 or agent 经 MCP） */
export const ACTORS = ["human", "agent"] as const;
export type Actor = (typeof ACTORS)[number];

/**
 * 地点状态机：candidate（候选池，agent 解析攻略/推荐的默认值）
 * → locked（用户在界面上锁定 = 确认要去）。
 * 纪律：agent 只建候选；locked 的地点 agent 不可改/删（需用户在界面解锁）；
 * 只有 locked 的地点才应排入某天行程。
 */
export const PLACE_STATUSES = ["candidate", "locked"] as const;
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

/** 地理服务 provider：amap（国内，需 key）| osm（海外，零 key） */
export const GEO_PROVIDERS = ["amap", "osm"] as const;
export type GeoProviderName = (typeof GEO_PROVIDERS)[number];

export const CHAT_SESSION_STATUSES = [
  "starting",
  "idle",
  "running",
  "closed",
  "error",
] as const;
export type ChatSessionStatus = (typeof CHAT_SESSION_STATUSES)[number];

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
  durationMin: z.number().nullable(),
  /** 预计游览/用餐分钟数（景点/美食的参观时长预估，规划每日行程的参考输入；展示为「约 X 小时」） */
  visitDurationMin: z.number().nullable(),
  /** 价格：餐厅=人均 / 景点=门票 / 酒店=每晚，币种为行程 currency */
  priceCny: z.number().nullable(),
  /** 预约方式（平台/电话/网站 + 提前天数建议） */
  bookingInfo: z.string().nullable(),
  /** 营业时间（v1 自由文本，如「09:00-17:00 周一闭馆」）；排天硬约束依据 */
  openingHours: z.string().nullable(),
  /** 预订状态流转，见 BOOKING_STATUSES */
  bookingStatus: z.enum(BOOKING_STATUSES),
  /** 候选（candidate）或已锁定（locked），见 PLACE_STATUSES */
  status: z.enum(PLACE_STATUSES),
  createdBy: z.enum(ACTORS),
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
});
export type EntryDto = z.infer<typeof EntryDtoSchema>;

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
});
export type DayDto = z.infer<typeof DayDtoSchema>;

/** 行程全量快照：前端一次拉齐 + SSE 增量 upsert */
export const TripBundleSchema = z.object({
  trip: TripDtoSchema,
  days: z.array(DayDtoSchema),
  places: z.array(PlaceDtoSchema),
  entries: z.array(EntryDtoSchema),
  legs: z.array(TransportLegDtoSchema),
  hotelCandidates: z.array(HotelCandidateDtoSchema),
});
export type TripBundle = z.infer<typeof TripBundleSchema>;

// ---------- REST 请求体 ----------

export const CreateTripInputSchema = z.object({
  title: z.string().min(1).max(120),
  destinationCity: z.string().min(1).max(60),
  /**
   * 有序途经地节点名列表（多城市/环线，如 ["西宁","茶卡","大柴旦"]），逐个解析中心 + 同侧校验。
   * 缺省 = [destinationCity]（单城市，完全向后兼容）；提供时首元素即主目的地（镜像到 destinationCity）。
   */
  stops: z.array(z.string().min(1).max(60)).min(1).max(20).optional(),
  /** 显式指定地理 provider；缺省按目的地自动判定（国内→amap，海外→osm） */
  geoProvider: z.enum(GEO_PROVIDERS).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export type CreateTripInput = z.infer<typeof CreateTripInputSchema>;

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
  durationMin: z.number().int().min(0).max(24 * 60).nullable().optional(),
  /** 预计游览/用餐分钟数（景点/美食尽量填写；规划每日行程的重要输入） */
  visitDurationMin: z.number().int().min(0).max(24 * 60).nullable().optional(),
  priceCny: z.number().min(0).nullable().optional(),
  bookingInfo: z.string().max(2000).nullable().optional(),
  /** 营业时间（v1 自由文本，如「09:00-17:00 周一闭馆」） */
  openingHours: z.string().max(200).nullable().optional(),
  /** 预订状态；agent 可填（如已核实可订），但以用户在界面上的标记为准 */
  bookingStatus: z.enum(BOOKING_STATUSES).optional(),
  /** 显式指定初始状态；缺省由服务端按创建者决定（human→locked，agent→candidate） */
  status: z.enum(PLACE_STATUSES).optional(),
});
export type CreatePlaceInput = z.infer<typeof CreatePlaceInputSchema>;

export const UpdatePlaceInputSchema = CreatePlaceInputSchema.partial();
export type UpdatePlaceInput = z.infer<typeof UpdatePlaceInputSchema>;

/** 锁定/解锁地点（PATCH /api/places/:id/status 与 MCP lock_place/unlock_place） */
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

// ---------- 区域聚类（suggest_day_clusters / GET /api/trips/:tripId/suggest-clusters） ----------

/** 一个地理聚类：未排期地点按位置聚成的一片区域 + 建议排入的天 */
export const DayClusterSchema = z.object({
  clusterIndex: z.number(),
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
  /** 建议排入的天（1-based，按各天当前负载分配，少的优先）；行程无天信息时为 null */
  suggestedDayIndex: z.number().nullable(),
});
export type DayCluster = z.infer<typeof DayClusterSchema>;

/** 区域聚类建议（只建议不落库）：把未排期的非酒店地点按地理聚成 1-4 片，建议每天一片 */
export const SuggestDayClustersResultSchema = z.object({
  clusters: z.array(DayClusterSchema),
  /** 参与聚类的未排期地点数（不含酒店、不含已排入某天行程的） */
  unscheduledCount: z.number(),
  dayCount: z.number(),
  note: z.string().optional(),
});
export type SuggestDayClustersResult = z.infer<typeof SuggestDayClustersResultSchema>;

export const CreateHotelCandidateInputSchema = CreatePlaceInputSchema.extend({
  pricePerNight: z.number().min(0).nullable().optional(),
});
export type CreateHotelCandidateInput = z.infer<
  typeof CreateHotelCandidateInputSchema
>;

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

// ---------- SSE 事件 ----------

export const TripEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bundle"), bundle: TripBundleSchema }),
  z.object({ type: z.literal("deleted"), tripId: z.string() }),
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
  totalCny: z.number(),
  remainingCny: z.number().nullable(),
  /** 还没填价格的餐厅/景点数（预算低估提醒） */
  unpricedCount: z.number(),
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
