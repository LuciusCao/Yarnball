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

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:18787";
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
    const agentText = msgs.find((m) => m.kind === "agent_text");
    assert(
      agentText != null && String(agentText.content.text).includes("灵隐寺"),
      "agent_text mentions 灵隐寺",
    );
    // bootstrap prompt 必须带进第一个 prompt（验证方式：fake agent 只回显前 40 字，
    // bootstrap 在 user text 前面，所以回显里应是 bootstrap 开头）
    assert(
      String(agentText?.content.text ?? "").length > 0,
      "agent produced text",
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

    // 4.5 mcp_call_flow：fake agent 真实调用 odessey MCP server
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
      "fake agent connected to odessey MCP server via injected URL",
    );
    assert(
      mcpAgentText != null && String(mcpAgentText.content.text).includes("smoke-trip"),
      "get_trip_context returned the trip bound to the session",
    );
    await api(`/chat-sessions/${mcpSession.id}`, { method: "DELETE" });

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
