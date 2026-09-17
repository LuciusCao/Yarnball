/**
 * 权限矩阵测试（issue #16：多人协作地基）。
 *
 * 用 app.request(path, init, { incoming }) 直接驱动 Hono app：
 *   - incoming.socket.remoteAddress 模拟来源（127.0.0.1 = loopback owner / 192.168.1.5 = 远程），
 *     与生产 @hono/node-server 挂 env 的方式一致（见 services/auth.ts 的 remoteAddress）
 *   - Authorization: Bearer / ?token= 模拟各类凭证
 *
 * 覆盖矩阵：
 *   1. loopback 无 token：全端点照旧放行（存量单机体验零回归）
 *   2. viewer guest：行程读 200、行程写 403、跨行程 403、owner-only 403、非行程级 403
 *   3. editor guest：行程写 200、owner-only 403、非行程级 403
 *   4. 吊销后 401；无效 token 401；带 token 的 loopback 请求按 token 身份处理（不静默升 owner）
 *   5. 匿名远程：公开区 200（config/share/SSE 无 token 401）、敏感端点 401
 *   6. owner token：全端点放行（远程来源也 owner）
 *   7. SSE ?token= 与 Bearer 同规则；chat-sessions events 对 guest 403
 *   8. 老只读分享链接：GET /api/share/:token 结构不变（脱敏 bundle）
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { EventBus } from "../events.js";
import { TripService } from "../services/tripService.js";
import { AcpSessionManager } from "../acp/sessionManager.js";
import { createApi } from "./api.js";
import { initSettingsCache, resetOwnerToken } from "../services/settings.js";
import { insertMigration } from "./testMigrations.js";

// 独立内存库 + 真实迁移 SQL（含 trip_access_links 建表与回填语句）
const { db, sqlite } = createDb(":memory:");

const bus = new EventBus();
const tripService = new TripService(db, bus);
const sessions = new AcpSessionManager(db, bus);

// 与 main.ts 相同的组装方式（含 CORS，验证 preflight 不被 guard 拦截）
const api = createApi(db, bus, tripService, sessions);
const app = new Hono();
app.use("/api/*", cors({ origin: "http://localhost:15173" }));
app.route("/api", api);

/** 模拟 @hono/node-server 的请求来源（c.env.incoming.socket.remoteAddress） */
const loopback = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const remote = { incoming: { socket: { remoteAddress: "192.168.1.5" } } };

