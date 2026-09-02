import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  AddEntryInputSchema,
  CreateHotelCandidateInputSchema,
  CreatePlaceInputSchema,
  CreateTripInputSchema,
  ReorderDayInputSchema,
  UpdatePlaceInputSchema,
} from "@odessey/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { chatChannel, tripChannel, TRIPS_CHANNEL, type EventBus } from "../events.js";
import { env } from "../env.js";
import type { AcpSessionManager } from "../acp/sessionManager.js";
import { ServiceError, type TripService } from "../services/tripService.js";
import { getProvider } from "../services/geo.js";
import { toChatSessionDto } from "../services/mappers.js";
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
    console.error("[api] unhandled:", err);
    return c.json({ error: "internal error" }, 500);
  });

  // ---------- 系统状态 ----------

  api.get("/config", (c) =>
    c.json({
      amapConfigured: env.amapConfigured,
      amapJsKey: env.amapJsKey,
      amapJsSecret: env.amapJsSecret,
      activeChatSessions: sessions.size,
    }),
  );

  // ---------- 城市联想（创建表单自动补全） ----------

  api.get("/city-suggest", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 1) return c.json({ suggestions: [] });
    // 高德可用时国内城市优先走高德（中文名更准），否则 OSM 栈（Nominatim 优先）
    const useAmap = env.amapConfigured && /[\u4e00-\u9fff]/.test(q) === false ? false : env.amapConfigured;
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
    await sessions.stopSession(tripId, "trip deleted").catch(() => {});
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

  api.post("/trips/:tripId/entries", async (c) => {
    const input = AddEntryInputSchema.parse(await c.req.json());
    const result = await tripService.addEntry(
      c.req.param("tripId"),
      input.placeId,
      input.dayIndex,
      input.position ?? null,
    );
    return c.json(result, 201);
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

  // ---------- hotels ----------

  api.post("/trips/:tripId/hotel-candidates", async (c) => {
    const input = CreateHotelCandidateInputSchema.parse(await c.req.json());
    const result = await tripService.addHotelCandidate(c.req.param("tripId"), input, "human");
    return c.json(result, 201);
  });

  api.post("/trips/:tripId/select-hotel", async (c) => {
    const input = z.object({ candidateId: z.string().nullable() }).parse(await c.req.json());
    await tripService.selectHotel(c.req.param("tripId"), input.candidateId);
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

  // ---------- share（只读） ----------

  api.get("/share/:token", async (c) => {
    const trip = await tripService.getTripByShareToken(c.req.param("token"));
    return c.json({ bundle: await tripService.getBundle(trip.id) });
  });

  // ---------- chat sessions ----------

  api.get("/agents", async (c) => {
    const rows = await db
      .select()
      .from(schema.agentRegistry)
      .where(eq(schema.agentRegistry.enabled, true))
      .orderBy(asc(schema.agentRegistry.createdAt));
    // command/args 不出 API 边界（防 RCE 信息泄露）
    return c.json({ agents: rows.map((r) => ({ id: r.id, label: r.label })) });
  });

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

  api.post("/chat-sessions/:sessionId/prompt", async (c) => {
    const sessionId = c.req.param("sessionId");
    const input = z.object({ text: z.string().min(1).max(20000) }).parse(await c.req.json());
    const [row] = await db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, sessionId));
    if (!row) return c.json({ error: "session not found" }, 404);
    const handle = sessions.get(sessionId);
    if (!handle) return c.json({ error: "session not running" }, 409);
    if (row.status === "running") return c.json({ error: "agent 正在处理上一条消息" }, 409);
    // 异步执行：SSE 推流式消息
    void handle.enqueuePrompt(input.text).catch(() => {});
    return c.json({ ok: true });
  });

  api.post("/chat-sessions/:sessionId/permissions/:requestId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = c.req.param("requestId");
    const input = z
      .object({ optionId: z.string().nullable() })
      .parse(await c.req.json());
    const handle = sessions.get(sessionId);
    if (!handle) return c.json({ error: "session not running" }, 409);
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
