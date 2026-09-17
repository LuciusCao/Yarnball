/**
 * 同伴入口 join 端点测试（issue #18）。
 *
 * 覆盖（风格同 api.access.test.ts，app.request 直驱 Hono app）：
 *   1. info：有效链接返回标题/角色/已填昵称，且不泄 bundle/tripId/owner 信息
 *   2. activate：写昵称 + last_seen_at，返回 tripId/role/displayName；
 *      重复激活（改昵称重进）覆盖 displayName
 *   3. 无效 token：info/activate 均 404 + code=join_link_not_found
 *   4. 已吊销：info/activate 均 410 + code=join_link_revoked
 *   5. 昵称校验：空串/全空白/超长 → 400
 *   6. activate 后的 token 即 Bearer 凭证：editor 拿真实 bundle 可写、viewer 读 200 写 403
 *   7. 默认分享链接（token == shareToken）也能走 join 流程（viewer 语义）
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

// 独立内存库 + 真实迁移 SQL（与 api.access.test.ts 同款组装方式）
const { db, sqlite } = createDb(":memory:");

const bus = new EventBus();
const tripService = new TripService(db, bus);
const sessions = new AcpSessionManager(db, bus);

const api = createApi(db, bus, tripService, sessions);
const app = new Hono();
app.use("/api/*", cors({ origin: "http://localhost:15173" }));
app.route("/api", api);

/** join 端点在公开区，来源无关紧要（token 即凭证）；loopback 模拟与生产桌面形态一致 */
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

// ---------- 测试数据（loopback owner 准备） ----------

let tripId = "";
let shareToken = "";
let editorToken = "";

beforeAll(async () => {
  await insertMigration(sqlite);
  await initSettingsCache(db);

  const mk = await call("/trips", json({ title: "join-测试行程", destinationCity: "杭州" }));
  const trip = ((await mk.json()) as { trip: { id: string; shareToken: string } }).trip;
  tripId = trip.id;
  shareToken = trip.shareToken;

  const mkLink = await call(
    `/trips/${tripId}/access-links`,
    json({ role: "editor", label: "给同伴的编辑链接" }),
  );
  editorToken = ((await mkLink.json()) as { link: { token: string } }).link.token;
});

afterAll(() => {
  sessions.stopAll();
  sqlite.close();
});

// ---------- 1. info：有效链接 ----------

