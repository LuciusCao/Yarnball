import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, asc, eq, ne } from "drizzle-orm";
import { execFile } from "node:child_process";
import { z } from "zod";
import {
  AddEntryInputSchema,
  CreateAgentInputSchema,
  CreateHotelCandidateInputSchema,
  CreatePlaceInputSchema,
  CreateTripInputSchema,
  ReorderDayInputSchema,
  SelectHotelInputSchema,
  SetLegModeInputSchema,
  SetPlaceStatusInputSchema,
  UnselectHotelInputSchema,
  UpdateAgentInputSchema,
  UpdateEntryInputSchema,
  UpdatePlaceInputSchema,
  UpdateSettingsInputSchema,
  type AgentAvailability,
} from "@yarnball/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { chatChannel, tripChannel, TRIPS_CHANNEL, type EventBus } from "../events.js";
import type { AcpSessionManager } from "../acp/sessionManager.js";
import { ServiceError, type TripService } from "../services/tripService.js";
import { getProvider } from "../services/geo.js";
import { amapConfigured, getSettings, updateSettings } from "../services/settings.js";
import { toAgentDto, toChatSessionDto } from "../services/mappers.js";
import { listChatMessages } from "../services/chatStore.js";

/**
 * REST API —— 人类直接编辑行程（与 agent 经 MCP 的编辑双入口）+ chat 会话管理 + SSE。
 * 单机自托管：不做用户体系，CORS 锁定前端 origin。
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
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400);
    // zod 入参校验失败 → 400（此前一律 500，调用方无法区分是参数错还是服务端故障）
    if (err instanceof z.ZodError) {
      return c.json({ error: err.issues.map((i) => i.message).join("; ") }, 400);
    }
    console.error("[api] unhandled:", err);
    return c.json({ error: "internal error" }, 500);
  });

  // ---------- 系统状态 ----------

  api.get("/config", (c) => {
    const s = getSettings();
    return c.json({
      amapConfigured: s.amapConfigured,
      amapJsKey: s.amapJsKey,
      amapJsSecret: s.amapJsSecret,
      activeChatSessions: sessions.size,
    });
  });

  // ---------- 城市联想（创建表单自动补全） ----------

  api.get("/city-suggest", async (c) => {
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

  api.post("/trips/:tripId/resolve-city", async (c) =>
    c.json({ trip: await tripService.reResolveCity(c.req.param("tripId")) }),
  );

  // ---------- trips ----------

  api.get("/trips", async (c) => c.json({ trips: await tripService.listTrips() }));

  api.post("/trips", async (c) => {
    const input = CreateTripInputSchema.parse(await c.req.json());
    return c.json({ trip: await tripService.createTrip(input) }, 201);
  });

  api.get("/trips/:tripId", async (c) => c.json({ bundle: await tripService.getBundle(c.req.param("tripId")) }));

  api.delete("/trips/:tripId", async (c) => {
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

  // ---------- places ----------

  api.post("/trips/:tripId/places", async (c) => {
    const input = CreatePlaceInputSchema.parse(await c.req.json());
    return c.json({ place: await tripService.createPlace(c.req.param("tripId"), input, "human") }, 201);
  });

  api.patch("/places/:placeId", async (c) => {
    const input = UpdatePlaceInputSchema.parse(await c.req.json());
    return c.json({ place: await tripService.updatePlace(c.req.param("placeId"), input) });
  });

  /** 锁定/解锁地点（候选状态机：candidate ↔ locked） */
  api.patch("/places/:placeId/status", async (c) => {
    const input = SetPlaceStatusInputSchema.parse(await c.req.json());
    return c.json({ place: await tripService.setPlaceStatus(c.req.param("placeId"), input.status) });
  });

  api.delete("/places/:placeId", async (c) => {
    await tripService.removePlace(c.req.param("placeId"));
    return c.json({ ok: true });
  });

  // ---------- search（人类手动加地点） ----------

  api.get("/trips/:tripId/search", async (c) => {
    const keyword = c.req.query("keyword") ?? "";
    if (!keyword.trim()) return c.json({ candidates: [] });
    const [trip] = await db.select().from(schema.trips).where(eq(schema.trips.id, c.req.param("tripId")));
    const provider = getProvider(trip?.geoProvider ?? "osm");
    const bias =
      trip?.cityCenterLng != null && trip?.cityCenterLat != null
        ? { lng: Number(trip.cityCenterLng), lat: Number(trip.cityCenterLat) }
        : null;
    try {
      const candidates = await provider.searchPoi(keyword, trip?.destinationCity ?? "", bias);
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
  api.post("/trips/:tripId/entries", async (c) => {
    const input = AddEntryInputSchema.parse(await c.req.json());
    const result = await tripService.addEntry(c.req.param("tripId"), input);
    return c.json(result, 201);
  });

  /** 编辑 entry：startTime/durationMin/note 通用；departTime/arriveTime/起讫点仅 transit entry */
  api.patch("/entries/:entryId", async (c) => {
    const input = UpdateEntryInputSchema.parse(await c.req.json());
    return c.json({ entry: await tripService.updateEntry(c.req.param("entryId"), input) });
  });

  api.delete("/entries/:entryId", async (c) => {
    await tripService.removeEntry(c.req.param("entryId"));
    return c.json({ ok: true });
  });

  api.post("/entries/:entryId/move", async (c) => {
    const input = z
      .object({ dayIndex: z.number().int().min(1), position: z.number().int().min(0) })
      .parse(await c.req.json());
    await tripService.moveEntry(c.req.param("entryId"), input.dayIndex, input.position);
    return c.json({ ok: true });
  });

  api.post("/trips/:tripId/days/:dayIndex/reorder", async (c) => {
    const input = ReorderDayInputSchema.parse(await c.req.json());
    await tripService.reorderDay(c.req.param("tripId"), Number(c.req.param("dayIndex")), input.entryIds);
    return c.json({ ok: true });
  });

  // ---------- 交通段 ----------

  /** 手动覆盖交通方式（mode=null 清除覆盖恢复自动计算） */
  api.patch("/legs/:legId/mode", async (c) => {
    const input = SetLegModeInputSchema.parse(await c.req.json());
    await tripService.setLegMode(c.req.param("legId"), input.mode);
    return c.json({ ok: true });
  });

  // ---------- hotels ----------

  api.post("/trips/:tripId/hotel-candidates", async (c) => {
    const input = CreateHotelCandidateInputSchema.parse(await c.req.json());
    const result = await tripService.addHotelCandidate(c.req.param("tripId"), input, "human");
    return c.json(result, 201);
  });

  // 选定酒店：可带 checkInDay/checkOutDay（1-based 闭开区间，缺省服务端智能建议）；
  // candidateId=null 取消全部选定（兼容旧单选契约）
  api.post("/trips/:tripId/select-hotel", async (c) => {
    const input = SelectHotelInputSchema.parse(await c.req.json());
    const range = await tripService.selectHotel(c.req.param("tripId"), input.candidateId, {
      checkInDay: input.checkInDay,
      checkOutDay: input.checkOutDay,
    });
    return c.json({ ok: true, ...(range ?? {}) });
  });

  // 取消单个酒店的选定
  api.post("/trips/:tripId/unselect-hotel", async (c) => {
    const input = UnselectHotelInputSchema.parse(await c.req.json());
    await tripService.unselectHotel(c.req.param("tripId"), input.candidateId);
    return c.json({ ok: true });
  });

  api.get("/trips/:tripId/hotel-area", async (c) =>
    c.json({ area: await tripService.recommendHotelArea(c.req.param("tripId")) }),
  );

  // ---------- 顺路分析（前端直用） ----------

  api.get("/trips/:tripId/analyze-detour", async (c) => {
    const input = z
      .object({ placeId: z.string(), dayIndex: z.number().int().min(1) })
      .parse({ placeId: c.req.query("placeId"), dayIndex: Number(c.req.query("dayIndex")) });
    return c.json({ analysis: await tripService.analyzeDetour(c.req.param("tripId"), input.placeId, input.dayIndex) });
  });

  api.get("/trips/:tripId/suggest-order", async (c) =>
    c.json({ suggestion: await tripService.suggestDayOrder(c.req.param("tripId"), Number(c.req.query("dayIndex"))) }),
  );

  /** 区域聚类建议（只建议不落库）：未排期地点按地理聚成 1-4 片，建议每天一片 */
  api.get("/trips/:tripId/suggest-clusters", async (c) =>
    c.json({ suggestion: await tripService.suggestDayClusters(c.req.param("tripId")) }),
  );

  // ---------- 预算 ----------

  api.patch("/trips/:tripId/budget", async (c) => {
    const input = z
      .object({
        budgetCny: z.number().nullable().optional(),
        travelerCount: z.number().int().min(1).max(20).optional(),
        currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      })
      .parse(await c.req.json());
    await tripService.updateBudget(c.req.param("tripId"), input);
    return c.json({ ok: true });
  });

  api.get("/trips/:tripId/budget", async (c) =>
    c.json({ summary: await tripService.getBudgetSummary(c.req.param("tripId")) }),
  );

  // ---------- share（只读） ----------

  api.get("/share/:token", async (c) => {
    const trip = await tripService.getTripByShareToken(c.req.param("token"));
    return c.json({ bundle: await tripService.getBundle(trip.id) });
  });

  // ---------- 设置（高德 key 等，DB 覆盖 > env） ----------

  api.get("/settings", (c) => c.json({ settings: getSettings() }));

  api.put("/settings", async (c) => {
    const input = UpdateSettingsInputSchema.parse(await c.req.json());
    return c.json({ settings: await updateSettings(db, input) });
  });

  // ---------- agent 注册 CRUD ----------

  api.get("/agents", async (c) => {
    const rows = await db
      .select()
      .from(schema.agentRegistry)
      .orderBy(asc(schema.agentRegistry.createdAt));
    // 单机自托管：设置页需要编辑 command/args，完整字段出 API（前端按 enabled 过滤可选 agent）
    return c.json({ agents: rows.map(toAgentDto) });
  });

  /** 检测各注册 agent 的 command 在本机是否可用（which） */
  api.get("/agents/detect", async (c) => {
    const rows = await db
      .select()
      .from(schema.agentRegistry)
      .orderBy(asc(schema.agentRegistry.createdAt));
    const agents: AgentAvailability[] = await Promise.all(
      rows.map(async (row) => ({
        ...toAgentDto(row),
        available: await new Promise<boolean>((resolve) =>
          execFile("which", [row.command], (err) => resolve(!err)),
        ),
      })),
    );
    return c.json({ agents });
  });

  api.post("/agents", async (c) => {
    const input = CreateAgentInputSchema.parse(await c.req.json());
    const [row] = await db
      .insert(schema.agentRegistry)
      .values({ id: crypto.randomUUID(), ...input })
      .returning();
    return c.json({ agent: toAgentDto(row) }, 201);
  });

  api.patch("/agents/:agentId", async (c) => {
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

  api.delete("/agents/:agentId", async (c) => {
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

  // ---------- chat sessions ----------

  api.get("/trips/:tripId/chat-sessions", async (c) => {
    const rows = await db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.tripId, c.req.param("tripId")))
      .orderBy(asc(schema.chatSessions.createdAt));
    return c.json({ sessions: rows.map(toChatSessionDto) });
  });

  api.post("/trips/:tripId/chat-sessions", async (c) => {
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

  api.get("/chat-sessions/:sessionId/messages", async (c) => {
    const messages = await listChatMessages(db, c.req.param("sessionId"));
    return c.json({ messages });
  });

  /**
   * 懒恢复：句柄缺失（server 重启）或残留但进程已死（status=error）时重建会话，
   * 成功返回 handle；失败把 status=error/lastError 落库并抛错，由调用方组装响应。
   */
  async function recoverSession(row: typeof schema.chatSessions.$inferSelect) {
    if (row.status === "closed") throw new Error("会话已关闭，请新建会话");
    let handle = sessions.get(row.id);
    if (handle && row.status === "error") {
      // 进程已死但句柄残留（agent 崩溃只置了 status）：先停掉再重建
      await sessions.stopSession(row.id, "recover after error").catch(() => {});
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
        .set({ status: "error", lastError: `自动重连失败：${message}`, updatedAt: new Date() })
        .where(and(eq(schema.chatSessions.id, row.id), ne(schema.chatSessions.status, "closed")));
      throw err;
    }
  }

  api.post("/chat-sessions/:sessionId/prompt", async (c) => {
    const sessionId = c.req.param("sessionId");
    const input = z.object({ text: z.string().min(1).max(20000) }).parse(await c.req.json());
    const [row] = await db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, sessionId));
    if (!row) return c.json({ error: "session not found" }, 404);
    if (row.status === "closed") return c.json({ error: "会话已关闭，请新建会话" }, 409);
    if (row.status === "running") return c.json({ error: "agent 正在处理上一条消息" }, 409);
    let handle;
    try {
      handle = await recoverSession(row);
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
  api.post("/chat-sessions/:sessionId/reconnect", async (c) => {
    const sessionId = c.req.param("sessionId");
    const [row] = await db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, sessionId));
    if (!row) return c.json({ error: "session not found" }, 404);
    try {
      await recoverSession(row);
    } catch (err) {
      return c.json({ error: `重连失败：${(err as Error).message}` }, 409);
    }
    const [updated] = await db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, sessionId));
    return c.json({ ok: true, session: toChatSessionDto(updated) });
  });

  api.post("/chat-sessions/:sessionId/permissions/:requestId", async (c) => {
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

  api.post("/chat-sessions/:sessionId/allow-all", async (c) => {
    const sessionId = c.req.param("sessionId");
    const input = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    await db
      .update(schema.chatSessions)
      .set({ allowAllPermissions: input.enabled, updatedAt: new Date() })
      .where(eq(schema.chatSessions.id, sessionId));
    return c.json({ ok: true });
  });

  /** 前端把 UI 选中态回写（agent 经 get_trip_context 的 userUiContext 实时读） */
  api.post("/chat-sessions/:sessionId/ui-context", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json();
    await db
      .update(schema.chatSessions)
      .set({ uiContext: body, updatedAt: new Date() })
      .where(eq(schema.chatSessions.id, sessionId));
    return c.json({ ok: true });
  });

  api.delete("/chat-sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    await sessions.stopSession(sessionId, "user closed");
    return c.json({ ok: true });
  });

  // ---------- SSE ----------

  api.get("/trips/:tripId/events", (c) => {
    const channels = [tripChannel(c.req.param("tripId")), TRIPS_CHANNEL];
    return streamSSE(c, async (stream) => {
      const unsubscribers = channels.map((ch) =>
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

  api.get("/chat-sessions/:sessionId/events", (c) => {
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

  return api;
}
