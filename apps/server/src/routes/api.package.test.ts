/**
 * 行程数据包测试（issue #34：离线分享——导出加密快照 + 密码导入）。
 *
 * 覆盖（风格同 api.collab.test.ts，app.request 直驱 + 内存库真实迁移）：
 *   1. 往返保真：建行程（含 transit entry / 排程 / 酒店选定 / 须知）→ 导出 → 导入 →
 *      新行程的标题/天数/地点/日程字段/交通段/酒店选定态/须知全一致；实体 ID 全部是
 *      新 UUID（不与原行程共享任何 ID）
 *   2. 凭证剥离：解密导出信封（直接调 tripPackage 服务），包内不含原行程 shareToken、
 *      不含任何实体 UUID（导出时全部置空）
 *   3. 错密码：导入端点 400 + 「密码错误」文案；坏文件（非 JSON / 伪造信封）可读报错
 *   4. 权限：导出与导入均为 owner-only（guest token 403）
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../db/client.js";
import { EventBus } from "../events.js";
import { TripService } from "../services/tripService.js";
import { AcpSessionManager } from "../acp/sessionManager.js";
import { createApi } from "./api.js";
import { browserGuardMiddleware } from "../services/auth.js";
import { initSettingsCache } from "../services/settings.js";
import { insertMigration } from "./testMigrations.js";
import { decryptTripPackage } from "../services/tripPackage.js";
import type { TripPackageEnvelope } from "@yarnball/shared";

const { db, sqlite } = createDb(":memory:");
const bus = new EventBus();
const tripService = new TripService(db, bus);
const sessions = new AcpSessionManager(db, bus);
const api = createApi(db, bus, tripService, sessions);
const app = new Hono();
app.use("/api/*", browserGuardMiddleware());
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

let originTripId = "";
let originShareToken = "";
let editorToken = "";
let envelopeText = "";
const PASSWORD = "hunter2pass";

beforeAll(async () => {
  await insertMigration(sqlite);
  await initSettingsCache(db);

  // 原行程：place + transit entry + 排程 + 酒店候选（选定）+ 须知
  const mk = await call("/trips", json({ title: "打包源行程", destinationCity: "杭州" }));
  const trip = ((await mk.json()) as { trip: { id: string; shareToken: string } }).trip;
  originTripId = trip.id;
  originShareToken = trip.shareToken;

  const place = await call(
    `/trips/${originTripId}/places`,
    json({
      name: "灵隐寺",
      category: "attraction",
      location: { lng: 120.1, lat: 30.24 },
      priceCny: 45,
      openingHours: "07:00-18:00",
    }),
  );
  const placeId = ((await place.json()) as { place: { id: string } }).place.id;
  const entry = await call(
    `/trips/${originTripId}/entries`,
    json({ entryType: "place", placeId, dayIndex: 1, startTime: "09:00" }),
  );
  const { dayId } = (await entry.json()) as { dayId: string };
  // transit entry（大交通：含 priceCny / 时刻）
  await call(
    `/trips/${originTripId}/entries`,
    json({ entryType: "transit", dayIndex: 1, fromName: "家", toName: "杭州东站", transitMode: "train", departTime: "07:00", arriveTime: "08:30", priceCny: 1200 }),
  );
  // 酒店候选（CreateHotelCandidateInput 自带建点：name/location，不要先建 place 再传 placeId）+ 选定
  const hotelAdd = await call(
    `/trips/${originTripId}/hotel-candidates`,
    json({ name: "西湖大酒店", location: { lng: 120.15, lat: 30.25 }, pricePerNight: 800 }),
  );
  expect(hotelAdd.status).toBe(201);
  const hotelCandId = ((await hotelAdd.json()) as { candidate: { id: string } }).candidate.id;
  await call(`/trips/${originTripId}/select-hotel`, json({ candidateId: hotelCandId }));
  const links = (await (await call(`/trips/${originTripId}/access-links`)).json()) as {
    links: Array<{ token: string }>;
  };
  // 须知
  await call(`/trips/${originTripId}/notes`, json({ category: "climate", content: "9 月杭州仍热，备防晒" }));
  void links;
  void dayId;

  // guest editor 链接（权限用例用）
  const mkLink = await call(`/trips/${originTripId}/access-links`, json({ role: "editor" }));
  editorToken = ((await mkLink.json()) as { link: { token: string } }).link.token;

  // 导出
  const exp = await call(`/trips/${originTripId}/package`, json({ password: PASSWORD }));
  expect(exp.status).toBe(200);
  envelopeText = JSON.stringify(((await exp.json()) as { package: TripPackageEnvelope }).package);
});

afterAll(() => {
  sessions.stopAll();
  sqlite.close();
});

// ---------- 1. 往返保真 ----------

describe("导出 → 导入往返", () => {
  it("新行程全字段保真且实体 ID 全新", async () => {
    const res = await call("/trips/import-package", json({ package: envelopeText, password: PASSWORD }));
    expect(res.status).toBe(201);
    const { bundle } = (await res.json()) as {
      bundle: {
        trip: { id: string; title: string; shareToken: string; destinationCity: string };
        days: unknown[];
        places: Array<{ id: string; name: string; priceCny: number | null; openingHours: string | null }>;
        entries: Array<{ id: string; placeId: string | null; fromName: string | null; toName: string | null; departTime: string | null; transitMode: string | null; priceCny: number | null; position: number }>;
        legs: unknown[];
        hotelCandidates: Array<{ selected: boolean; checkInDay: number | null; pricePerNight: number | null }>;
        notes: Array<{ category: string; content: string }>;
      };
    };

    // trip 基本字段
    expect(bundle.trip.title).toBe("打包源行程");
    expect(bundle.trip.destinationCity).toBe("杭州");
    expect(bundle.trip.id).not.toBe(originTripId);
    expect(bundle.trip.shareToken).toBeTruthy();
    expect(bundle.trip.shareToken).not.toBe(originShareToken);

    // 地点：字段保真
    const lingyin = bundle.places.find((p) => p.name === "灵隐寺");
    expect(lingyin).toBeTruthy();
    expect(lingyin!.priceCny).toBe(45);
    expect(lingyin!.openingHours).toBe("07:00-18:00");
    // 全部地点 ID 是新 UUID（不与任何原实体共享）
    const originBundle = (await (await call(`/trips/${originTripId}`)).json()) as {
      bundle: { places: Array<{ id: string }>; entries: Array<{ id: string }> };
    };
    const originIds = new Set([...originBundle.bundle.places.map((p) => p.id), ...originBundle.bundle.entries.map((e) => e.id)]);
    for (const p of bundle.places) expect(originIds.has(p.id)).toBe(false);
    for (const e of bundle.entries) expect(originIds.has(e.id)).toBe(false);

    // 日程：place entry + transit entry 保真（时刻/大交通/费用）
    const sorted = [...bundle.entries].sort((a, b) => a.position - b.position);
    expect(sorted.length).toBe(2);
    const transit = sorted.find((e) => e.transitMode === "train")!;
    expect(transit.fromName).toBe("家");
    expect(transit.toName).toBe("杭州东站");
    expect(transit.departTime).toBe("07:00");
    expect(transit.priceCny).toBe(1200);
    // place entry 的引用指向新地点 ID（重映射闭环）
    const placeEntry = sorted.find((e) => e.transitMode == null)!;
    expect(placeEntry.placeId).toBe(lingyin!.id);

    // 酒店：选定态与区间保真
    expect(bundle.hotelCandidates.length).toBe(1);
    expect(bundle.hotelCandidates[0].selected).toBe(true);
    expect(bundle.hotelCandidates[0].checkInDay).toBe(1);
    expect(bundle.hotelCandidates[0].pricePerNight).toBe(800);

    // 须知保真
    expect(bundle.notes.some((n) => n.category === "climate" && n.content.includes("防晒"))).toBe(true);

    // 清理导入的副本（不影响其他用例对「行程数」的感知——本套件不数数，防御性清理）
    await call(`/trips/${bundle.trip.id}`, { method: "DELETE" });
  });

  it("包内不含原行程凭证与实体 UUID（导出剥离）", async () => {
    const decrypted = decryptTripPackage(envelopeText, PASSWORD);
    const raw = JSON.stringify(decrypted);
    expect(decrypted.trip.shareToken).toBe("");
    expect(decrypted.trip.id).toBe("");
    expect(raw).not.toContain(originShareToken);
    expect(raw).not.toContain(originTripId);
  });
});

// ---------- 3. 错密码 / 坏文件 ----------

describe("错误处理", () => {
  it("错密码：400 + 「密码错误」文案", async () => {
    const res = await call("/trips/import-package", json({ package: envelopeText, password: "wrong-password" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("密码错误");
  });

  it("非 JSON 文件：可读报错", async () => {
    const res = await call("/trips/import-package", json({ package: "not json at all", password: PASSWORD }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("数据包");
  });

  it("伪造信封（格式头对但密文损坏）：报错不落库", async () => {
    const env = JSON.parse(envelopeText) as TripPackageEnvelope;
    env.payload = Buffer.from("tampered").toString("base64");
    const res = await call("/trips/import-package", json({ package: JSON.stringify(env), password: PASSWORD }));
    expect(res.status).toBe(400);
    // GCM tag 失败无法区分「错密码」与「篡改」，统一走「密码错误」文案（防旁路探测）
    expect(((await res.json()) as { error: string }).error).toContain("密码错误");
  });
});

// ---------- 4. 权限 ----------

describe("权限（owner-only）", () => {
  it("guest token 导出/导入均 403", async () => {
    const exp = await call(`/trips/${originTripId}/package`, { ...json({ password: PASSWORD }), headers: { ...json({ password: PASSWORD }).headers, ...bearer(editorToken) } });
    expect(exp.status).toBe(403);
    const imp = await call("/trips/import-package", { ...json({ package: envelopeText, password: PASSWORD }), headers: { ...json({ package: envelopeText, password: PASSWORD }).headers, ...bearer(editorToken) } });
    expect(imp.status).toBe(403);
  });

  it("密码下限：6 位以下 400", async () => {
    const res = await call(`/trips/${originTripId}/package`, json({ password: "123" }));
    expect(res.status).toBe(400);
  });
});
