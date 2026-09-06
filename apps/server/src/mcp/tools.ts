import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CreateHotelCandidateInputSchema,
  CreatePlaceInputSchema,
  LngLatSchema,
  SelectHotelInputSchema,
  TRANSIT_MODES,
  UpdatePlaceInputSchema,
} from "@yarnball/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { ServiceError, type TripService } from "../services/tripService.js";
import { amap, getProvider } from "../services/geo.js";

/**
 * MCP 工具面：暴露毛线团（Yarnball）行程数据结构给用户 agent。
 * 每个 chat session 一个 token；每次工具调用从请求头解析出 session，
 * 再绑定到该 session 关联的 trip —— agent 永远只能操作当前会话的行程。
 */

export const SESSION_ID_HEADER = "x-yarnball-session-id";
export const MCP_SERVER_NAME = "yarnball";

// ---------- token ----------

export function mintSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 校验 Bearer token + session header，返回 chat session 行（含 trip 绑定） */
export async function authenticateMcpRequest(
  db: Db,
  authHeader: string | undefined,
  sessionIdHeader: string | null,
): Promise<{ chatSession: typeof schema.chatSessions.$inferSelect; tripId: string } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  const tokenHash = hashToken(token);
  const [row] = await db
    .select()
    .from(schema.agentTokens)
    .where(and(eq(schema.agentTokens.tokenHash, tokenHash), isNull(schema.agentTokens.revokedAt)));
  if (!row) return null;
  if (sessionIdHeader && sessionIdHeader !== row.chatSessionId) return null;
  const [chatSession] = await db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, row.chatSessionId));
  if (!chatSession || chatSession.status === "closed") return null;
  return { chatSession, tripId: chatSession.tripId };
}

export async function revokeSessionTokens(db: Db, chatSessionId: string) {
  await db
    .update(schema.agentTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.agentTokens.chatSessionId, chatSessionId));
}

// ---------- tool input schemas ----------

const AddPlaceToDayInput = z.object({
  placeId: z.string(),
  dayIndex: z.number().int().min(1),
  position: z.number().int().min(0).nullable().optional(),
  /** 可选开始时间（HH:MM，24 小时制），排天时尽量给出 */
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
});

