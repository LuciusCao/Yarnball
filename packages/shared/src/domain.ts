/**
 * Odessey 领域模型 —— zod schema 单一定义点。
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

/** 变更由谁触发（人类直接编辑 or agent 经 MCP） */
export const ACTORS = ["human", "agent"] as const;
export type Actor = (typeof ACTORS)[number];

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

// ---------- 实体 DTO（API 返回形状） ----------

export const TripDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  destinationCity: z.string(),
  cityAdcode: z.string().nullable(),
  geoProvider: z.enum(GEO_PROVIDERS),
  location: LngLatSchema.nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  selectedHotelCandidateId: z.string().nullable(),
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
  amapPoiId: z.string().nullable(),
  sourceType: z.enum(SOURCE_TYPES),
  sourceUrl: z.string().nullable(),
  notes: z.string().nullable(),
  durationMin: z.number().nullable(),
  priceCny: z.number().nullable(),
  createdBy: z.enum(ACTORS),
  createdAt: z.string(),
});
export type PlaceDto = z.infer<typeof PlaceDtoSchema>;

export const EntryDtoSchema = z.object({
  id: z.string(),
  dayId: z.string(),
  tripId: z.string(),
  placeId: z.string(),
  position: z.number(),
  startTime: z.string().nullable(),
  note: z.string().nullable(),
});
export type EntryDto = z.infer<typeof EntryDtoSchema>;

export const TransportLegDtoSchema = z.object({
  id: z.string(),
  dayId: z.string(),
  tripId: z.string(),
  fromEntryId: z.string(),
  toEntryId: z.string(),
  mode: z.enum(TRANSPORT_MODES),
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
  /** 显式指定地理 provider；缺省按目的地自动判定（国内→amap，海外→osm） */
  geoProvider: z.enum(GEO_PROVIDERS).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export type CreateTripInput = z.infer<typeof CreateTripInputSchema>;

export const CreatePlaceInputSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.enum(PLACE_CATEGORIES).default("other"),
  location: LngLatSchema,
  address: z.string().max(300).nullable().optional(),
  amapPoiId: z.string().max(64).nullable().optional(),
  sourceType: z.enum(SOURCE_TYPES).default("manual"),
  sourceUrl: z.string().url().max(500).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  durationMin: z.number().int().min(0).max(24 * 60).nullable().optional(),
  priceCny: z.number().min(0).nullable().optional(),
});
export type CreatePlaceInput = z.infer<typeof CreatePlaceInputSchema>;

export const UpdatePlaceInputSchema = CreatePlaceInputSchema.partial();
export type UpdatePlaceInput = z.infer<typeof UpdatePlaceInputSchema>;

export const AddEntryInputSchema = z.object({
  placeId: z.string(),
  dayIndex: z.number().int().min(1),
  position: z.number().int().min(0).nullable().optional(),
});
export type AddEntryInput = z.infer<typeof AddEntryInputSchema>;

export const ReorderDayInputSchema = z.object({
  entryIds: z.array(z.string()).min(1),
});
export type ReorderDayInput = z.infer<typeof ReorderDayInputSchema>;

export const CreateHotelCandidateInputSchema = CreatePlaceInputSchema.extend({
  pricePerNight: z.number().min(0).nullable().optional(),
});
export type CreateHotelCandidateInput = z.infer<
  typeof CreateHotelCandidateInputSchema
>;

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