describe("GET /join/:token/info（有效链接）", () => {
  it("返回标题/角色/未填昵称；不含 tripId 与 bundle", async () => {
    const res = await call(`/join/${editorToken}/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tripTitle: string;
      role: string;
      displayName: string | null;
    };
    expect(body.tripTitle).toBe("join-测试行程");
    expect(body.role).toBe("editor");
    expect(body.displayName).toBeNull();
    // 不泄真实 tripId / bundle / owner 信息：响应里不应出现这些键
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(tripId);
    expect(raw).not.toContain("bundle");
    expect(raw).not.toContain("places");
  });

  it("默认分享链接（token == shareToken）也返回 viewer 语义", async () => {
    const res = await call(`/join/${shareToken}/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("viewer");
  });
});

// ---------- 2. activate ----------

describe("POST /join/:token/activate", () => {
  it("写昵称返回 tripId/role/displayName，info 反映已填昵称，last_seen_at 落库", async () => {
    const res = await call(`/join/${editorToken}/activate`, json({ displayName: "小明" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tripId: string;
      role: string;
      displayName: string;
    };
    expect(body.tripId).toBe(tripId);
    expect(body.role).toBe("editor");
    expect(body.displayName).toBe("小明");

    // info 能看到已填昵称（改昵称重进的预填值）
    const info = (await (await call(`/join/${editorToken}/info`)).json()) as {
      displayName: string | null;
    };
    expect(info.displayName).toBe("小明");

    // last_seen_at 落库（owner 视角的链接列表）
    const list = await call(`/trips/${tripId}/access-links`);
    const { links } = (await list.json()) as {
      links: Array<{ token: string; displayName: string | null; lastSeenAt: string | null }>;
    };
    const link = links.find((l) => l.token === editorToken);
    expect(link?.displayName).toBe("小明");
    expect(link?.lastSeenAt).toBeTruthy();
  });

  it("重复激活（改昵称重进）覆盖 displayName", async () => {
    const res = await call(`/join/${editorToken}/activate`, json({ displayName: "小明二号" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { displayName: string }).displayName).toBe("小明二号");
  });
});

// ---------- 3. 无效 token ----------

describe("无效 token", () => {
  it("info 404 + code=join_link_not_found", async () => {
    const res = await call("/join/definitely-not-a-token/info");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("join_link_not_found");
  });

  it("activate 404 + code=join_link_not_found", async () => {
    const res = await call("/join/definitely-not-a-token/activate", json({ displayName: "小明" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("join_link_not_found");
  });
});

// ---------- 4. 已吊销 ----------

describe("已吊销链接", () => {
  it("info/activate 均 410 + code=join_link_revoked（与无效 404 可区分）", async () => {
    // owner 新建一条 viewer 链接后吊销
    const mk = await call(`/trips/${tripId}/access-links`, json({ role: "viewer" }));
    const { link } = (await mk.json()) as { link: { id: string; token: string } };
    const revoke = await call(`/access-links/${link.id}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);

    const info = await call(`/join/${link.token}/info`);
    expect(info.status).toBe(410);
    expect(((await info.json()) as { code: string }).code).toBe("join_link_revoked");

    const activate = await call(`/join/${link.token}/activate`, json({ displayName: "小明" }));
    expect(activate.status).toBe(410);
    expect(((await activate.json()) as { code: string }).code).toBe("join_link_revoked");
  });
});

// ---------- 5. 昵称校验 ----------

describe("昵称校验", () => {
  it("空串 / 全空白 / 超长 → 400", async () => {
    expect((await call(`/join/${editorToken}/activate`, json({ displayName: "" }))).status).toBe(400);
    expect((await call(`/join/${editorToken}/activate`, json({ displayName: "   " }))).status).toBe(400);
    expect(
      (await call(`/join/${editorToken}/activate`, json({ displayName: "a".repeat(31) }))).status,
    ).toBe(400);
  });

  it("缺字段 / 非法类型 → 400", async () => {
    expect((await call(`/join/${editorToken}/activate`, json({}))).status).toBe(400);
    expect((await call(`/join/${editorToken}/activate`, json({ displayName: 42 }))).status).toBe(400);
  });
});

// ---------- 6. activate 后的 token 即 Bearer 凭证 ----------

describe("激活后的 token 与 Bearer 鉴权同源（#16 地基的衔接）", () => {
  it("editor token：拿真实 bundle（真实 tripId）且可写地点", async () => {
    await call(`/join/${editorToken}/activate`, json({ displayName: "小明" }));
    const bundle = await call(`/trips/${tripId}`, { headers: bearer(editorToken) });
    expect(bundle.status).toBe(200);
    const body = (await bundle.json()) as { bundle: { trip: { id: string } } };
    expect(body.bundle.trip.id).toBe(tripId); // editor guest 走正常 bundle + 真实 id

    const place = await call(
      `/trips/${tripId}/places`,
      {
        ...json({ name: "同伴加的点", category: "restaurant", location: { lng: 120.15, lat: 30.25 } }),
        headers: bearer(editorToken),
      },
    );
    expect(place.status).toBe(201);
  });

  it("viewer token（默认分享链接）：读 200 写 403", async () => {
    await call(`/join/${shareToken}/activate`, json({ displayName: "访客甲" }));
    const read = await call(`/trips/${tripId}`, { headers: bearer(shareToken) });
    expect(read.status).toBe(200);
    const write = await call(
      `/trips/${tripId}/places`,
      {
        ...json({ name: "viewer 不该写", category: "other", location: { lng: 120.16, lat: 30.25 } }),
        headers: bearer(shareToken),
      },
    );
    expect(write.status).toBe(403);
  });
});
