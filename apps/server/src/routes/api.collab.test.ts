/**
 * 协作实时体验测试（issue #19）。
 *
 * 覆盖（风格同 api.access.test.ts / api.join.test.ts，app.request 直驱 Hono app）：
 *   1. 动态流（trip_activity）：REST 写操作（owner/guest）落库且 summary/actor 归属正确；
 *      actor_kind 三态（human/agent/guest）；REST 拉取端点新的在前；滚动保留最近 50 条
 *   2. share SSE 端点：无效 token 404；有效 token 推送的 bundle 事件脱敏（trip.id 置空、
 *      实体 id 为别名、不含真实 id 字符串）；activity 事件 tripId 脱敏
 *   3. presence：SSE 连接建立/断开广播 join/leave（含全量 viewers 名单）；
 *      owner 与 guest 的 label 口径（「主人」/昵称）；REST presence 快照端点
 *   4. share weather 公开端点：无效 token 404；有效 token 200 且响应不含真实 id
 *
 * SSE 读法：app.request 返回的 Response.body 是 ReadableStream，用 reader 逐行读事件、
 * 收到期望事件后 controller.abort() 触发 stream.onAbort（presence leave 依赖它）。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDb } from "../db/client.js";
import { EventBus } from "../events.js";
import { TripService } from "../services/tripService.js";
import { AcpSessionManager } from "../acp/sessionManager.js";
import { createApi } from "./api.js";
import { initSettingsCache } from "../services/settings.js";
import { insertMigration } from "./testMigrations.js";

// 独立内存库 + 真实迁移 SQL（含 0005 的 trip_activity 建表）
const { db, sqlite } = createDb(":memory:");

const bus = new EventBus();
const tripService = new TripService(db, bus);
const sessions = new AcpSessionManager(db, bus);

const api = createApi(db, bus, tripService, sessions);
const app = new Hono();
app.use("/api/*", cors({ origin: "http://localhost:15173" }));
app.route("/api", api);

const loopback = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`/api${path}`, init, loopback as never);
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// ---------- 测试数据 ----------

let tripId = "";
let shareToken = "";
let editorToken = "";

beforeAll(async () => {
  await insertMigration(sqlite);
  await initSettingsCache(db);

  const mk = await call("/trips", json({ title: "collab-测试行程", destinationCity: "杭州" }));
  const trip = ((await mk.json()) as { trip: { id: string; shareToken: string } }).trip;
  tripId = trip.id;
  shareToken = trip.shareToken;

  const mkLink = await call(`/trips/${tripId}/access-links`, json({ role: "editor" }));
  editorToken = ((await mkLink.json()) as { link: { token: string } }).link.token;
  // 激活填昵称（guest 的 actorLabel / presence label 来源）
  await call(`/join/${editorToken}/activate`, json({ displayName: "小红" }));
});

afterAll(() => {
  sessions.stopAll();
  sqlite.close();
});

// ---------- 1. 动态流 ----------

describe("动态流（trip_activity）", () => {
  it("owner 建地点 → 落库 actor_kind=human、summary 含主人话术；guest 写 → actor_kind=guest + 昵称", async () => {
    const ownerPlace = await call(
      `/trips/${tripId}/places`,
      json({ name: "西湖", category: "attraction", location: { lng: 120.15, lat: 30.25 } }),
    );
    expect(ownerPlace.status).toBe(201);

    const guestPlace = await call(
      `/trips/${tripId}/places`,
      {
        ...json({ name: "灵隐寺", category: "attraction", location: { lng: 120.1, lat: 30.24 } }),
        headers: bearer(editorToken),
      },
    );
    expect(guestPlace.status).toBe(201);

    const { activity } = (await (await call(`/trips/${tripId}/activity`)).json()) as {
      activity: Array<{ actorKind: string; actorLabel: string; action: string; summary: string }>;
    };
    expect(activity.length).toBeGreaterThanOrEqual(2);
    // 新的在前：最后一条写的是 guest 的
    const guestEntry = activity[0];
    expect(guestEntry.actorKind).toBe("guest");
    expect(guestEntry.actorLabel).toBe("小红");
    expect(guestEntry.action).toBe("place_added");
    expect(guestEntry.summary).toBe("小红 添加了地点 灵隐寺");
    const ownerEntry = activity.find((a) => a.summary.includes("西湖"));
    expect(ownerEntry?.actorKind).toBe("human");
    expect(ownerEntry?.summary).toBe("主人 添加了地点 西湖");
  });

  it("agent actor（service 层直调）→ actor_kind=agent + 「agent」标签", async () => {
    await tripService.createPlace(
      tripId,
      {
        name: "千岛湖",
        category: "attraction",
        location: { lng: 119.0, lat: 29.6 },
        sourceType: "manual",
        status: "candidate",
      },
      "agent",
    );
    const { activity } = (await (await call(`/trips/${tripId}/activity`)).json()) as {
      activity: Array<{ actorKind: string; summary: string }>;
    };
    expect(activity[0].actorKind).toBe("agent");
    expect(activity[0].summary).toBe("agent 添加了地点 千岛湖");
  });

  it("排日程 / 删除地点也记录动态（entry_added / place_removed）", async () => {
    const place = (await (await call(
      `/trips/${tripId}/places`,
      json({ name: "雷峰塔", category: "attraction", location: { lng: 120.15, lat: 30.23 } }),
    )).json()) as { place: { id: string } };
    await call(`/trips/${tripId}/entries`, json({ placeId: place.place.id, dayIndex: 1 }));
    const mid = (await (await call(`/trips/${tripId}/activity`)).json()) as {
      activity: Array<{ action: string; summary: string }>;
    };
    expect(mid.activity[0].action).toBe("entry_added");
    expect(mid.activity[0].summary).toBe("主人 排了日程 雷峰塔");

    await call(`/places/${place.place.id}`, { method: "DELETE" });
    const after = (await (await call(`/trips/${tripId}/activity`)).json()) as {
      activity: Array<{ action: string; summary: string }>;
    };
    expect(after.activity[0].action).toBe("place_removed");
    expect(after.activity[0].summary).toBe("主人 删除了地点 雷峰塔");
  });

  it("滚动保留最近 50 条（超删旧）", async () => {
    // 直接 service 层灌 55 条（每条一个地点创建，走真实 recordActivity 路径）
    for (let i = 0; i < 55; i++) {
      await tripService.createPlace(
        tripId,
        {
          name: `批量-${String(i).padStart(3, "0")}`,
          category: "other",
          location: { lng: 120.15, lat: 30.25 },
          allowDuplicate: true,
          sourceType: "manual",
          status: "candidate",
        },
        "human",
      );
    }
    const { activity } = (await (await call(`/trips/${tripId}/activity`)).json()) as {
      activity: Array<{ summary: string }>;
    };
    expect(activity.length).toBe(TripService.ACTIVITY_KEEP);
    // 最旧的超限行被删：最新的第一条是「批量-054」
    expect(activity[0].summary).toContain("批量-054");
    expect(activity.some((a) => a.summary.includes("批量-000"))).toBe(false);
  });

  it("activity 读端点权限：guest（editor）可读本行程；匿名远程 401", async () => {
    const guest = await call(`/trips/${tripId}/activity`, { headers: bearer(editorToken) });
    expect(guest.status).toBe(200);
    // 远程匿名（无 loopback 优惠）
    const remote = await app.request(
      `/api/trips/${tripId}/activity`,
      {},
      { incoming: { socket: { remoteAddress: "192.168.1.9" } } } as never,
    );
    expect(remote.status).toBe(401);
  });
});

// ---------- SSE 读取工具 ----------

interface SseSession {
  events: unknown[];
  close: () => Promise<void>;
  /** 等待服务端主动关流（读循环 done）；timeout 毫秒后 resolve(false) */
  waitForClose: (timeout: number) => Promise<boolean>;
  /** 连接响应（断言状态码用） */
  res?: Response;
}

