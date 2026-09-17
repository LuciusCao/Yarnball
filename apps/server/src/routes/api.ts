import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { and, asc, eq, ne } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AddEntryInputSchema,
  ChatMessagesQuerySchema,
  CreateAccessLinkInputSchema,
  CreateAgentInputSchema,
  CreateHotelCandidateInputSchema,
  CreatePlaceInputSchema,
  CreateTripInputSchema,
  CreateTripNoteInputSchema,
  POSSIBLE_DUPLICATE_CODE,
  ReorderDayInputSchema,
  SelectHotelInputSchema,
  SetLegModeInputSchema,
  SetPlaceStatusInputSchema,
  UnselectHotelInputSchema,
  UpdateAccessLinkInputSchema,
  UpdateAgentInputSchema,
  UpdateDaySummaryInputSchema,
  UpdateEntryInputSchema,
  UpdatePlaceInputSchema,
  UpdateSettingsInputSchema,
  UpdateTripInputSchema,
  UpdateTripNoteInputSchema,
  type AgentAvailability,
  type SharePayload,
  type TripBundle,
} from "@yarnball/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { chatChannel, tripChannel, TRIPS_CHANNEL, type EventBus } from "../events.js";
import type { AcpSessionManager } from "../acp/sessionManager.js";
import { PossibleDuplicateError, ServiceError, type TripService } from "../services/tripService.js";
import { getProvider } from "../services/geo.js";
import { getTripWeather } from "../services/weather.js";
import { amapConfigured, getSettings, updateSettings, getOwnerTokenStatus, resetOwnerToken } from "../services/settings.js";
import { toAgentDto, toChatSessionDto } from "../services/mappers.js";
import { listChatMessages } from "../services/chatStore.js";
import { findExecutable } from "../services/processEnv.js";
import { principalMiddleware, rejectNonOwner, requireOwner, tripReadGuard, tripWriteGuard, AuthError, resolvePrincipal } from "../services/auth.js";

/**
 * 分享包 id 脱敏：把 bundle 内所有真实 id（含 tripId/placeId/dayId/entryId 等引用字段）
 * 换成 sha256(token:id) 截断 16 位的不透明别名。同一真实 id 全包映射为同一别名，
 * 前端关联（entry.placeId → place、leg 端点、酒店候选）不断；分享链接是公开凭证，
 * 实体级写端点（PATCH/DELETE /places/:id 等）无鉴权，访客拿别名去调只会 404。
 * trip.id / shareToken 维持置空（可写标识不下发）。
 */
function aliasShareBundleIds(bundle: TripBundle, token: string): SharePayload["bundle"] {
  const alias = (id: string) => createHash("sha256").update(`${token}:${id}`).digest("hex").slice(0, 16);
  const ref = (id: string | null) => (id == null ? null : alias(id));
  return {
    trip: {
      ...bundle.trip,
      id: "",
      shareToken: "",
      selectedHotelCandidateId: ref(bundle.trip.selectedHotelCandidateId),
    },
    days: bundle.days.map((d) => ({ ...d, id: alias(d.id), tripId: alias(d.tripId) })),
    places: bundle.places.map((p) => ({ ...p, id: alias(p.id), tripId: alias(p.tripId) })),
    entries: bundle.entries.map((e) => ({
      ...e,
      id: alias(e.id),
      dayId: alias(e.dayId),
      tripId: alias(e.tripId),
      placeId: ref(e.placeId),
      fromPlaceId: ref(e.fromPlaceId),
      toPlaceId: ref(e.toPlaceId),
    })),
    legs: bundle.legs.map((l) => ({
      ...l,
      id: alias(l.id),
      dayId: alias(l.dayId),
      tripId: alias(l.tripId),
      fromEntryId: ref(l.fromEntryId),
      toEntryId: ref(l.toEntryId),
      fromPlaceId: ref(l.fromPlaceId),
      toPlaceId: ref(l.toPlaceId),
    })),
    hotelCandidates: bundle.hotelCandidates.map((h) => ({
      ...h,
      id: alias(h.id),
      tripId: alias(h.tripId),
      placeId: alias(h.placeId),
    })),
    notes: bundle.notes.map((n) => ({ ...n, id: alias(n.id), tripId: alias(n.tripId) })),
  };
}

/**
 * REST API —— 人类直接编辑行程（与 agent 经 MCP 的编辑双入口）+ chat 会话管理 + SSE。
 *
 * 访问控制（v0.4 多人协作地基，issue #16）：
 * - 公开区（无需凭证）：GET /share/:token（只读分享，token 即凭证）、GET /config（前端启动配置）、
 *   两个 SSE events 端点（EventSource 无法带 header，token 走 ?token= query param）
 * - guard 区：其余全部端点。principal 中间件统一解析身份（loopback 无 token = owner 桌面形态、
 *   Bearer access-link token = guest、Bearer owner token = owner、远程匿名 401），
 *   权限矩阵按端点收敛为三个 guard（见 services/auth.ts）：
 *     requireOwner    owner-only（删行程 / agents / settings / chat-sessions / access-links / owner-token）
 *     tripReadGuard   viewer+editor 的行程读端点（仅限 guest 绑定的行程）
 *     tripWriteGuard  仅 editor 的行程写端点（仅限 guest 绑定的行程）
 *   guard 区兜底 rejectNonOwner：非行程级端点（行程列表、city-suggest、agents 等）对 guest 一律拒绝，
 *   新增端点忘记挂 guard 也不会直通。
 * - /mcp 不在此文件（独立 scoped token 体系，不在本 issue 范围）。
 */