async function call(
  path: string,
  init: RequestInit = {},
  env: object = loopback,
): Promise<Response> {
  return app.request(`/api${path}`, init, env as never);
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// ---------- 测试数据（loopback owner 准备） ----------

let tripA = { id: "", shareToken: "" };
let tripB = { id: "", shareToken: "" };
let viewerToken = "";
let editorToken = "";
let editorLinkId = "";
let ownerToken = "";
let viewerPlace: { id: string; dayId?: string } | null = null;

beforeAll(async () => {
  await insertMigration(sqlite);
  await initSettingsCache(db);

  const a = await call("/trips", json({ title: "甲-权限矩阵", destinationCity: "杭州" }));
  tripA = ((await a.json()) as { trip: { id: string; shareToken: string } }).trip;
  const b = await call("/trips", json({ title: "乙-权限矩阵", destinationCity: "上海" }));
  tripB = ((await b.json()) as { trip: { id: string; shareToken: string } }).trip;

  // viewer token：用迁移回填的那条（shareToken 同值，验证老链接语义）+ 新建一条 editor 链接
  viewerToken = tripA.shareToken;
  const mk = await call(
    `/trips/${tripA.id}/access-links`,
    json({ role: "editor", label: "给测试的编辑链接" }),
  );
  const link = ((await mk.json()) as { link: { id: string; token: string } }).link;
  editorToken = link.token;
  editorLinkId = link.id;

  // owner token：走真实 resetOwnerToken（写 settings 表 + 刷缓存）
  ownerToken = (await resetOwnerToken(db)).token;

  // 在 tripA 建一个地点 + 排 day1（供写端点矩阵用）
  const p = await call(
    `/trips/${tripA.id}/places`,
    json({ name: "灵隐寺", category: "attraction", location: { lng: 120.1, lat: 30.24 } }),
  );
  viewerPlace = ((await p.json()) as { place: { id: string } }).place;
  const e = await call(
    `/trips/${tripA.id}/entries`,
    json({ entryType: "place", placeId: viewerPlace!.id, dayIndex: 1 }),
  );
  viewerPlace!.dayId = ((await e.json()) as { dayId: string }).dayId;
});

afterAll(() => {
  sessions.stopAll();
  sqlite.close();
});

// ---------- 1. loopback 无 token：存量行为零回归 ----------

describe("loopback 无 token（存量单机形态）", () => {
  it("行程列表 / bundle / 天气 / 预算读全 200", async () => {
    expect((await call("/trips")).status).toBe(200);
    expect((await call(`/trips/${tripA.id}`)).status).toBe(200);
    expect((await call(`/trips/${tripA.id}/budget`)).status).toBe(200);
  });

  it("行程写端点 200（PATCH title）", async () => {
    const res = await call(`/trips/${tripA.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "甲-权限矩阵" }),
    });
    expect(res.status).toBe(200);
  });

  it("设置 / agents / access-links 照旧可达", async () => {
    expect((await call("/settings")).status).toBe(200);
    expect((await call("/agents")).status).toBe(200);
    expect((await call(`/trips/${tripA.id}/access-links`)).status).toBe(200);
  });

  it("SSE events 无 token 可连（200，text/event-stream）", async () => {
    const res = await call(`/trips/${tripA.id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("CORS preflight 直接 204（不被 guard 拦截）", async () => {
    const res = await remoteCall("/trips", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:15173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(204);
  });
});

async function remoteCall(path: string, init: RequestInit = {}): Promise<Response> {
  return call(path, init, remote);
}

// ---------- 2. viewer guest ----------

describe("viewer guest（Bearer viewer token，loopback 来源也不升 owner）", () => {
  it("行程读端点 200：bundle / budget / hotel-area / suggest-clusters", async () => {
    expect((await call(`/trips/${tripA.id}`, { headers: bearer(viewerToken) })).status).toBe(200);
    expect((await call(`/trips/${tripA.id}/budget`, { headers: bearer(viewerToken) })).status).toBe(200);
    expect((await call(`/trips/${tripA.id}/hotel-area`, { headers: bearer(viewerToken) })).status).toBe(200);
    expect((await call(`/trips/${tripA.id}/suggest-clusters`, { headers: bearer(viewerToken) })).status).toBe(200);
  });

  it("天气 200（上游故障也只 502，不因鉴权 4xx）", async () => {
    const res = await call(`/trips/${tripA.id}/weather`, { headers: bearer(viewerToken) });
    expect([200, 502]).toContain(res.status);
  });

  it("行程写端点 403：建地点 / PATCH 行程 / budget 写 / notes 写", async () => {
    const place = await call(
      `/trips/${tripA.id}/places`,
      { ...json({ name: "湖滨", category: "other", location: { lng: 120.16, lat: 30.25 } }), headers: bearer(viewerToken) },
    );
    expect(place.status).toBe(403);
    const patch = await call(`/trips/${tripA.id}`, {
      method: "PATCH",
      headers: { ...bearer(viewerToken), "content-type": "application/json" },
      body: JSON.stringify({ title: "viewer 改名" }),
    });
    expect(patch.status).toBe(403);
    const budget = await call(`/trips/${tripA.id}/budget`, {
      method: "PATCH",
      headers: { ...bearer(viewerToken), "content-type": "application/json" },
      body: JSON.stringify({ budgetCny: 5000 }),
    });
    expect(budget.status).toBe(403);
    const note = await call(
      `/trips/${tripA.id}/notes`,
      { ...json({ category: "other", content: "viewer 不该写进" }), headers: bearer(viewerToken) },
    );
    expect(note.status).toBe(403);
  });

  it("search（editor 能力）403", async () => {
    const res = await call(`/trips/${tripA.id}/search?keyword=x`, { headers: bearer(viewerToken) });
    expect(res.status).toBe(403);
  });

  it("实体级写端点按归属校验 403（不存在的实体才 404）", async () => {
    expect(viewerPlace).toBeTruthy();
    const res = await call(`/places/${viewerPlace!.id}`, {
      method: "PATCH",
      headers: { ...bearer(viewerToken), "content-type": "application/json" },
      body: JSON.stringify({ notes: "viewer 不该改" }),
    });
    expect(res.status).toBe(403);
  });

  it("跨行程访问 403（viewer 只能看自己 tripId 的行程）", async () => {
    const res = await call(`/trips/${tripB.id}`, { headers: bearer(viewerToken) });
    expect(res.status).toBe(403);
  });

  it("owner-only 端点 403：删行程 / settings / agents / access-links / owner-token", async () => {
    expect((await call(`/trips/${tripA.id}`, { method: "DELETE", headers: bearer(viewerToken) })).status).toBe(403);
    expect((await call("/settings", { headers: bearer(viewerToken) })).status).toBe(403);
    expect((await call("/agents", { headers: bearer(viewerToken) })).status).toBe(403);
    expect((await call(`/trips/${tripA.id}/access-links`, { headers: bearer(viewerToken) })).status).toBe(403);
    expect((await call("/owner-token", { headers: bearer(viewerToken) })).status).toBe(403);
  });

  it("非行程级端点 403：行程列表 / city-suggest / chat-sessions", async () => {
    expect((await call("/trips", { headers: bearer(viewerToken) })).status).toBe(403);
    expect((await call("/city-suggest?q=杭州", { headers: bearer(viewerToken) })).status).toBe(403);
    expect((await call(`/trips/${tripA.id}/chat-sessions`, { headers: bearer(viewerToken) })).status).toBe(403);
  });

  it("SSE ?token= 可订阅本行程事件流；chat-sessions events 403", async () => {
    const res = await call(`/trips/${tripA.id}/events?token=${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const chat = await call(`/chat-sessions/any/events?token=${viewerToken}`);
    expect(chat.status).toBe(403);
  });
});

// ---------- 3. editor guest ----------

describe("editor guest（Bearer editor token）", () => {
  it("行程写端点 200：建地点 / 排天 / budget 写 / notes 写 / PATCH 行程", async () => {
    const place = await call(
      `/trips/${tripA.id}/places`,
      { ...json({ name: "editor 的点", category: "restaurant", location: { lng: 120.15, lat: 30.25 } }), headers: bearer(editorToken) },
    );
    expect(place.status).toBe(201);
    const placeId = ((await place.json()) as { place: { id: string } }).place.id;
    const entry = await call(
      `/trips/${tripA.id}/entries`,
      { ...json({ entryType: "place", placeId, dayIndex: 1 }), headers: bearer(editorToken) },
    );
    expect(entry.status).toBe(201);
    const budget = await call(`/trips/${tripA.id}/budget`, {
      method: "PATCH",
      headers: { ...bearer(editorToken), "content-type": "application/json" },
      body: JSON.stringify({ budgetCny: 8000 }),
    });
    expect(budget.status).toBe(200);
    const note = await call(
      `/trips/${tripA.id}/notes`,
      { ...json({ category: "other", content: "editor 写的注意事项" }), headers: bearer(editorToken) },
    );
    expect(note.status).toBe(201);
    const patch = await call(`/trips/${tripA.id}`, {
      method: "PATCH",
      headers: { ...bearer(editorToken), "content-type": "application/json" },
      body: JSON.stringify({ title: "甲-editor 改名" }),
    });
    expect(patch.status).toBe(200);
  });

  it("search 200（editor 能力）", async () => {
    const res = await call(`/trips/${tripA.id}/search?keyword=x`, { headers: bearer(editorToken) });
    // 关键词走真实上游可能失败，但鉴权层必须放行（200，candidates 可能为空）
    expect(res.status).toBe(200);
  });

  it("跨行程写 403（editor 只能编辑自己 tripId 的行程）", async () => {
    const res = await call(
      `/trips/${tripB.id}/places`,
      { ...json({ name: "越权", category: "other", location: { lng: 121.47, lat: 31.23 } }), headers: bearer(editorToken) },
    );
    expect(res.status).toBe(403);
  });

  it("owner-only 端点 403：删行程 / agents / access-links 管理 / owner-token", async () => {
    expect((await call(`/trips/${tripA.id}`, { method: "DELETE", headers: bearer(editorToken) })).status).toBe(403);
    expect((await call("/agents", { headers: bearer(editorToken) })).status).toBe(403);
    expect((await call(`/trips/${tripA.id}/access-links`, { headers: bearer(editorToken) })).status).toBe(403);
    expect((await call("/owner-token", { headers: bearer(editorToken) })).status).toBe(403);
    expect((await call("/settings", { headers: bearer(editorToken) })).status).toBe(403);
  });

  it("非行程级端点 403：行程列表 / city-suggest / chat-sessions", async () => {
    expect((await call("/trips", { headers: bearer(editorToken) })).status).toBe(403);
    expect((await call("/city-suggest?q=杭州", { headers: bearer(editorToken) })).status).toBe(403);
    expect((await call(`/trips/${tripA.id}/chat-sessions`, { headers: bearer(editorToken) })).status).toBe(403);
  });
});

// ---------- 4. 吊销与无效 token ----------

describe("吊销与无效 token", () => {
  it("无效 token 401（loopback 来源也不静默升 owner）", async () => {
    const res = await call(`/trips/${tripA.id}`, { headers: bearer("definitely-not-a-token") });
    expect(res.status).toBe(401);
  });

  it("吊销后 401（owner 吊销 editor 链接 → 同 token 请求 401）", async () => {
    // owner 吊销（loopback 无 token）
    const revoke = await call(`/access-links/${editorLinkId}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    // 原 editor token 立即失效；请求来自 loopback 也按 token 身份处理 → 401
    const res = await call(`/trips/${tripA.id}`, { headers: bearer(editorToken) });
    expect(res.status).toBe(401);
    // SSE ?token= 同规则
    const sse = await call(`/trips/${tripA.id}/events?token=${editorToken}`);
    expect(sse.status).toBe(401);
  });

  it("owner token 重置后旧 token 401", async () => {
    const old = ownerToken;
    const next = (await resetOwnerToken(db)).token;
    expect(old).not.toBe(next);
    // 旧 token 在远程来源 → 401（不再是 owner）
    const denied = await remoteCall("/trips", { headers: bearer(old) });
    expect(denied.status).toBe(401);
    // 新 token 在远程来源 → owner
    const ok = await remoteCall("/trips", { headers: bearer(next) });
    expect(ok.status).toBe(200);
    ownerToken = next;
  });
});

// ---------- 5. 匿名远程 ----------

describe("匿名远程（无 token，非 loopback 来源）", () => {
  it("公开区放行：config / share", async () => {
    expect((await remoteCall("/config")).status).toBe(200);
    expect((await remoteCall(`/share/${tripA.shareToken}`)).status).toBe(200);
  });

  it("敏感端点 401：行程 bundle / 列表 / agents / settings / 删行程", async () => {
    expect((await remoteCall(`/trips/${tripA.id}`)).status).toBe(401);
    expect((await remoteCall("/trips")).status).toBe(401);
    expect((await remoteCall("/agents")).status).toBe(401);
    expect((await remoteCall("/settings")).status).toBe(401);
    expect((await remoteCall(`/trips/${tripA.id}`, { method: "DELETE" })).status).toBe(401);
    // spawn 任意子进程的 RCE 面（issue 现状痛点）
    const spawn = await remoteCall("/agents", json({ label: "evil", command: "curl", args: [] }));
    expect(spawn.status).toBe(401);
  });

  it("SSE 无 token 远程 401；?token= 有效 viewer token 200", async () => {
    expect((await remoteCall(`/trips/${tripA.id}/events`)).status).toBe(401);
    const ok = await remoteCall(`/trips/${tripA.id}/events?token=${viewerToken}`);
    expect(ok.status).toBe(200);
  });
});

// ---------- 6. owner token（远程本人） ----------

describe("owner token（远程来源的 owner）", () => {
  it("全端点放行：列表 / bundle / settings / agents / access-links / owner-token 状态", async () => {
    const h = bearer(ownerToken);
    expect((await remoteCall("/trips", { headers: h })).status).toBe(200);
    expect((await remoteCall(`/trips/${tripA.id}`, { headers: h })).status).toBe(200);
    expect((await remoteCall("/settings", { headers: h })).status).toBe(200);
    expect((await remoteCall("/agents", { headers: h })).status).toBe(200);
    expect((await remoteCall(`/trips/${tripA.id}/access-links`, { headers: h })).status).toBe(200);
    expect((await remoteCall("/owner-token", { headers: h })).status).toBe(200);
  });

  it("owner token 也走 Bearer 路径：带 token 的 loopback 请求按 owner token 处理（全通）", async () => {
    const res = await call("/settings", { headers: bearer(ownerToken) });
    expect(res.status).toBe(200);
  });
});

// ---------- 7. access-links 管理端点语义（owner-only） ----------

describe("access-links 管理端点（owner-only）", () => {
  it("建 list patch revoke 全链路 + viewer 新链接", async () => {
    // 新建 viewer 链接
    const mk = await call(
      `/trips/${tripA.id}/access-links`,
      json({ role: "viewer" }),
    );
    expect(mk.status).toBe(201);
    const { link } = (await mk.json()) as { link: { id: string; token: string; label: string } };
    expect(link.token).toMatch(/^[0-9a-f]{64}$/); // 32 字节 hex
    expect(link.label).toBe("只读分享"); // 缺省 label 按角色
    // 改备注名
    const patch = await call(`/access-links/${link.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "给小红的" }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { link: { label: string } }).link.label).toBe("给小红的");
    // 列表含 token（owner 可复制）与已吊销记录
    const list = await call(`/trips/${tripA.id}/access-links`);
    const links = (await list.json()) as { links: Array<{ id: string; revokedAt: string | null }> };
    expect(links.links.some((l) => l.id === link.id)).toBe(true);
    expect(links.links.some((l) => l.revokedAt != null)).toBe(true);
    // 吊销后 token 失效
    await call(`/access-links/${link.id}`, { method: "DELETE" });
    const denied = await call(`/trips/${tripA.id}`, { headers: bearer(link.token) });
    expect(denied.status).toBe(401);
  });
});

// ---------- 8. 老 share 链接回归 ----------

describe("老只读分享链接（GET /api/share/:token）", () => {
  it("结构与脱敏不变：bundle.trip.id/shareToken 置空 + 实体 id 为 16 位别名 + budget 齐全", async () => {
    const res = await remoteCall(`/share/${tripA.shareToken}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle: {
        trip: { id: string; shareToken: string; title: string };
        places: Array<{ id: string }>;
        entries: Array<{ placeId: string | null }>;
      };
      budget: { currency: string };
    };
    expect(body.bundle.trip.id).toBe("");
    expect(body.bundle.trip.shareToken).toBe("");
    expect(body.bundle.trip.title).toBe("甲-editor 改名"); // 反映 editor 的最新修改
    expect(body.budget).toBeTruthy();
    expect(body.budget.currency).toBe("CNY");
    for (const place of body.bundle.places) {
      expect(place.id).toMatch(/^[0-9a-f]{16}$/);
    }
    // 别名一致性：entry.placeId 与 places[].id 是同一映射
    const placeIds = new Set(body.bundle.places.map((p) => p.id));
    for (const entry of body.bundle.entries) {
      if (entry.placeId) expect(placeIds.has(entry.placeId)).toBe(true);
    }
  });

  it("吊销默认只读链接后 share 404（权威数据在表）", async () => {
    // 拿到 tripA 的默认链接（token == shareToken）并吊销
    const list = await call(`/trips/${tripA.id}/access-links`);
    const { links } = (await list.json()) as { links: Array<{ id: string; token: string; revokedAt: string | null }> };
    const deflt = links.find((l) => l.token === tripA.shareToken);
    expect(deflt).toBeTruthy();
    const revoke = await call(`/access-links/${deflt!.id}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    // 老链接 URL 立即失效（remote 匿名访问 share 404）
    expect((await remoteCall(`/share/${tripA.shareToken}`)).status).toBe(404);
    // 但 viewer 语义的 Bearer 也随 token 失效
    expect((await call(`/trips/${tripA.id}`, { headers: bearer(viewerToken) })).status).toBe(401);
    // 收尾：再建一条 viewer 链接供后续断言（保持 tripA 有可用 viewer 凭证）
    const mk = await call(`/trips/${tripA.id}/access-links`, json({ role: "viewer" }));
    const { link } = (await mk.json()) as { link: { token: string } };
    viewerToken = link.token;
  });
});

// ---------- 9. last_seen 节流 ----------

describe("last_seen_at 节流", () => {
  it("鉴权成功后写入，60s 内不重复写", async () => {
    const mk = await call(`/trips/${tripB.id}/access-links`, json({ role: "viewer" }));
    const { link } = (await mk.json()) as { link: { id: string; token: string } };
    const lastSeenOf = async (): Promise<string | null> => {
      const list = await call(`/trips/${tripB.id}/access-links`);
      const { links } = (await list.json()) as { links: Array<{ id: string; lastSeenAt: string | null }> };
      return links.find((l) => l.id === link.id)?.lastSeenAt ?? null;
    };
    // 第一次请求：last_seen_at 从 null → 写入
    await call(`/trips/${tripB.id}`, { headers: bearer(link.token) });
    const seen1 = await lastSeenOf();
    expect(seen1).toBeTruthy();
    // 第二次请求（节流窗口内）：值不变（无第二次写）
    await new Promise((r) => setTimeout(r, 20));
    await call(`/trips/${tripB.id}`, { headers: bearer(link.token) });
    const seen2 = await lastSeenOf();
    expect(seen2).toBe(seen1);
  });
});

// ---------- 10. 建行程的访问链接镜像 ----------

describe("建行程即落默认 viewer 链接（shareToken 镜像模式）", () => {
  it("新行程 access-links 含一条 token == shareToken 的 viewer 记录", async () => {
    const mk = await call("/trips", json({ title: "丙-镜像", destinationCity: "南京" }));
    const trip = ((await mk.json()) as { trip: { id: string; shareToken: string } }).trip;
    const list = await call(`/trips/${trip.id}/access-links`);
    const { links } = (await list.json()) as { links: Array<{ token: string; role: string; label: string }> };
    const deflt = links.find((l) => l.token === trip.shareToken);
    expect(deflt).toBeTruthy();
    expect(deflt!.role).toBe("viewer");
    expect(deflt!.label).toBe("只读分享");
    expect((await remoteCall(`/share/${trip.shareToken}`)).status).toBe(200);
    await call(`/trips/${trip.id}`, { method: "DELETE" });
  });
});