/** 打开一个 SSE 订阅并开始收集事件（读到期望数量或超时后可关闭） */
async function openSse(path: string): Promise<{ res: Response; session: SseSession }> {
  const controller = new AbortController();
  const res = await app.request(`/api${path}`, { signal: controller.signal }, loopback as never);
  if (!res.ok || !res.body)
    return {
      res,
      session: { events: [], close: async () => {}, waitForClose: async () => false, res },
    };
  const events: unknown[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 帧以空行分隔；data: 行取 JSON
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              if (data) {
                try {
                  events.push(JSON.parse(data));
                } catch {
                  // 非 JSON（如 ping 的空 data）忽略
                }
              }
            }
          }
        }
      }
    } catch {
      // abort 后的读异常是正常退出
    }
  })();
  const session: SseSession = {
    events,
    res,
    waitForClose: (timeout: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeout);
        pump.then(() => {
          clearTimeout(timer);
          resolve(true);
        }).catch(() => {
          clearTimeout(timer);
          resolve(true);
        });
      }),
    close: async () => {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // 已取消
      }
      await pump.catch(() => {});
    },
  };
  return { res, session };
}

/** 等待 events 里出现满足谓词的事件（超时抛错） */
async function waitFor(events: unknown[], pred: (e: unknown) => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (events.some(pred)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("等待 SSE 事件超时");
}

const eventType = (t: string) => (e: unknown) => (e as { type?: string })?.type === t;

// ---------- 2. share SSE 端点（鉴权 + 脱敏） ----------

describe("GET /share/:token/events（鉴权与脱敏）", () => {
  it("无效 token 404", async () => {
    const res = await call("/share/not-a-real-token/events");
    expect(res.status).toBe(404);
  });

  it("推送的 bundle 事件脱敏：trip.id 置空、实体 id 为别名、不含真实 id", async () => {
    const { res, session } = await openSse(`/share/${shareToken}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // 触发一次写操作（owner 建地点）→ share 频道应收到脱敏 bundle
    await call(
      `/trips/${tripId}/places`,
      json({ name: "脱敏验证点", category: "other", location: { lng: 120.15, lat: 30.25 }, allowDuplicate: true }),
    );
    await waitFor(session.events, eventType("bundle"));

    const bundleEvent = session.events.find(eventType("bundle")) as {
      bundle: { trip: { id: string; shareToken: string }; places: Array<{ id: string; tripId: string; name: string }> };
    };
    expect(bundleEvent.bundle.trip.id).toBe("");
    expect(bundleEvent.bundle.trip.shareToken).toBe("");
    const raw = JSON.stringify(bundleEvent);
    expect(raw).not.toContain(tripId);
    const added = bundleEvent.bundle.places.find((p) => p.name === "脱敏验证点");
    expect(added).toBeTruthy();
    // 实体 id 是别名（16 位 hex），不等于真实 UUID
    expect(added!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(added!.tripId).toMatch(/^[0-9a-f]{16}$/);
    await session.close();
  });

  it("推送的 activity 事件 tripId 脱敏为别名", async () => {
    const { session } = await openSse(`/share/${shareToken}/events`);
    await call(
      `/trips/${tripId}/places`,
      json({ name: "activity 脱敏点", category: "other", location: { lng: 120.15, lat: 30.25 }, allowDuplicate: true }),
    );
    await waitFor(session.events, eventType("activity"));
    const activityEvent = session.events.find(eventType("activity")) as {
      activity: { tripId: string; summary: string };
    };
    expect(activityEvent.activity.tripId).toMatch(/^[0-9a-f]{16}$/);
    expect(activityEvent.activity.tripId).not.toBe(tripId);
    expect(activityEvent.activity.summary).toContain("activity 脱敏点");
    await session.close();
  });

  // 评审 P0-1 回归锁：跨行程事件（created，含其他行程 shareToken）绝不能流入 share 流
  it("其他行程的 created/deleted 事件不外泄（TRIPS_CHANNEL 不进 share 流）", async () => {
    const { session } = await openSse(`/share/${shareToken}/events`);
    // owner 新建另一个行程 + 删除它：TRIPS_CHANNEL 会广播 created/deleted（含该行程 DTO 与 shareToken）
    const mk = await call("/trips", json({ title: "其他行程", destinationCity: "上海" }));
    const other = ((await mk.json()) as { trip: { id: string; shareToken: string } }).trip;
    await call(`/trips/${other.id}`, { method: "DELETE" });
    // 等本行程频道静默一小段（created/deleted 走 TRIPS_CHANNEL，若误订阅此刻已写入）
    await new Promise((r) => setTimeout(r, 300));
    const raw = JSON.stringify(session.events);
    expect(raw).not.toContain(other.id);
    expect(raw).not.toContain(other.shareToken);
    expect(session.events.some(eventType("created"))).toBe(false);
    await session.close();
  });

  // 评审 P0-1 回归锁：guest 的 trips events 流同样不得收到跨行程事件
  it("guest SSE 流不外泄其他行程事件（未脱敏直转路径）", async () => {
    const { session } = await openSse(`/trips/${tripId}/events?token=${editorToken}`);
    expect(session.res?.status ?? 200).toBe(200);
    const mk = await call("/trips", json({ title: "另一行程", destinationCity: "北京" }));
    const other = ((await mk.json()) as { trip: { id: string; shareToken: string } }).trip;
    await call(`/trips/${other.id}`, { method: "DELETE" });
    await new Promise((r) => setTimeout(r, 300));
    const raw = JSON.stringify(session.events);
    expect(raw).not.toContain(other.id);
    expect(raw).not.toContain(other.shareToken);
    expect(session.events.some(eventType("created"))).toBe(false);
    await session.close();
  });
});

// ---------- 3. presence ----------

describe("presence（在线名单）", () => {
  it("SSE 连接建立广播 join（owner=「主人」、guest=昵称）；断开广播 leave；快照端点一致", async () => {
    // owner 一条 + guest 一条并发订阅
    const owner = await openSse(`/trips/${tripId}/events`);
    expect(owner.res.status).toBe(200);
    await waitFor(owner.session.events, eventType("presence"));
    const first = owner.session.events.find(eventType("presence")) as {
      presence: { kind: string; entry: { label: string; kind: string }; viewers: Array<{ label: string }> };
    };
    expect(first.presence.kind).toBe("join");
    expect(first.presence.entry.label).toBe("主人");
    expect(first.presence.entry.kind).toBe("human");

    const guest = await openSse(`/trips/${tripId}/events?token=${editorToken}`);
    expect(guest.res.status).toBe(200);
    await waitFor(owner.session.events, (e) => {
      const p = (e as { type?: string; presence?: { entry?: { label?: string } } })?.presence;
      return (e as { type?: string })?.type === "presence" && p?.entry?.label === "小红";
    });
    // owner 侧能看到 guest 上线后的全量名单
    const afterJoin = [...owner.session.events]
      .reverse()
      .find(
        (e) =>
          (e as { type?: string }).type === "presence" &&
          (e as { presence: { entry: { label: string } } }).presence.entry.label === "小红",
      ) as { presence: { kind: string; viewers: Array<{ label: string }> } };
    expect(afterJoin.presence.kind).toBe("join");
    const labels = afterJoin.presence.viewers.map((v) => v.label);
    expect(labels).toContain("主人");
    expect(labels).toContain("小红");

    // REST 快照（owner 凭 loopback）：两条连接都在册
    const snap = (await (await call(`/trips/${tripId}/presence`)).json()) as {
      viewers: Array<{ label: string }>;
    };
    expect(snap.viewers.filter((v) => v.label === "主人").length).toBe(1);
    expect(snap.viewers.filter((v) => v.label === "小红").length).toBe(1);

    // guest 断开 → owner 收到 leave
    await guest.session.close();
    await waitFor(owner.session.events, (e) => {
      const typed = e as { type?: string; presence?: { kind?: string; entry?: { label?: string } } };
      return typed.type === "presence" && typed.presence?.kind === "leave" && typed.presence?.entry?.label === "小红";
    });
    // owner 断开收尾
    await owner.session.close();
  });

  it("presence 快照端点权限：guest 可读、匿名远程 401", async () => {
    const guest = await call(`/trips/${tripId}/presence`, { headers: bearer(editorToken) });
    expect(guest.status).toBe(200);
    const remote = await app.request(
      `/api/trips/${tripId}/presence`,
      {},
      { incoming: { socket: { remoteAddress: "192.168.1.9" } } } as never,
    );
    expect(remote.status).toBe(401);
  });
});

// ---------- 4. share weather 公开端点 ----------

describe("GET /share/:token/weather（公开端点）", () => {
  it("无效 token 404；有效 token 200 且响应不含真实 tripId", async () => {
    expect((await call("/share/not-a-real-token/weather")).status).toBe(404);

    const res = await call(`/share/${shareToken}/weather`);
    // 上游 Open-Meteo 不可达时 502（也是合法行为：公开区语义正确，不泄数据）；只断言非 401/403/500
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toContain(tripId);
      expect(raw).not.toContain("shareToken");
    }
  });
});

// ---------- 5. 吊销即断流（Codex P1，放最后：本用例会吊销 editorToken 使其失效） ----------

describe("吊销链接切断已建立的 SSE 流", () => {
  it("revoked 事件后服务端主动关流（guest 流不再收到后续 bundle）", async () => {
    const { session } = await openSse(`/trips/${tripId}/events?token=${editorToken}`);
    expect(session.res?.status ?? 200).toBe(200);
    await waitFor(session.events, eventType("presence"));
    // 找到 editorToken 对应的 link id（列表端点 owner-only，loopback 直调）
    const { links } = (await (await call(`/trips/${tripId}/access-links`)).json()) as {
      links: Array<{ token: string; id: string }>;
    };
    const link = links.find((l) => l.token === editorToken);
    expect(link).toBeTruthy();
    await call(`/access-links/${link!.id}`, { method: "DELETE" });
    // 服务端应主动关流：读流在有限时间内结束（而非持续挂着收后续 bundle）
    const closed = await session.waitForClose(3000);
    expect(closed).toBe(true);
    // 吊销后的新订阅也被拒（REST 侧已有用例，这里补 SSE 侧）
    const retry = await openSse(`/trips/${tripId}/events?token=${editorToken}`);
    expect(retry.res.status).toBe(401);
  });
});