export function createApi(
  db: Db,
  bus: EventBus,
  tripService: TripService,
  sessions: AcpSessionManager,
): Hono {
  const api = new Hono();

  // ---------- 错误包装 ----------

  api.onError((err, c) => {
    // 疑似重复信号：409 + 已有 place DTO，前端据此弹确认框（确认后带 allowDuplicate=true 重试）
    if (err instanceof PossibleDuplicateError) {
      return c.json(
        { error: err.message, code: POSSIBLE_DUPLICATE_CODE, existingPlace: err.existingPlace },
        409,
      );
    }
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400);
    // zod 入参校验失败 → 400（此前一律 500，调用方无法区分是参数错还是服务端故障）
    if (err instanceof z.ZodError) {
      return c.json({ error: err.issues.map((i) => i.message).join("; ") }, 400);
    }
    console.error("[api] unhandled:", err);
    return c.json({ error: "internal error" }, 500);
  });

  // ---------- 公开区（无需凭证） ----------
  // 顺序敏感：这些端点必须先注册，才能挡在 guard 子 app 的 use("*") 中间件之前
  //（Hono 按注册顺序匹配，先命中的 handler 不会落到后挂载子 app 的中间件——已用脚本验证）。

  api.get("/config", (c) => {
    const s = getSettings();
    return c.json({
      amapConfigured: s.amapConfigured,
      amapJsKey: s.amapJsKey,
      amapJsSecret: s.amapJsSecret,
      activeChatSessions: sessions.size,
    });
  });

  api.get("/share/:token", async (c) => {
    const token = c.req.param("token");
    const trip = await tripService.getTripByShareToken(token);
    const [bundle, budget] = await Promise.all([
      tripService.getBundle(trip.id),
      tripService.getBudgetSummary(trip.id),
    ]);
    return c.json({ bundle: aliasShareBundleIds(bundle, token), budget } satisfies SharePayload);
  });

  // SSE 公开端点（token 必须走 ?token=：EventSource 不能带自定义 header；Bearer 也接受，方便 curl 自测）
  api.get("/trips/:tripId/events", async (c) => {
    const denied = await sseAuth(c, c.req.param("tripId"), "trip");
    if (denied) return denied;
    return streamSSE(c, async (stream) => {
      const unsubscribers = [tripChannel(c.req.param("tripId")), TRIPS_CHANNEL].map((ch) =>
        bus.subscribe(ch, (event) => {
          void stream.writeSSE({ data: JSON.stringify(event) });
        }),
      );
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ data: "", event: "ping" });
      }, 25_000);
      stream.onAbort(() => {
        clearInterval(heartbeat);
        for (const u of unsubscribers) u();
      });
      // 挂到断连
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });

  api.get("/chat-sessions/:sessionId/events", async (c) => {
    // chat 会话对同伴不可见（agent 面板边界）：仅 owner 可订阅（loopback / owner token）
    const denied = await sseAuth(c, null, "owner");
    if (denied) return denied;
    const channel = chatChannel(c.req.param("sessionId"));
    return streamSSE(c, async (stream) => {
      const unsubscribe = bus.subscribe(channel, (event) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ data: "", event: "ping" });
      }, 25_000);
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });

  // ---------- guard 区（受保护端点） ----------
  // 结构：api.route("/", guarded) —— 先注册的公开 handler 挡在上面，这里只剩需鉴权的路径。

  const guarded = new Hono();

  // principal 解析中间件：每请求解析身份挂 context；无效/已吊销 token 直接 401。
  // AuthError（guard 抛出）由下方 guarded.onError 统一转响应。
  guarded.use("*", principalMiddleware(db));

  guarded.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status as 401 | 403);
    throw err; // 其余错误交外层 api.onError（ServiceError / ZodError / 未知错误）
  });

  // ---------- 城市联想（创建表单自动补全；非行程级端点，guest 一律拒绝） ----------

  guarded.get("/city-suggest", async (c) => {
    rejectNonOwner(c);
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 1) return c.json({ suggestions: [] });
    // 高德可用时国内城市优先走高德（中文名更准），否则 OSM 栈（Nominatim 优先）
    const useAmap = amapConfigured() && /[\u4e00-\u9fff]/.test(q) === false ? false : amapConfigured();
    try {
      const suggestions = useAmap
        ? await getProvider("amap").suggestCities(q)
        : await getProvider("osm").suggestCities(q);
      return c.json({ suggestions: suggestions.slice(0, 5) });
    } catch {
      try {
        return c.json({ suggestions: (await getProvider("osm").suggestCities(q)).slice(0, 5) });
      } catch {
        return c.json({ suggestions: [] });
      }
    }
  });

  // ---------- 行程目的地自愈重定位 ----------

  guarded.post("/trips/:tripId/resolve-city", async (c) => {
    tripWriteGuard(c.req.param("tripId"), c);
    return c.json({ trip: await tripService.reResolveCity(c.req.param("tripId")) });
  });

  // ---------- trips ----------

  /** 行程列表（非行程级端点）：行程元数据全库可见，对 guest 泄露其他行程标题——owner-only */
  guarded.get("/trips", async (c) => {
    rejectNonOwner(c);
    return c.json({ trips: await tripService.listTrips() });
  });

  guarded.post("/trips", async (c) => {
    rejectNonOwner(c); // 创建行程是 owner-only（guest 没有自己的行程空间）
    const input = CreateTripInputSchema.parse(await c.req.json());
    return c.json({ trip: await tripService.createTrip(input) }, 201);
  });

  guarded.get("/trips/:tripId", async (c) => {
    const tripId = c.req.param("tripId");
    tripReadGuard(tripId, c);
    return c.json({ bundle: await tripService.getBundle(tripId) });
  });

  /** 更新行程字段：title 标题 / startDate 出发日期 / endDate 结束日期（日期传 null = 清除，天标签退化为 Day N） */
  guarded.patch("/trips/:tripId", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const input = UpdateTripInputSchema.parse(await c.req.json());
    return c.json({ trip: await tripService.updateTrip(tripId, input) });
  });

  /**
   * 修改行程标题（issue #12，PATCH /api/trips/:tripId/title）。
   * M101 起 title 已收敛进 UpdateTripInputSchema（上面的通用 PATCH 端点）；
   * 本端点保留兼容（前端 renameTrip 仍在用），内部委托同一条 updateTrip 路径，行为完全一致。
   */
  guarded.patch("/trips/:tripId/title", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const { title } = z.object({ title: z.string().trim().min(1).max(120) }).parse(await c.req.json());
    return c.json({ trip: await tripService.updateTrip(tripId, { title }) });
  });

  guarded.delete("/trips/:tripId", async (c) => {
    requireOwner(c); // owner-only：删除整段行程对 guest 始终 403
    const tripId = c.req.param("tripId");
    // 句柄以 chatSessionId 为键——必须按 trip 归组停，否则 agent 子进程泄漏
    await sessions.stopByTrip(tripId, "trip deleted").catch(() => {});
    // 无句柄的残留行（重启后 idle/error）一并置 closed 终态；随后 deleteTrip cascade 删行
    await db
      .update(schema.chatSessions)
      .set({ status: "closed", updatedAt: new Date() })
      .where(eq(schema.chatSessions.tripId, tripId));
    await tripService.deleteTrip(tripId);
    return c.json({ ok: true });
  });

  // ---------- places（实体级写端点：无 tripId 前缀，归属在 guard 内查行校验） ----------

  guarded.post("/trips/:tripId/places", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const input = CreatePlaceInputSchema.parse(await c.req.json());
    return c.json({ place: await tripService.createPlace(tripId, input, "human") }, 201);
  });

  guarded.patch("/places/:placeId", async (c) => {
    await guardPlaceTrip(c, c.req.param("placeId"), "write");
    const input = UpdatePlaceInputSchema.parse(await c.req.json());
    return c.json({ place: await tripService.updatePlace(c.req.param("placeId"), input) });
  });

  /** 加入/移出行程（地点状态机：candidate ↔ joined，UI 与 agent 话术「加入行程/移出行程」） */
  guarded.patch("/places/:placeId/status", async (c) => {
    await guardPlaceTrip(c, c.req.param("placeId"), "write");
    const input = SetPlaceStatusInputSchema.parse(await c.req.json());
    return c.json({ place: await tripService.setPlaceStatus(c.req.param("placeId"), input.status) });
  });

  /** 移出行程（M20）：撤销该地点的全部日程 entry，地点退回候选态 */
  guarded.post("/places/:placeId/unschedule", async (c) => {
    await guardPlaceTrip(c, c.req.param("placeId"), "write");
    const result = await tripService.unschedulePlace(c.req.param("placeId"));
    return c.json({ ok: true, removedEntries: result.removedEntries });
  });

  guarded.delete("/places/:placeId", async (c) => {
    await guardPlaceTrip(c, c.req.param("placeId"), "write");
    await tripService.removePlace(c.req.param("placeId"));
    return c.json({ ok: true });
  });

  // ---------- search（人类手动加地点；editor 可用，viewer 403） ----------

  guarded.get("/trips/:tripId/search", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const keyword = c.req.query("keyword") ?? "";
    if (!keyword.trim()) return c.json({ candidates: [] });
    const [trip] = await db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
    const provider = getProvider(trip?.geoProvider ?? "osm");
    const bias =
      trip?.cityCenterLng != null && trip?.cityCenterLat != null
        ? { lng: Number(trip.cityCenterLng), lat: Number(trip.cityCenterLat) }
        : null;
    // 多城市行程可传 city 指定目标途经地偏置；缺省仍按主目的地（stops[0] 镜像）
    const city = c.req.query("city") ?? trip?.destinationCity ?? "";
    try {
      const candidates = await provider.searchPoi(keyword, city, bias);
      return c.json({ candidates });
    } catch (err) {
      const message = (err as Error).message ?? "";
      const hint =
        trip?.geoProvider === "amap" && message.includes("AMAP_SERVER_KEY")
          ? "国内行程使用高德引擎，需要在 .env 配置 AMAP_SERVER_KEY（高德开放平台免费申请，见 .env.example）"
          : message;
      return c.json({ candidates: [], error: hint }, 200);
    }
  });

  // ---------- entries ----------

  /** 排入某天：entryType=place（默认，placeId 必填）或 transit（大交通节点，起讫点 fromPlaceId/fromName + toPlaceId/toName） */
  guarded.post("/trips/:tripId/entries", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const input = AddEntryInputSchema.parse(await c.req.json());
    const result = await tripService.addEntry(tripId, input);
    return c.json(result, 201);
  });

  /** 编辑 entry：startTime/durationMin/note 通用；departTime/arriveTime/起讫点仅 transit entry */
  guarded.patch("/entries/:entryId", async (c) => {
    await guardEntryTrip(c, c.req.param("entryId"), "write");
    const input = UpdateEntryInputSchema.parse(await c.req.json());
    return c.json({ entry: await tripService.updateEntry(c.req.param("entryId"), input) });
  });

  guarded.delete("/entries/:entryId", async (c) => {
    await guardEntryTrip(c, c.req.param("entryId"), "write");
    await tripService.removeEntry(c.req.param("entryId"));
    return c.json({ ok: true });
  });

  guarded.post("/entries/:entryId/move", async (c) => {
    await guardEntryTrip(c, c.req.param("entryId"), "write");
    const input = z
      .object({ dayIndex: z.number().int().min(1), position: z.number().int().min(0) })
      .parse(await c.req.json());
    await tripService.moveEntry(c.req.param("entryId"), input.dayIndex, input.position);
    return c.json({ ok: true });
  });

  guarded.post("/trips/:tripId/days/:dayIndex/reorder", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const input = ReorderDayInputSchema.parse(await c.req.json());
    await tripService.reorderDay(tripId, Number(c.req.param("dayIndex")), input.entryIds);
    return c.json({ ok: true });
  });

  // ---------- 每日概要（issue #9） ----------

  /** 撰写/更新每日概要（summary 传 null = 清除撰写值，恢复服务端自动兜底） */
  guarded.patch("/days/:dayId/summary", async (c) => {
    await guardDayTrip(c, c.req.param("dayId"), "write");
    const input = UpdateDaySummaryInputSchema.parse(await c.req.json());
    return c.json({ day: await tripService.updateDaySummary(c.req.param("dayId"), input.summary) });
  });

  // ---------- 行程级注意事项（issue #11） ----------

  guarded.post("/trips/:tripId/notes", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const input = CreateTripNoteInputSchema.parse(await c.req.json());
    return c.json({ note: await tripService.createTripNote(tripId, input) }, 201);
  });

  guarded.patch("/notes/:noteId", async (c) => {
    await guardNoteTrip(c, c.req.param("noteId"), "write");
    const input = UpdateTripNoteInputSchema.parse(await c.req.json());
    return c.json({ note: await tripService.updateTripNote(c.req.param("noteId"), input) });
  });

  guarded.delete("/notes/:noteId", async (c) => {
    await guardNoteTrip(c, c.req.param("noteId"), "write");
    await tripService.removeTripNote(c.req.param("noteId"));
    return c.json({ ok: true });
  });

  // ---------- 天气（issue #5） ----------

  /** 按天天气预报（Open-Meteo，零 key）：仅未来约 16 天可信，超窗日期 available=false + reason */
  guarded.get("/trips/:tripId/weather", async (c) => {
    const tripId = c.req.param("tripId");
    tripReadGuard(tripId, c);
    const bundle = await tripService.getBundle(tripId);
    try {
      return c.json({ weather: await getTripWeather(bundle) });
    } catch (err) {
      // 上游整体故障不拖垮行程页：502 + 明确文案，前端按「天气暂不可用」展示
      return c.json({ error: `天气服务暂不可用：${(err as Error).message}` }, 502);
    }
  });

  // ---------- 交通段 ----------

  /** 手动覆盖交通方式（mode=null 清除覆盖恢复自动计算） */
  guarded.patch("/legs/:legId/mode", async (c) => {
    await guardLegTrip(c, c.req.param("legId"), "write");
    const input = SetLegModeInputSchema.parse(await c.req.json());
    await tripService.setLegMode(c.req.param("legId"), input.mode);
    return c.json({ ok: true });
  });

  // ---------- hotels ----------

  guarded.post("/trips/:tripId/hotel-candidates", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const input = CreateHotelCandidateInputSchema.parse(await c.req.json());
    const result = await tripService.addHotelCandidate(tripId, input, "human");
    return c.json(result, 201);
  });

  // 选定酒店：可带 checkInDay/checkOutDay（1-based 闭开区间，缺省服务端智能建议）；
  // candidateId=null 取消全部选定（兼容旧单选契约）
  guarded.post("/trips/:tripId/select-hotel", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const input = SelectHotelInputSchema.parse(await c.req.json());
    const range = await tripService.selectHotel(tripId, input.candidateId, {
      checkInDay: input.checkInDay,
      checkOutDay: input.checkOutDay,
    });
    return c.json({ ok: true, ...(range ?? {}) });
  });

  // 取消单个酒店的选定
  guarded.post("/trips/:tripId/unselect-hotel", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const input = UnselectHotelInputSchema.parse(await c.req.json());
    await tripService.unselectHotel(tripId, input.candidateId);
    return c.json({ ok: true });
  });

  guarded.get("/trips/:tripId/hotel-area", async (c) => {
    const tripId = c.req.param("tripId");
    tripReadGuard(tripId, c);
    return c.json({ area: await tripService.recommendHotelArea(tripId) });
  });

  // ---------- 顺路分析（前端直用；只读族，viewer 也可） ----------

  guarded.get("/trips/:tripId/analyze-detour", async (c) => {
    const tripId = c.req.param("tripId");
    tripReadGuard(tripId, c);
    const input = z
      .object({ placeId: z.string(), dayIndex: z.number().int().min(1) })
      .parse({ placeId: c.req.query("placeId"), dayIndex: Number(c.req.query("dayIndex")) });
    return c.json({ analysis: await tripService.analyzeDetour(tripId, input.placeId, input.dayIndex) });
  });

  guarded.get("/trips/:tripId/suggest-order", async (c) => {
    const tripId = c.req.param("tripId");
    tripReadGuard(tripId, c);
    return c.json({ suggestion: await tripService.suggestDayOrder(tripId, Number(c.req.query("dayIndex"))) });
  });

  /** 区域聚类建议（只建议不落库）：未排期地点按地理聚成 1-4 片，建议每天一片 */
  guarded.get("/trips/:tripId/suggest-clusters", async (c) => {
    const tripId = c.req.param("tripId");
    tripReadGuard(tripId, c);
    return c.json({ suggestion: await tripService.suggestDayClusters(tripId) });
  });

  // ---------- 预算 ----------

  guarded.patch("/trips/:tripId/budget", async (c) => {
    const tripId = c.req.param("tripId");
    tripWriteGuard(tripId, c);
    const input = z
      .object({
        budgetCny: z.number().nullable().optional(),
        travelerCount: z.number().int().min(1).max(20).optional(),
        currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      })
      .parse(await c.req.json());
    await tripService.updateBudget(tripId, input);
    return c.json({ ok: true });
  });

  guarded.get("/trips/:tripId/budget", async (c) => {
    const tripId = c.req.param("tripId");
    tripReadGuard(tripId, c);
    return c.json({ summary: await tripService.getBudgetSummary(tripId) });
  });

  // ---------- 设置（高德 key 等，DB 覆盖 > env） ----------

  guarded.get("/settings", (c) => {
    requireOwner(c);
    return c.json({ settings: getSettings() });
  });

  guarded.put("/settings", async (c) => {
    requireOwner(c);
    const input = UpdateSettingsInputSchema.parse(await c.req.json());
    return c.json({ settings: await updateSettings(db, input) });
  });

  // ---------- owner token 管理（issue #16：设置页生成/重置，一次展示） ----------

  /** 只报配置态；明文永不回显（DB 只存 sha256 hash） */
  guarded.get("/owner-token", (c) => {
    requireOwner(c);
    return c.json(getOwnerTokenStatus());
  });

  /** 生成/重置：token 明文仅此响应一次返回；重置后旧 token 立即失效 */
  guarded.post("/owner-token/reset", async (c) => {
    requireOwner(c);
    return c.json(await resetOwnerToken(db), 201);
  });

  // ---------- 行程访问链接管理（issue #16：owner-only，链接管理 UI 在 #17） ----------

  guarded.get("/trips/:tripId/access-links", async (c) => {
    const tripId = c.req.param("tripId");
    requireOwner(c); // 链接列表含 token 明文，绝不下发给 guest
    return c.json({ links: await tripService.listAccessLinks(tripId) });
  });

  guarded.post("/trips/:tripId/access-links", async (c) => {
    const tripId = c.req.param("tripId");
    requireOwner(c);
    const input = CreateAccessLinkInputSchema.parse(await c.req.json());
    return c.json({ link: await tripService.createAccessLink(tripId, input) }, 201);
  });

  guarded.patch("/access-links/:linkId", async (c) => {
    requireOwner(c);
    const input = UpdateAccessLinkInputSchema.parse(await c.req.json());
    return c.json({ link: await tripService.updateAccessLink(c.req.param("linkId"), input) });
  });

  /** 吊销链接（软删终态）：持该 token 的同伴下次请求即 401 */
  guarded.delete("/access-links/:linkId", async (c) => {
    requireOwner(c);
    await tripService.revokeAccessLink(c.req.param("linkId"));
    return c.json({ ok: true });
  });

  // ---------- agent 注册 CRUD（owner-only：POST 可 spawn 任意子进程，RCE 面） ----------

  guarded.get("/agents", async (c) => {
    requireOwner(c);
    const rows = await db
      .select()
      .from(schema.agentRegistry)
      .orderBy(asc(schema.agentRegistry.createdAt));
    // 单机自托管：设置页需要编辑 command/args，完整字段出 API（前端按 enabled 过滤可选 agent）
    return c.json({ agents: rows.map(toAgentDto) });
  });

  /** 检测各注册 agent 的 command 在本机是否可用（增强 PATH 搜索，GUI/sidecar 极简 PATH 也能找到用户级 CLI） */
  guarded.get("/agents/detect", async (c) => {
    requireOwner(c);
    const rows = await db
      .select()
      .from(schema.agentRegistry)
      .orderBy(asc(schema.agentRegistry.createdAt));
    const agents: AgentAvailability[] = await Promise.all(
      rows.map(async (row) => ({
        ...toAgentDto(row),
        available: (await findExecutable(row.command)) !== null,
      })),
    );
    return c.json({ agents });
  });

  guarded.post("/agents", async (c) => {
    requireOwner(c);
    const input = CreateAgentInputSchema.parse(await c.req.json());
    const [row] = await db
      .insert(schema.agentRegistry)
      .values({ id: crypto.randomUUID(), ...input })
      .returning();
    return c.json({ agent: toAgentDto(row) }, 201);
  });

  guarded.patch("/agents/:agentId", async (c) => {
    requireOwner(c);
    const input = UpdateAgentInputSchema.parse(await c.req.json());
    const patch: Partial<typeof schema.agentRegistry.$inferInsert> = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.command !== undefined) patch.command = input.command;
    if (input.args !== undefined) patch.args = input.args;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const [row] = await db
      .update(schema.agentRegistry)
      .set(patch)
      .where(eq(schema.agentRegistry.id, c.req.param("agentId")))
      .returning();
    if (!row) return c.json({ error: "agent not found" }, 404);
    return c.json({ agent: toAgentDto(row) });
  });

  guarded.delete("/agents/:agentId", async (c) => {
    requireOwner(c);
    const agentId = c.req.param("agentId");
    const [existing] = await db
      .select()
      .from(schema.agentRegistry)
      .where(eq(schema.agentRegistry.id, agentId));
    if (!existing) return c.json({ error: "agent not found" }, 404);
    // 有历史会话引用的 agent 只停用不删除（保留会话记录里的 label 快照可用）
    const [used] = await db
      .select({ id: schema.chatSessions.id })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.agentRegistryId, agentId))
      .limit(1);
    if (used) {
      await db
        .update(schema.agentRegistry)
        .set({ enabled: false })
        .where(eq(schema.agentRegistry.id, agentId));
      return c.json({ ok: true, disabled: true });
    }
    await db.delete(schema.agentRegistry).where(eq(schema.agentRegistry.id, agentId));
    return c.json({ ok: true, disabled: false });
  });

  // ---------- chat sessions（owner-only：agent 面板对同伴不可见，整个会话族不暴露给 guest） ----------

  guarded.get("/trips/:tripId/chat-sessions", async (c) => {
    requireOwner(c);
    const rows = await db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.tripId, c.req.param("tripId")))
      .orderBy(asc(schema.chatSessions.createdAt));
    return c.json({ sessions: rows.map(toChatSessionDto) });
  });

  guarded.post("/trips/:tripId/chat-sessions", async (c) => {
    requireOwner(c);
    const tripId = c.req.param("tripId");
    const input = z.object({ agentId: z.string() }).parse(await c.req.json());
    const [agent] = await db.select().from(schema.agentRegistry).where(eq(schema.agentRegistry.id, input.agentId));
    if (!agent) return c.json({ error: "agent not found" }, 404);
    // 被停用（DELETE 降级或设置页关闭）的 agent 不可再开新会话
    if (!agent.enabled) return c.json({ error: `agent「${agent.label}」已停用，请先在设置页启用` }, 409);

    const [row] = await db
      .insert(schema.chatSessions)
      .values({
        id: crypto.randomUUID(),
        tripId,
        agentRegistryId: agent.id,
        agentLabel: agent.label,
        status: "starting",
      })
      .returning();

    // 异步拉起 agent 子进程；失败记到 status/lastError
    void sessions
      .startSession(row)
      .catch(async (err) => {
        await db
          .update(schema.chatSessions)
          .set({ status: "error", lastError: (err as Error).message, updatedAt: new Date() })
          .where(eq(schema.chatSessions.id, row.id));
      });

    return c.json({ session: toChatSessionDto(row) }, 201);
  });

  guarded.get("/chat-sessions/:sessionId/messages", async (c) => {
    requireOwner(c);
    // keyset 分页：缺省取最新一页；?beforeSeq=&limit= 向更早翻页（「加载更早」）
    const query = ChatMessagesQuerySchema.parse(c.req.query());
    const page = await listChatMessages(db, c.req.param("sessionId"), query);
    return c.json(page);
  });

  /**
   * 懒恢复：句柄缺失（server 重启）或残留但进程已死（status=error）时重建会话，
   * 成功返回 handle；失败把 status=error/lastError 落库并抛错，由调用方组装响应。
   * cause 区分触发来源：auto=prompt 触发的自动重连，manual=reconnect 端点的手动重连，
   * 落库文案据此区分（此前手动重连失败也写成「自动重连失败」，误导排查）。
   */
  async function recoverSession(
    row: typeof schema.chatSessions.$inferSelect,
    cause: "auto" | "manual" = "auto",
  ) {
    if (row.status === "closed") throw new Error("会话已关闭，请新建会话");
    let handle = sessions.get(row.id);
    if (handle && row.status === "error") {
      // 进程已死但句柄残留（agent 崩溃只置了 status）：先停掉再重建。
      // final 必须传 error 过渡态而非默认 closed——closed 是终态，setStatus 守卫会挡住
      // 随后新句柄 start() 的 starting/idle 写入，会话永久卡 closed（复审 P1）
      await sessions.stopSession(row.id, "recover after error", { status: "error" }).catch(() => {});
      handle = undefined;
    }
    if (handle) return handle;
    try {
      return await sessions.ensureSession(row);
    } catch (err) {
      const message = (err as Error).message;
      // status != 'closed' 条件写：与用户并发 close（DELETE 端点）的落库存在竞态，
      // 无条件回写会把已关闭会话「复活」成 error
      await db
        .update(schema.chatSessions)
        .set({
          status: "error",
          lastError: `${cause === "manual" ? "手动" : "自动"}重连失败：${message}`,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.chatSessions.id, row.id), ne(schema.chatSessions.status, "closed")));
      throw err;
    }
  }

  guarded.post("/chat-sessions/:sessionId/prompt", async (c) => {
    requireOwner(c);
    const sessionId = c.req.param("sessionId");
    const input = z.object({ text: z.string().min(1).max(20000) }).parse(await c.req.json());
    const [row] = await db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, sessionId));
    if (!row) return c.json({ error: "session not found" }, 404);
    if (row.status === "closed") return c.json({ error: "会话已关闭，请新建会话" }, 409);
    if (row.status === "running") return c.json({ error: "agent 正在处理上一条消息" }, 409);
    let handle;
    try {
      handle = await recoverSession(row, "auto");
    } catch (err) {
      return c.json({ error: `agent 连接已断开，自动重连失败：${(err as Error).message}。可点「重新连接」重试。` }, 409);
    }
    // 异步执行：SSE 推流式消息
    void handle
      .enqueuePrompt(input.text)
      .catch((err) => console.warn(`[api] enqueuePrompt ${sessionId} failed:`, err));
    return c.json({ ok: true });
  });

  /** 手动重连（前端「重新连接」按钮）：与 prompt 的懒恢复同路径，但不携带消息 */
  guarded.post("/chat-sessions/:sessionId/reconnect", async (c) => {
    requireOwner(c);
    const sessionId = c.req.param("sessionId");
    const [row] = await db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, sessionId));
    if (!row) return c.json({ error: "session not found" }, 404);
    try {
      await recoverSession(row, "manual");
    } catch (err) {
      return c.json({ error: `重连失败：${(err as Error).message}` }, 409);
    }
    const [updated] = await db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, sessionId));
    return c.json({ ok: true, session: toChatSessionDto(updated) });
  });

  guarded.post("/chat-sessions/:sessionId/permissions/:requestId", async (c) => {
    requireOwner(c);
    const sessionId = c.req.param("sessionId");
    const requestId = c.req.param("requestId");
    const input = z
      .object({ optionId: z.string().nullable() })
      .parse(await c.req.json());
    const handle = sessions.get(sessionId);
    // 停靠的 permission 随旧进程消亡，懒恢复也找不回这个 requestId——给可操作的指引而不是裸 409
    if (!handle) {
      return c.json(
        { error: "会话连接已断开，该权限请求已失效。请重新发送消息（会自动重连 agent），或点「重新连接」。" },
        409,
      );
    }
    const ok = handle.userDecidesPermission(requestId, {
      optionId: input.optionId,
      optionName: input.optionId ? "手动允许" : "手动拒绝",
      autoApproved: false,
    });
    return c.json({ ok });
  });

  guarded.post("/chat-sessions/:sessionId/allow-all", async (c) => {
    requireOwner(c);
    const sessionId = c.req.param("sessionId");
    const input = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    await db
      .update(schema.chatSessions)
      .set({ allowAllPermissions: input.enabled, updatedAt: new Date() })
      .where(eq(schema.chatSessions.id, sessionId));
    return c.json({ ok: true });
  });

  /** 前端把 UI 选中态回写（agent 经 get_trip_context 的 userUiContext 实时读） */
  guarded.post("/chat-sessions/:sessionId/ui-context", async (c) => {
    requireOwner(c);
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json();
    await db
      .update(schema.chatSessions)
      .set({ uiContext: body, updatedAt: new Date() })
      .where(eq(schema.chatSessions.id, sessionId));
    return c.json({ ok: true });
  });

  guarded.delete("/chat-sessions/:sessionId", async (c) => {
    requireOwner(c);
    const sessionId = c.req.param("sessionId");
    await sessions.stopSession(sessionId, "user closed");
    return c.json({ ok: true });
  });

  // ---------- guard 区挂载（所有受保护端点注册完毕后） ----------

  api.route("/", guarded);

  // ---------- 鉴权辅助（createApi 闭包内，共享 db） ----------

  /**
   * SSE 鉴权（公开区专用）：EventSource 不能带自定义 header，token 走 ?token= query param。
   * 手动解析身份（公开区不挂 principalMiddleware）：
   *   - ?token=（或 Authorization Bearer，curl 调试用）无效/已吊销 → 401 JSON（与 Bearer 路径同语义）
   *   - 无 token：loopback → owner（存量 EventSource 直连零变化）；远程匿名 → 401
   *   - 带 token 一律按 token 身份处理，不因 loopback 静默升为 owner（与 REST 路径同一规则）
   * kind="owner"：owner-only 事件流（chat-sessions——agent 面板对同伴不可见）；
   * kind="trip"：行程事件流，owner / 本行程 viewer+editor 放行。
   * 返回 null = 放行；否则返回 401/403 JSON 响应（调用处直接 return——EventSource 收到
   * 非 2xx 会触发 onerror，前端按连接失败处理）。
   */
  async function sseAuth(c: Parameters<typeof resolvePrincipal>[0], tripId: string | null, kind: "trip" | "owner"): Promise<Response | null> {
    const queryToken = c.req.query("token")?.trim();
    let principal: Awaited<ReturnType<typeof resolvePrincipal>>;
    try {
      // ?token= 有值就按 token 处理（tokenOverride 复用 Bearer 同一套解析规则，包括 Authorization 头被忽略）
      if (queryToken) {
        principal = await resolvePrincipal(c, db, queryToken);
      } else {
        principal = await resolvePrincipal(c, db);
      }
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    if (kind === "owner") {
      return principal.kind === "owner" ? null : c.json({ error: "仅行程主人可订阅该事件流" }, 403);
    }
    if (principal.kind === "owner") return null;
    if (principal.kind === "anonymous") return c.json({ error: "需要访问凭证" }, 401);
    if (principal.tripId !== tripId) return c.json({ error: "无权订阅该行程的事件流" }, 403);
    return null; // viewer/editor 都可订阅本行程事件流（读端点）
  }

  /**
   * 实体级端点的归属 guard：按实体 id 查行拿到 tripId，再走行程级 guard。
   * guest 拿其他行程的实体 id 调写端点 → 403（行程归属不符）；
   * 不存在的实体 → 404（与无鉴权时代的行为一致，不泄露存在性差异）。
   * 模式统一：先查行（owner 也需要——handler 本来就要查），guard 失败抛 AuthError 由
   * guarded.onError 转 401/403。
   */
  async function guardEntityTrip(
    c: Context,
    entityId: string,
    table: typeof schema.places | typeof schema.entries | typeof schema.days | typeof schema.tripNotes | typeof schema.transportLegs,
    need: "read" | "write",
  ): Promise<void> {
    const [row] = await db.select({ tripId: table.tripId }).from(table).where(eq(table.id, entityId));
    if (!row) throw new ServiceError(404, "not found");
    if (need === "write") tripWriteGuard(row.tripId, c);
    else tripReadGuard(row.tripId, c);
  }

  const guardPlaceTrip = (c: Context, id: string, need: "read" | "write") =>
    guardEntityTrip(c, id, schema.places, need);
  const guardEntryTrip = (c: Context, id: string, need: "read" | "write") =>
    guardEntityTrip(c, id, schema.entries, need);
  const guardDayTrip = (c: Context, id: string, need: "read" | "write") =>
    guardEntityTrip(c, id, schema.days, need);
  const guardNoteTrip = (c: Context, id: string, need: "read" | "write") =>
    guardEntityTrip(c, id, schema.tripNotes, need);
  const guardLegTrip = (c: Context, id: string, need: "read" | "write") =>
    guardEntityTrip(c, id, schema.transportLegs, need);

  return api;
}