/** 大交通节点（航班/高铁/城际移动）：起讫点各给 place 引用或自由文本之一 */
const AddTransitEntryInput = z.object({
  dayIndex: z.number().int().min(1),
  position: z.number().int().min(0).nullable().optional(),
  departTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
  arriveTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
  fromPlaceId: z.string().nullable().optional(),
  toPlaceId: z.string().nullable().optional(),
  fromName: z.string().min(1).max(120).nullable().optional(),
  toName: z.string().min(1).max(120).nullable().optional(),
  /** 大交通方式：flight=航班 / train=火车高铁 / drive=自驾 / bus=大巴；缺省 null（直线段）。自驾环线城际段务必传 drive（走真实公路路线） */
  transitMode: z.enum(TRANSIT_MODES).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const UpdateEntryInput = z.object({
  entryId: z.string(),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
  durationMin: z.number().int().min(0).max(24 * 60).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  departTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
  arriveTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
  fromPlaceId: z.string().nullable().optional(),
  toPlaceId: z.string().nullable().optional(),
  fromName: z.string().min(1).max(120).nullable().optional(),
  toName: z.string().min(1).max(120).nullable().optional(),
  /** 大交通方式（仅 transit entry 可改）：flight|train|drive|bus；null=清除恢复直线段 */
  transitMode: z.enum(TRANSIT_MODES).nullable().optional(),
});

const MoveEntryInput = z.object({
  entryId: z.string(),
  dayIndex: z.number().int().min(1),
  position: z.number().int().min(0),
});

const RemoveEntryInput = z.object({ entryId: z.string() });

const ReorderDayInput = z.object({
  dayIndex: z.number().int().min(1),
  entryIds: z.array(z.string()).min(1),
});

const SearchPoiInput = z.object({
  keyword: z.string().min(1).max(100),
  city: z.string().max(60).optional(),
});

const GetRouteInput = z.object({
  from: LngLatSchema,
  to: LngLatSchema,
  mode: z.enum(["walk", "taxi", "transit", "drive"]).default("drive"),
});

const AnalyzeDetourInput = z.object({
  placeId: z.string(),
  dayIndex: z.number().int().min(1),
});

const SuggestDayOrderInput = z.object({ dayIndex: z.number().int().min(1) });

// 多酒店：checkInDay/checkOutDay 可选（1-based 闭开区间），缺省由服务端建议未被覆盖的天段
const SelectHotelInput = SelectHotelInputSchema;

// agent 不可经 add/update_place 直接指定 status：建点一律 candidate，锁定走 lock_place（或用户界面操作）
const McpCreatePlaceSchema = CreatePlaceInputSchema.omit({ status: true });

const UpdatePlaceWithIdSchema = UpdatePlaceInputSchema.omit({ status: true }).extend({ placeId: z.string() });

const RemovePlaceInput = z.object({ placeId: z.string() });

const PlaceStatusInput = z.object({ placeId: z.string() });

const SetBudgetInput = z.object({
  total: z.number().min(0).nullable().optional(),
  travelerCount: z.number().int().min(1).max(20).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
});

// ---------- 注册 ----------

export interface ToolContext {
  db: Db;
  tripService: TripService;
  chatSessionId: string;
  tripId: string;
  /** 标记该 session 已出现 MCP 工具调用（冒烟提示用） */
  markMcpObserved: () => void;
}

/**
 * 越权护栏：按 id 操作的实体必须属于本会话绑定的 trip。
 * 实体不存在与属于其他行程返回同一文案，不泄露实体是否存在。
 * （add_place_to_day / add_transit_entry / reorder_day / select_hotel 的 id 归属
 *  已由 tripService 按 tripId 校验，这里只兜底 service 层未覆盖的按 id 直查路径。）
 */
async function assertPlaceInSessionTrip(ctx: ToolContext, placeId: string) {
  const [row] = await ctx.db
    .select({ tripId: schema.places.tripId })
    .from(schema.places)
    .where(eq(schema.places.id, placeId));
  if (!row || row.tripId !== ctx.tripId) {
    throw new ServiceError(403, "无权操作该资源：不属于当前会话的行程");
  }
}

async function assertEntryInSessionTrip(ctx: ToolContext, entryId: string) {
  const [row] = await ctx.db
    .select({ tripId: schema.entries.tripId })
    .from(schema.entries)
    .where(eq(schema.entries.id, entryId));
  if (!row || row.tripId !== ctx.tripId) {
    throw new ServiceError(403, "无权操作该资源：不属于当前会话的行程");
  }
}

/** 行程的 geo provider + 城市中心（搜索偏置用） */
async function tripGeoInfo(ctx: ToolContext) {
  const [trip] = await ctx.db.select().from(schema.trips).where(eq(schema.trips.id, ctx.tripId));
  const provider = getProvider(trip?.geoProvider ?? "osm");
  const bias =
    trip?.cityCenterLng != null && trip?.cityCenterLat != null
      ? { lng: Number(trip.cityCenterLng), lat: Number(trip.cityCenterLat) }
      : null;
  return { trip, provider, bias };
}

export function registerYarnballTools(server: McpServer, ctx: ToolContext) {
  const { tripService, tripId } = ctx;

  server.registerTool(
    "get_trip_context",
    {
      description:
        "获取当前行程全貌（行程信息、天数、地点、每日安排、交通段、酒店候选）以及用户在 UI 里的当前选中状态。每次会话开始或用户说「看一下行程」时先调这个。",
      inputSchema: {},
    },
    async () => {
      ctx.markMcpObserved();
      const bundle = await tripService.getBundle(tripId);
      let uiContext: unknown = null;
      const [session] = await ctx.db
        .select()
        .from(schema.chatSessions)
        .where(eq(schema.chatSessions.id, ctx.chatSessionId));
      if (session?.uiContext) uiContext = session.uiContext;
      const overseas = bundle.trip.geoProvider === "osm";
      return json({
        trip: bundle.trip,
        days: bundle.days,
        places: bundle.places,
        entries: bundle.entries,
        legs: bundle.legs,
        hotelCandidates: bundle.hotelCandidates,
        budget: await tripService.getBudgetSummary(tripId),
        userUiContext: uiContext,
        hint:
          `字段含义：entries[].position 为天内顺序（0 起）；dayIndex 从 1 开始。` +
          ` trip.stops 为有序途经地节点（多城市/环线，stops[0] 是主目的地；单城市行程只有 1 个元素）。` +
          ` entries[].entryType：place=地点节点，transit=大交通节点（航班/高铁/城际移动，带 departTime/arriveTime 与 fromName/toName 或 fromPlaceId/toPlaceId 起讫点；transitMode：flight|train|drive|bus，drive=自驾走真实公路路线）。` +
          ` places[].cityName 为归属途经地/城市名（多城市分组依据）。` +
          ` places[].status：candidate=候选池（待用户确认），locked=用户已锁定（agent 不可改/删，只排 locked 的地点进每日行程）。` +
          ` places[].openingHours 为营业时间（排天硬约束），visitDurationMin 为预计游览/用餐分钟数（排天参考），bookingStatus 为预订状态（none|pending|booked）；website 官网、bookingUrl 预订链接、phone 电话、address 地址会展示在地点信息卡上。` +
          (overseas
            ? ` 本行程是海外目的地（${bundle.trip.destinationCity}，${bundle.trip.geoProvider} provider）：search_poi 时用英文或当地语言名称（如 "Sydney Opera House"）效果最好。`
            : ""),
      });
    },
  );

  server.registerTool(
    "search_poi",
    {
      description:
        "按关键词搜索真实地点（POI），返回名称、地址、精确坐标（gcj02）、poiId、cityName（归属城市）。**创建任何地点前必须先调这个工具**，用返回的 location 作为坐标——绝不自行填写或编造经纬度。多城市行程（trip.stops 多个节点）：搜目标城市的地点时务必传 city 参数（如搜「莫高窟」传 city=敦煌），并把返回的 cityName 带到 add_place。",
      inputSchema: SearchPoiInput.shape,
    },
    async ({ keyword, city }) => {
      ctx.markMcpObserved();
      const { trip, provider, bias } = await tripGeoInfo(ctx);
      const cityUsed = city ?? trip?.destinationCity ?? "";
      let candidates;
      try {
        candidates = await provider.searchPoi(keyword, cityUsed, bias);
      } catch (err) {
        const message = (err as Error).message ?? "";
        if (provider.name === "amap" && message.includes("AMAP_SERVER_KEY")) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "错误: 国内行程的地点搜索需要高德引擎，但服务端未配置 AMAP_SERVER_KEY。请告知用户在 .env 中配置（高德开放平台免费申请）。",
              },
            ],
          };
        }
        throw err;
      }
      const overseas = provider.name === "osm";
      return json({
        keyword,
        city: cityUsed,
        candidates,
        note:
          candidates.length === 0
            ? overseas
              ? "没有找到结果。海外地点请用英文或当地语言搜索（如 'Sydney Opera House'），也可尝试更通用的关键词。"
              : "没有找到结果，试试更通用的关键词（如去掉门店名/商场名）。"
            : overseas
              ? "海外行程：请确认候选确实在目的地城市附近再使用。"
              : undefined,
      });
    },
  );

  server.registerTool(
    "add_place",
    {
      description:
        "添加地点到行程的**候选池**（status 自动为 candidate，不进每日行程）。location 必须来自 search_poi 的返回。餐厅务必填 priceCny（人均）和 bookingInfo（预约方式：平台/电话/网站 + 建议提前天数）；景点填 priceCny（门票）、durationMin（建议游玩时长）和 openingHours（营业时间自由文本，如「09:00-17:00 周一闭馆」——排天硬约束，务必尽力填写）。visitDurationMin：预计游览/用餐分钟数，规划每日行程时的重要输入，景点和餐厅尽量填写。金额单位为行程币种。bookingStatus（none|pending|booked）可填但以用户在界面上的标记为准。**详情字段尽量收集**：website（官网）、bookingUrl（可直接下单/预约的预订链接）、phone（电话）、address（结构化地址）——这些会直接展示在地点信息卡上，酒店和需预约餐厅尤其重要。多城市行程：把 search_poi 返回的 cityName 原样带到 cityName 字段（归属途经地分组依据；不传则服务端按最近途经地自动填充）。**阶段纪律：解析攻略或推荐地点时只建候选，等用户在界面上锁定（status=locked）后才用 add_place_to_day 排天。**",
      inputSchema: McpCreatePlaceSchema.shape,
    },
    async (input) => {
      ctx.markMcpObserved();
      try {
        const place = await tripService.createPlace(tripId, input, "agent");
        return json({ ok: true, place });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "update_place",
    {
      description:
        "更新地点信息（备注、游玩时长、visitDurationMin 预计游览/用餐分钟数、价格、openingHours 营业时间、bookingStatus 预订状态、website 官网、bookingUrl 预订链接、phone 电话、address 地址等）。只需要传要改的字段。bookingStatus 可由你更新（如你已核实可订/已订），但以用户在界面上的标记为准。注意：status=locked（用户已锁定）的地点不可修改——请用户在界面上解锁。",
      inputSchema: UpdatePlaceWithIdSchema.shape,
    },
    async ({ placeId, ...patch }) => {
      ctx.markMcpObserved();
      try {
        await assertPlaceInSessionTrip(ctx, placeId);
        const place = await tripService.updatePlace(placeId, patch, "agent");
        return json({ ok: true, place });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "remove_place",
    {
      description:
        "从地点库删除地点（会连带从各天行程中移除）。注意：status=locked（用户已锁定）的地点不可删除——请用户在界面上解锁。",
      inputSchema: RemovePlaceInput.shape,
    },
    async ({ placeId }) => {
      ctx.markMcpObserved();
      try {
        await assertPlaceInSessionTrip(ctx, placeId);
        await tripService.removePlace(placeId, "agent");
        return json({ ok: true });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "lock_place",
    {
      description:
        "把候选地点标记为 locked（已确认要去）。一般只有用户明确要求「就定这家/这个一定要去」时才由 agent 调用；通常锁定动作由用户在界面上完成。",
      inputSchema: PlaceStatusInput.shape,
    },
    async ({ placeId }) => {
      ctx.markMcpObserved();
      try {
        await assertPlaceInSessionTrip(ctx, placeId);
        const place = await tripService.setPlaceStatus(placeId, "locked");
        return json({ ok: true, place });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "unlock_place",
    {
      description:
        "把已锁定的地点退回候选池（status=candidate）。用户说「先不定了/再想想」时调用。",
      inputSchema: PlaceStatusInput.shape,
    },
    async ({ placeId }) => {
      ctx.markMcpObserved();
      try {
        await assertPlaceInSessionTrip(ctx, placeId);
        const place = await tripService.setPlaceStatus(placeId, "candidate");
        return json({ ok: true, place });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "add_place_to_day",
    {
      description:
        "把地点安排到某一天（dayIndex 从 1 开始）。不传 position 则加到当天末尾；startTime 传该地点的开始时间（HH:MM）。**只应排 status=locked 的地点**（先 get_trip_context 确认）；候选请先提醒用户去界面锁定。排天时按酒店→景点的实际交通写 startTime，保证时间轴连贯。",
      inputSchema: AddPlaceToDayInput.shape,
    },
    async ({ placeId, dayIndex, position, startTime }) => {
      ctx.markMcpObserved();
      try {
        const result = await tripService.addEntry(tripId, {
          entryType: "place",
          placeId,
          dayIndex,
          position: position ?? null,
          startTime: startTime ?? null,
        });
        return json({ ok: true, ...result });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "add_transit_entry",
    {
      description:
        "添加大交通节点（transit entry：航班/高铁/城际移动，如「家 → 萧山机场」「杭州东站 → 市区酒店」）到某一天。起讫点各给一种：fromPlaceId/toPlaceId（行程内地点，走真实坐标参与当天路线锚定，推荐先 search_poi 建好站点 place）或 fromName/toName（自由文本，如「家」「浦东机场」，不产生交通段）。departTime/arriveTime 尽量给（HH:MM）——到达日的 arriveTime 约束当天可排容量，离开日的 departTime 是当天收口（最后一个景点要预留赶车缓冲）。到达 transit 排在当天第一位、离开 transit 排在当天最后一位。**多城市/环线行程：城市间移动也是 transit entry**（排在移动日当天首位，fromPlaceId/toPlaceId 引用两端城市的 place）；transitMode 传 drive（自驾环线城际段，走真实公路路线和里程）、train（火车/高铁）、flight（航班）、bus（大巴），缺省为直线段（适合航班/高铁）。环线闭合：最后一段 transit 的讫点回到主目的地（stops[0]）即自动视为环线闭合，无需特殊标记。",
      inputSchema: AddTransitEntryInput.shape,
    },
    async (input) => {
      ctx.markMcpObserved();
      try {
        const result = await tripService.addEntry(tripId, { entryType: "transit", ...input });
        return json({ ok: true, ...result });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "update_entry",
    {
      description:
        "修改某天行程中的条目：startTime（HH:MM）、durationMin（该次停留时长覆盖，分钟）、note；transit entry 还可改 departTime/arriveTime、起讫点（fromPlaceId/toPlaceId/fromName/toName，传 null 清除）与 transitMode（flight|train|drive|bus，传 null 恢复直线段）。",
      inputSchema: UpdateEntryInput.shape,
    },
    async ({ entryId, ...patch }) => {
      ctx.markMcpObserved();
      try {
        await assertEntryInSessionTrip(ctx, entryId);
        const entry = await tripService.updateEntry(entryId, patch);
        return json({ ok: true, entry });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "move_entry",
    {
      description: "移动某天行程中的某个地点到指定天/位置。",
      inputSchema: MoveEntryInput.shape,
    },
    async ({ entryId, dayIndex, position }) => {
      ctx.markMcpObserved();
      try {
        await assertEntryInSessionTrip(ctx, entryId);
        await tripService.moveEntry(entryId, dayIndex, position);
        return json({ ok: true });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "remove_entry",
    {
      description: "把地点从某天的行程中移除（地点仍保留在地点库）。",
      inputSchema: RemoveEntryInput.shape,
    },
    async ({ entryId }) => {
      ctx.markMcpObserved();
      try {
        await assertEntryInSessionTrip(ctx, entryId);
        await tripService.removeEntry(entryId);
        return json({ ok: true });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "reorder_day",
    {
      description: "直接重排某天行程（立即生效，地图实时刷新）。entryIds 必须包含该天全部 entry。",
      inputSchema: ReorderDayInput.shape,
    },
    async ({ dayIndex, entryIds }) => {
      ctx.markMcpObserved();
      try {
        await tripService.reorderDay(tripId, dayIndex, entryIds);
        return json({ ok: true });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "get_route",
    {
      description: "查两点间路线（步行/驾车/公交），返回距离、耗时和真实路径坐标。",
      inputSchema: GetRouteInput.shape,
    },
    async ({ from, to, mode }) => {
      ctx.markMcpObserved();
      try {
        const { trip, provider } = await tripGeoInfo(ctx);
        const route = await provider.route(from, to, mode, trip?.destinationCity);
        return json({
          ok: true,
          route,
          note:
            provider.name === "osm" && mode === "transit"
              ? "海外公交查询暂不可用，返回的是估算值（驾车时长 × 1.25 + 换乘时间）。"
              : undefined,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "analyze_detour",
    {
      description:
        "顺路度分析：如果把某地点插入某天行程的每个位置，分别多花多少交通时间，并给出最优插入位置。回答「XX放哪天顺路」类问题必备。",
      inputSchema: AnalyzeDetourInput.shape,
    },
    async ({ placeId, dayIndex }) => {
      ctx.markMcpObserved();
      try {
        await assertPlaceInSessionTrip(ctx, placeId);
        const analysis = await tripService.analyzeDetour(tripId, placeId, dayIndex);
        return json({ ok: true, analysis });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "suggest_day_order",
    {
      description:
        "重排建议：分析某天的最优游览顺序（固定第一个点为起点），返回优化前后对比和预计节省时间。只建议不生效；确认后用 reorder_day 应用。",
      inputSchema: SuggestDayOrderInput.shape,
    },
    async ({ dayIndex }) => {
      ctx.markMcpObserved();
      try {
        const suggestion = await tripService.suggestDayOrder(tripId, dayIndex);
        return json({ ok: true, suggestion });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "suggest_day_clusters",
    {
      description:
        "区域聚类建议（只建议不落库）：把还没排进任何一天的非酒店地点按地理位置聚成 1-4 片，并按各天负载建议「每天一片」。候选多、准备排天时先调这个拿分区方案，再逐天 add_place_to_day。",
      inputSchema: {},
    },
    async () => {
      ctx.markMcpObserved();
      try {
        const suggestion = await tripService.suggestDayClusters(tripId);
        return json({ ok: true, suggestion });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "add_hotel_candidate",
    {
      description:
        "添加酒店候选（location 必须来自 search_poi）。价格单位：元/晚。酒店地点同样进候选池（status=candidate），用户选定用 select_hotel。",
      inputSchema: CreateHotelCandidateInputSchema.omit({ status: true }).shape,
    },
    async (input) => {
      ctx.markMcpObserved();
      try {
        const result = await tripService.addHotelCandidate(tripId, input, "agent");
        return json({ ok: true, candidate: result.candidate, place: result.place });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "select_hotel",
    {
      description:
        "选定酒店并指定住宿天数区间（checkInDay/checkOutDay，1-based 天序号，闭开区间：覆盖第 checkInDay 到 checkOutDay-1 晚）。缺省时自动建议尚未被其他酒店覆盖的天段。支持多酒店：跨城市/长行程可选定多家，各覆盖一段天数，区间不得重叠；换酒店日 = 旧酒店 checkOutDay = 新酒店 checkInDay。candidateId 传 null 取消全部选定。",
      inputSchema: SelectHotelInput.shape,
    },
    async ({ candidateId, checkInDay, checkOutDay }) => {
      ctx.markMcpObserved();
      try {
        const range = await tripService.selectHotel(tripId, candidateId, { checkInDay, checkOutDay });
        return json({ ok: true, ...(range ?? {}) });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "set_budget",
    {
      description:
        "设置行程总预算、出行人数和币种（如 AUD/USD/CNY）。预算面板自动汇总对比：住宿按已选定酒店每晚价×晚数（不按人数计），美食/门票只计已加入行程（locked）的地点（餐厅人均×人数、门票单价×人数），候选池未加入项不计入；已选定未填价酒店与已加入未填价地点计入未定价提醒。用户提到预算时调这个。",
      inputSchema: SetBudgetInput.shape,
    },
    async (input) => {
      ctx.markMcpObserved();
      try {
        await tripService.updateBudget(tripId, {
          budgetCny: input.total,
          travelerCount: input.travelerCount,
          currency: input.currency,
        });
        return json({
          ok: true,
          summary: await tripService.getBudgetSummary(tripId),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

// ---------- 输出 helpers ----------

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** MCP 工具不抛异常：失败的调用返回结构化错误文本，避免炸掉 agent 会话 */
function toolError(err: unknown) {
  const status = err instanceof ServiceError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `错误(${status}): ${message}` }],
  };
}
