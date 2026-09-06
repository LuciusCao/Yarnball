#!/usr/bin/env tsx
/**
 * smoke.ts —— 端到端冒烟（不依赖真 agent）。
 *
 * 前置：服务端已运行（pnpm dev），DB 已迁移。
 * 流程：
 *   1. 注册 fake agent 到 agent_registry
 *   2. 创建 trip + chat session（spawn fake-acp-agent.mjs）
 *   3. prompt_flow：发 prompt，轮询消息，断言 user_text → agent_text
 *      → tool_call → 回合结束
 *   4. permission_flow：另开会话，断言 permission_request 出现、UI 应答后
 *      agent 收到决策
 *   5. 清理（关会话）
 */

import "dotenv/config";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:18788";
const FAKE_AGENT_COMMAND = process.execPath;
const FAKE_AGENT_ARGS = [new URL("./fake-acp-agent.mjs", import.meta.url).pathname];

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`TIMEOUT waiting for: ${what}`);
}

async function messages(sessionId: string) {
  return (await api(`/chat-sessions/${sessionId}/messages`)).messages as Array<{
    id: string;
    kind: string;
    content: any;
    seq: number;
  }>;
}

async function main() {
  console.log("== smoke: fake agent end-to-end ==");

  // 1. 注册 fake agent
  const fakeAgentId = "fake-agent-smoke";
  // 直接走 DB 不行（脚本无 DB 依赖），借道：agent registry 种子没有 fake，
  // 这里用 server 端预留的 debug 端点？没有 —— 用 DB URL 直连。
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO agent_registry (id, label, command, args, enabled)
     VALUES ($1, $2, $3, $4::jsonb, true)
     ON CONFLICT (id) DO UPDATE SET command = EXCLUDED.command, args = EXCLUDED.args`,
    [fakeAgentId, "Fake Agent (smoke)", FAKE_AGENT_COMMAND, JSON.stringify(FAKE_AGENT_ARGS)],
  );
  console.log("  ✓ fake agent registered");
  const dbClose = () => client.end();

  try {
    // 2. trip + session
    const { trip } = await api("/trips", {
      method: "POST",
      body: JSON.stringify({ title: "smoke-trip", destinationCity: "杭州" }),
    });
    console.log(`  ✓ trip created: ${trip.id}`);

    const { session } = await api(`/trips/${trip.id}/chat-sessions`, {
      method: "POST",
      body: JSON.stringify({ agentId: fakeAgentId }),
    });
    console.log(`  ✓ chat session created: ${session.id}`);

    await waitUntil(async () => {
      const { sessions } = await api(`/trips/${trip.id}/chat-sessions`);
      return sessions.find((s: any) => s.id === session.id)?.status === "idle";
    }, 15_000, "session to become idle");

    // 3. prompt_flow
    console.log("-- prompt_flow --");
    await api(`/chat-sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "这是一段小红书攻略：灵隐寺必去，早上人少" }),
    });

    let msgs: Awaited<ReturnType<typeof messages>> = [];
    await waitUntil(
      async () => {
        msgs = await messages(session.id);
        return msgs.some((m) => m.kind === "advisory" && String(m.content.text ?? "").includes("回合结束"));
      },
      15_000,
      "turn to finish (prompt_flow)",
    );

    const kinds = msgs.map((m) => m.kind);
    assert(kinds.includes("user_text"), "user_text message exists");
    assert(kinds.includes("tool_call"), "tool_call message exists");
    assert(kinds.includes("tool_call_update"), "tool_call_update message exists");
    // 分段：tool_call 介入封闭当前聚合段，prompt_flow（文本→工具调用→文本）
    // 应产生两条独立的 agent_text，顺序为 user_text → agent_text → tool_call
    // → tool_call_update → agent_text → advisory
    const agentTexts = msgs.filter((m) => m.kind === "agent_text");
    assert(agentTexts.length === 2, `agent output split into 2 segments around tool_call (got ${agentTexts.length})`);
    assert(
      String(agentTexts[1].content.text).includes("灵隐寺"),
      "second agent_text segment mentions 灵隐寺",
    );
    const expectOrder = ["user_text", "agent_text", "tool_call", "tool_call_update", "agent_text", "advisory"];
    assert(
      JSON.stringify(kinds) === JSON.stringify(expectOrder),
      `message order is ${expectOrder.join(" → ")} (got ${kinds.join(" → ")})`,
    );

    // 关闭会话
    await api(`/chat-sessions/${session.id}`, { method: "DELETE" });

    // 4. permission_flow
    console.log("-- permission_flow --");
    // fake agent 脚本由环境变量控制 —— 已在 spawn 前设置不了（server 侧 spawn）。
    // 所以再注册一个 permission 变体：command 带环境前缀。
    const permAgentId = "fake-agent-smoke-perm";
    await client.query(
      `INSERT INTO agent_registry (id, label, command, args, enabled)
       VALUES ($1, $2, $3, $4::jsonb, true)
       ON CONFLICT (id) DO UPDATE SET command = EXCLUDED.command, args = EXCLUDED.args`,
      [
        permAgentId,
        "Fake Agent (permission)",
        "/usr/bin/env",
        JSON.stringify(["FAKE_SCRIPT=permission_flow", FAKE_AGENT_COMMAND, ...FAKE_AGENT_ARGS]),
      ],
    );

    const { session: permSession } = await api(`/trips/${trip.id}/chat-sessions`, {
      method: "POST",
      body: JSON.stringify({ agentId: permAgentId }),
    });
    await waitUntil(async () => {
      const { sessions } = await api(`/trips/${trip.id}/chat-sessions`);
      return sessions.find((s: any) => s.id === permSession.id)?.status === "idle";
    }, 15_000, "perm session idle");

    await api(`/chat-sessions/${permSession.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "跑个命令" }),
    });

    let permMsgs: Awaited<ReturnType<typeof messages>> = [];
    await waitUntil(
      async () => {
        permMsgs = await messages(permSession.id);
        return permMsgs.some((m) => m.kind === "permission_request");
      },
      15_000,
      "permission_request appears",
    );
    const permReq = permMsgs.find((m) => m.kind === "permission_request")!;
    const requestId = String(permReq.content.requestId);
    const allowOption = (permReq.content.options as Array<{ optionId: string; kind: string }>).find(
      (o) => o.kind.startsWith("allow"),
    );
    assert(!!allowOption, "permission request has an allow option");

    // 应答 allow
    const answerRes = await api(`/chat-sessions/${permSession.id}/permissions/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ optionId: allowOption!.optionId }),
    });
    assert(answerRes.ok === true, "permission answered allow");

    await waitUntil(
      async () => {
        permMsgs = await messages(permSession.id);
        return permMsgs.some(
          (m) => m.kind === "agent_text" && String(m.content.text).includes("用户选择了"),
        );
      },
      15_000,
      "agent sees user decision",
    );
    assert(true, "agent received user's permission decision");

    // permission_result 消息落库
    assert(
      permMsgs.some((m) => m.kind === "permission_result"),
      "permission_result recorded",
    );

    await api(`/chat-sessions/${permSession.id}`, { method: "DELETE" });

    // 4.5 mcp_call_flow：fake agent 真实调用 yarnball MCP server
    console.log("-- mcp_call_flow --");
    const mcpAgentId = "fake-agent-smoke-mcp";
    await client.query(
      `INSERT INTO agent_registry (id, label, command, args, enabled)
       VALUES ($1, $2, $3, $4::jsonb, true)
       ON CONFLICT (id) DO UPDATE SET command = EXCLUDED.command, args = EXCLUDED.args`,
      [
        mcpAgentId,
        "Fake Agent (mcp)",
        "/usr/bin/env",
        JSON.stringify(["FAKE_SCRIPT=mcp_call_flow", FAKE_AGENT_COMMAND, ...FAKE_AGENT_ARGS]),
      ],
    );

    const { session: mcpSession } = await api(`/trips/${trip.id}/chat-sessions`, {
      method: "POST",
      body: JSON.stringify({ agentId: mcpAgentId }),
    });
    await waitUntil(async () => {
      const { sessions } = await api(`/trips/${trip.id}/chat-sessions`);
      return sessions.find((s: any) => s.id === mcpSession.id)?.status === "idle";
    }, 15_000, "mcp session idle");

    await api(`/chat-sessions/${mcpSession.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "读一下行程" }),
    });

    let mcpMsgs: Awaited<ReturnType<typeof messages>> = [];
    await waitUntil(
      async () => {
        mcpMsgs = await messages(mcpSession.id);
        return mcpMsgs.some((m) => m.kind === "advisory" && String(m.content.text ?? "").includes("回合结束"));
      },
      20_000,
      "mcp flow turn finished",
    );

    const mcpAgentText = mcpMsgs.find((m) => m.kind === "agent_text");
    assert(
      mcpAgentText != null && String(mcpAgentText.content.text).includes("MCP 连接成功"),
      "fake agent connected to yarnball MCP server via injected URL",
    );
    assert(
      mcpAgentText != null && String(mcpAgentText.content.text).includes("smoke-trip"),
      "get_trip_context returned the trip bound to the session",
    );
    await api(`/chat-sessions/${mcpSession.id}`, { method: "DELETE" });

    // 4.6 multi_city_flow：多城市服务端地基（stops 镜像 / cityName 填充 / transitMode=drive 真实路由段 / 多中心防编造）
    console.log("-- multi_city_flow --");
    // 单城市向后兼容：stops 恒为 stops[0] 镜像（destinationCity）
    {
      const { bundle } = await api(`/trips/${trip.id}`);
      assert(
        Array.isArray(bundle.trip.stops) && bundle.trip.stops.length === 1 && bundle.trip.stops[0].name === "杭州",
        "single-city trip exposes stops = [destinationCity mirror]",
      );
    }

    // 多城市行程（青甘环线迷你版：西宁-茶卡-大柴旦），顺序 = 用户指定
    const { trip: mcTrip } = await api("/trips", {
      method: "POST",
      body: JSON.stringify({ title: "smoke-青甘迷你环线", destinationCity: "西宁", stops: ["西宁", "茶卡", "大柴旦"] }),
    });
    assert(
      mcTrip.stops?.length === 3 &&
        mcTrip.stops[0].name === "西宁" &&
        mcTrip.stops[1].name === "茶卡" &&
        mcTrip.stops[2].name === "大柴旦",
      "multi-city trip keeps stops in user-specified order",
    );
    assert(mcTrip.destinationCity === "西宁", "destinationCity mirrors stops[0]");

    // stop 中心依赖外部地理服务（网络不定）：DB 直连钉死确定性中心，只验证服务端逻辑不验证网络
    const mcStops = [
      { name: "西宁", adcode: "630100", center: { lng: 101.7782, lat: 36.6171 } },
      { name: "茶卡", adcode: null, center: { lng: 99.0828, lat: 36.7902 } },
      { name: "大柴旦", adcode: null, center: { lng: 95.3572, lat: 37.8534 } },
    ];
    await client.query(`UPDATE trips SET stops = $1::jsonb WHERE id = $2`, [JSON.stringify(mcStops), mcTrip.id]);

    // 建点（human REST）：cityName 按最近 stop ≤150km 自动填充
    const mkPlace = async (body: Record<string, unknown>) =>
      (await api(`/trips/${mcTrip.id}/places`, { method: "POST", body: JSON.stringify(body) })).place;
    const xz = await mkPlace({ name: "西宁站", category: "other", location: { lng: 101.8121, lat: 36.6203 } });
    assert(xz.cityName === "西宁", "place near stops[0] auto-filled cityName=西宁");
    const qhk = await mkPlace({ name: "茶卡盐湖", category: "attraction", location: { lng: 99.0833, lat: 36.7 } });
    assert(qhk.cityName === "茶卡", "place near non-primary stop auto-filled cityName=茶卡");
    const dcd = await mkPlace({ name: "大柴旦翡翠湖", category: "attraction", location: { lng: 95.3523, lat: 37.8499 } });
    assert(dcd.cityName === "大柴旦", "place near 大柴旦 auto-filled cityName=大柴旦");
    // 显式传 cityName 优先于自动填充；距所有 stop >150km 的中途点归属为 null（不阻断）
    const explicit = await mkPlace({ name: "U型公路", category: "attraction", location: { lng: 97.2, lat: 37.3 }, cityName: "格尔木" });
    assert(explicit.cityName === "格尔木", "explicit cityName wins over auto-fill");
    const nowhere = await mkPlace({ name: "中途荒野点", category: "other", location: { lng: 97.2, lat: 37.3 } });
    assert(nowhere.cityName === null, "place >150km from all stops gets cityName=null");

    // 城际移动：day2 自驾段（transitMode=drive → 真实路由），day3 未指定（向后兼容直线段）
    await api(`/trips/${mcTrip.id}/entries`, { method: "POST", body: JSON.stringify({ entryType: "place", placeId: xz.id, dayIndex: 1 }) });
    const driveEntry = await api(`/trips/${mcTrip.id}/entries`, {
      method: "POST",
      body: JSON.stringify({ entryType: "transit", dayIndex: 2, position: 0, fromPlaceId: xz.id, toPlaceId: qhk.id, transitMode: "drive" }),
    });
    await api(`/trips/${mcTrip.id}/entries`, { method: "POST", body: JSON.stringify({ entryType: "place", placeId: qhk.id, dayIndex: 2 }) });
    const plainEntry = await api(`/trips/${mcTrip.id}/entries`, {
      method: "POST",
      body: JSON.stringify({ entryType: "transit", dayIndex: 3, position: 0, fromPlaceId: qhk.id, toPlaceId: dcd.id }),
    });
    await api(`/trips/${mcTrip.id}/entries`, { method: "POST", body: JSON.stringify({ entryType: "place", placeId: dcd.id, dayIndex: 3 }) });

    const { bundle: mcBundle } = await api(`/trips/${mcTrip.id}`);
    const rideLeg = (entryId: string) =>
      mcBundle.legs.find((l: any) => l.fromEntryId === entryId && l.toEntryId === entryId);
    const driveLeg = rideLeg(driveEntry.entryId);
    assert(driveLeg?.mode === "drive", "transitMode=drive ride leg uses real routing (mode=drive)");
    assert(
      Array.isArray(driveLeg?.polyline) && driveLeg.polyline.length >= 2 && driveLeg.distanceM > 0,
      "drive ride leg carries polyline + distance (real route or fallback)",
    );
    assert(rideLeg(plainEntry.entryId)?.mode === "transit", "transit entry without transitMode keeps straight-line leg (mode=transit)");
    const driveDto = mcBundle.entries.find((e: any) => e.id === driveEntry.entryId);
    assert(driveDto?.transitMode === "drive", "entry DTO exposes transitMode");

    // place entry 带 transit 字段 → 422（守卫纳入 transitMode）
    {
      const res = await fetch(`${BASE}/api/trips/${mcTrip.id}/entries`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryType: "place", placeId: xz.id, dayIndex: 1, transitMode: "drive" }),
      });
      assert(res.status === 422, "place entry with transitMode rejected (422)");
    }

    // agent 侧多中心防编造：MCP 直连（token 落库），距任一 stop ≤200km 放行、全超 200km 拒绝
    const { createHash } = await import("node:crypto");
    const mcpSessionId = "smoke-mcp-multicity";
    await client.query(
      `INSERT INTO chat_sessions (id, trip_id, agent_registry_id, agent_label, status)
       VALUES ($1, $2, $3, $4, 'idle') ON CONFLICT (id) DO NOTHING`,
      [mcpSessionId, mcTrip.id, fakeAgentId, "Fake Agent (smoke)"],
    );
    const mcpToken = "smoke-mcp-token-multicity";
    await client.query(
      `INSERT INTO agent_tokens (id, chat_session_id, token_hash)
       VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      ["smoke-mcp-token-multicity", mcpSessionId, createHash("sha256").update(mcpToken).digest("hex")],
    );
    const mcpCall = async (method: string, params: unknown, id: number) => {
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${mcpToken}`,
          "x-yarnball-session-id": mcpSessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      return (await res.json()) as any;
    };
    const initRes = await mcpCall(
      "initialize",
      { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
      1,
    );
    assert(initRes.result?.serverInfo?.name === "yarnball", "mcp initialize ok (multi-city session)");
    // 大柴旦旁边（距 stops[0] 西宁 ~590km，单中心旧逻辑必拒；多中心 ≤200km 放行）
    const near = await mcpCall(
      "tools/call",
      { name: "add_place", arguments: { name: "大柴旦魔鬼城", category: "attraction", location: { lng: 95.3, lat: 37.9 } } },
      2,
    );
    const nearText: string = near.result?.content?.[0]?.text ?? "";
    assert(near.result?.isError !== true, "agent place near non-primary stop accepted (multi-center check)");
    assert(JSON.parse(nearText).place?.cityName === "大柴旦", "agent place cityName auto-filled to nearest stop");
    // 上海外滩：距所有 stop >200km → 拒绝并引导 search_poi
    const far = await mcpCall(
      "tools/call",
      { name: "add_place", arguments: { name: "外滩", category: "attraction", location: { lng: 121.49, lat: 31.24 } } },
      3,
    );
    const farText: string = far.result?.content?.[0]?.text ?? "";
    assert(
      far.result?.isError === true && farText.includes("search_poi"),
      "agent place >200km from all stops rejected with search_poi guidance",
    );

    await api(`/trips/${mcTrip.id}`, { method: "DELETE" });
    console.log("  ✓ multi-city trip cleaned up");

    // 5. 清理 trip
    await api(`/trips/${trip.id}`, { method: "DELETE" });
    console.log("  ✓ trip cleaned up");

    console.log("\n== ALL SMOKE TESTS PASSED ==");
  } finally {
    await dbClose();
  }
}

main().catch((err) => {
  console.error("\n== SMOKE FAILED ==");
  console.error(err);
  process.exit(1);
});
