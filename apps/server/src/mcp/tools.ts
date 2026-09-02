import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CreateHotelCandidateInputSchema,
  CreatePlaceInputSchema,
  LngLatSchema,
  UpdatePlaceInputSchema,
} from "@odessey/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { ServiceError, type TripService } from "../services/tripService.js";
import { amap, getProvider } from "../services/geo.js";

/**
 * MCP 工具面：暴露 Odessey 行程数据结构给用户 agent。
 * 每个 chat session 一个 token；每次工具调用从请求头解析出 session，
 * 再绑定到该 session 关联的 trip —— agent 永远只能操作当前会话的行程。
 */

export const SESSION_ID_HEADER = "x-odessey-session-id";
export const MCP_SERVER_NAME = "odessey";

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

const SelectHotelInput = z.object({
  candidateId: z.string().nullable(),
});

const UpdatePlaceWithIdSchema = UpdatePlaceInputSchema.extend({ placeId: z.string() });

const RemovePlaceInput = z.object({ placeId: z.string() });

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

export function registerOdesseyTools(server: McpServer, ctx: ToolContext) {
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
        "按关键词搜索真实地点（POI），返回名称、地址、精确坐标（gcj02）、poiId。**创建任何地点前必须先调这个工具**，用返回的 location 作为坐标——绝不自行填写或编造经纬度。",
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
        "添加地点（景点/餐厅/活动）到行程的地点库。location 必须来自 search_poi 的返回。餐厅务必填 priceCny（人均）和 bookingInfo（预约方式：平台/电话/网站 + 建议提前天数）；景点填 priceCny（门票）和 durationMin（建议游玩时长）。金额单位为行程币种。",
      inputSchema: CreatePlaceInputSchema.shape,
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
      description: "更新地点信息（备注、游玩时长、价格等）。只需要传要改的字段。",
      inputSchema: UpdatePlaceWithIdSchema.shape,
    },
    async ({ placeId, ...patch }) => {
      ctx.markMcpObserved();
      try {
        const place = await tripService.updatePlace(placeId, patch);
        return json({ ok: true, place });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "remove_place",
    {
      description: "从地点库删除地点（会连带从各天行程中移除）。",
      inputSchema: RemovePlaceInput.shape,
    },
    async ({ placeId }) => {
      ctx.markMcpObserved();
      try {
        await tripService.removePlace(placeId);
        return json({ ok: true });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "add_place_to_day",
    {
      description: "把地点库中的地点安排到某一天（dayIndex 从 1 开始）。不传 position 则加到当天末尾。",
      inputSchema: AddPlaceToDayInput.shape,
    },
    async ({ placeId, dayIndex, position }) => {
      ctx.markMcpObserved();
      try {
        const result = await tripService.addEntry(tripId, placeId, dayIndex, position ?? null);
        return json({ ok: true, ...result });
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
    "add_hotel_candidate",
    {
      description:
        "添加酒店候选（location 必须来自 search_poi）。价格单位：元/晚。",
      inputSchema: CreateHotelCandidateInputSchema.shape,
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
      description: "选定酒店（传候选 id）或取消选择（传 null）。",
      inputSchema: SelectHotelInput.shape,
    },
    async ({ candidateId }) => {
      ctx.markMcpObserved();
      try {
        await tripService.selectHotel(tripId, candidateId);
        return json({ ok: true });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "set_budget",
    {
      description:
        "设置行程总预算、出行人数和币种（如 AUD/USD/CNY）。预算面板会自动按酒店每晚×晚数、餐厅人均×人数、门票×人数汇总对比。用户提到预算时调这个。",
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
