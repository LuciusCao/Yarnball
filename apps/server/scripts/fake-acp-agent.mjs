#!/usr/bin/env node
/**
 * fake-acp-agent —— 可脚本化的假 ACP agent（stdio NDJSON JSON-RPC）。
 *
 * 移植自 agent-legion 的 tests/helpers/fake_acp_agent.py。
 * 行为由环境变量驱动：
 *   FAKE_SCRIPT=prompt_flow     默认。收到 prompt 后：流式 agent_message_chunk →
 *                               tool_call（odessey: add_place）→ 回复文本 → stop
 *   FAKE_SCRIPT=permission_flow 发 permission 请求（Bash 工具），等待 client 决策，
 *                               按结果走不同回复
 *   FAKE_SCRIPT=terminal_flow   走 ACP terminal 协议：terminal/create 一个 echo 命令，
 *                               output → wait_for_exit → release
 *   FAKE_SCRIPT=mcp_call_flow   收到 prompt 后：真实连接 session/new 注入的 odessey
 *                               MCP server（streamable HTTP），调 get_trip_context，
 *                               把结果作为 agent_message_chunk 回复 —— 验证 MCP 工具面
 *
 * 所有收到的线流量 sink 到 stderr（不打断 stdout 协议流）。
 */

import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

const log = (...args) => stderr.write(`[fake-agent] ${args.join(" ")}\n`);

/** 发 JSON-RPC response */
function respond(id, result) {
  const msg = { jsonrpc: "2.0", id, result };
  stdout.write(JSON.stringify(msg) + "\n");
  log("→ respond", JSON.stringify(msg).slice(0, 200));
}

/** 发 JSON-RPC request（client 需响应） */
function request(id, method, params) {
  const msg = { jsonrpc: "2.0", id, method, params };
  stdout.write(JSON.stringify(msg) + "\n");
  log("→ request", method);
}

/** 发 notification */
function notify(method, params) {
  const msg = { jsonrpc: "2.0", method, params };
  stdout.write(JSON.stringify(msg) + "\n");
  log("→ notify", method);
}

const CLIENT_METHODS = new Set([
  "session/request_permission",
  "terminal/create",
  "terminal/output",
  "terminal/wait_for_exit",
  "terminal/release",
  "terminal/kill",
  "fs/write_text_file",
  "fs/read_text_file",
]);

let sessionId = null;
let promptCount = 0;
let nextRequestId = 100;
/** session/new 注入的 MCP server spec（mcp_call_flow 用） */
let injectedMcp = null;
/** terminal/output 的轮询控制 */
const terminalSessions = new Map(); // terminalId → { promise of exit }

async function main() {
  const rl = readline.createInterface({ input: stdin });
  log("fake agent started, script =", process.env.FAKE_SCRIPT ?? "prompt_flow");

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("unparseable line:", line.slice(0, 100));
      continue;
    }
    log("← ", msg.method ?? `response#${msg.id}`, JSON.stringify(msg).slice(0, 300));

    if (msg.method === "initialize") {
      respond(msg.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { agentThought: true },
        },
        authMethods: [],
      });
      continue;
    }

    if (msg.method === "session/new") {
      log("  session/new mcpServers =", JSON.stringify(msg.params.mcpServers));
      injectedMcp = msg.params.mcpServers?.[0] ?? null;
      sessionId = `fake-${Date.now()}`;
      respond(msg.id, { sessionId, modes: null });
      continue;
    }

    if (msg.method === "session/load") {
      sessionId = msg.params.sessionId;
      respond(msg.id, {});
      continue;
    }

    if (msg.method === "session/prompt") {
      promptCount++;
      const text = msg.params.prompt?.[0]?.text ?? "";
      log(`  prompt #${promptCount}:`, text.slice(0, 120).replace(/\n/g, "⏎"));
      void handlePrompt(msg.id, text);
      continue;
    }

    if (msg.method === "session/cancel") {
      log("  cancelled");
      continue;
    }

    // client 的响应（我们发的 request 的回复）
    if (msg.id !== undefined && msg.result !== undefined) {
      if (terminalSessions.has(`resp-${msg.id}`)) {
        const resolve = terminalSessions.get(`resp-${msg.id}`);
        terminalSessions.delete(`resp-${msg.id}`);
        resolve(msg.result);
      }
      continue;
    }

    log("  (ignored)", msg.method ?? msg.id);
  }
  log("stdin closed, exiting");
}

async function handlePrompt(requestId, text) {
  const script = process.env.FAKE_SCRIPT ?? "prompt_flow";

  const update = (updateObj) =>
    notify("session/update", { sessionId, update: updateObj });

  if (script === "permission_flow") {
    // 请求一个 Bash 权限，等用户决策
    const permId = nextRequestId++;
    const permissionResult = await new Promise((resolve) => {
      terminalSessions.set(`resp-${permId}`, resolve);
      request(permId, "session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: `bash-${permId}`,
          title: "Bash",
          kind: "execute",
          status: "pending",
          rawInput: JSON.stringify({ command: "echo hello" }),
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
    });
    const outcomeText =
      permissionResult.outcome?.outcome === "selected"
        ? `用户选择了 ${permissionResult.outcome.optionId}`
        : "用户拒绝/超时";
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `权限结果：${outcomeText}\n` },
    });
    respond(requestId, { stopReason: "end_turn" });
    return;
  }

  if (script === "terminal_flow") {
    // terminal/create → output → wait_for_exit → release
    const createId = nextRequestId++;
    const created = await new Promise((resolve) => {
      terminalSessions.set(`resp-${createId}`, resolve);
      request(createId, "terminal/create", {
        sessionId,
        command: "/bin/sh",
        args: ["-c", "echo fake-terminal-output; exit 7"],
        env: [],
      });
    });
    const terminalId = created?.terminalId ?? "unknown";
    update({
      sessionUpdate: "tool_call",
      toolCallId: `term-tool-1`,
      title: "Bash",
      kind: "execute",
      status: "in_progress",
      rawInput: JSON.stringify({ command: "echo fake-terminal-output" }),
    });
    const outputId = nextRequestId++;
    const output = await new Promise((resolve) => {
      terminalSessions.set(`resp-${outputId}`, resolve);
      request(outputId, "terminal/output", { sessionId, terminalId });
    });
    log("  terminal output:", JSON.stringify(output).slice(0, 200));
    const waitId = nextRequestId++;
    const exitStatus = await new Promise((resolve) => {
      terminalSessions.set(`resp-${waitId}`, resolve);
      request(waitId, "terminal/wait_for_exit", { sessionId, terminalId });
    });
    log("  terminal exit:", JSON.stringify(exitStatus));
    const releaseId = nextRequestId++;
    await new Promise((resolve) => {
      terminalSessions.set(`resp-${releaseId}`, resolve);
      request(releaseId, "terminal/release", { sessionId, terminalId });
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: `term-tool-1`,
      status: "completed",
    });
    update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `终端输出：${output?.output ?? ""}（exit=${exitStatus?.exitCode ?? "?"}）\n`,
      },
    });
    respond(requestId, { stopReason: "end_turn" });
    return;
  }

  if (script === "mcp_call_flow") {
    // 真实调用 Odessey MCP server（session/new 注入的 http spec）
    if (!injectedMcp) {
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "错误：session/new 没有注入 MCP server\n" },
      });
      respond(requestId, { stopReason: "end_turn" });
      return;
    }
    const headers = Object.fromEntries(injectedMcp.headers.map((h) => [h.name, h.value]));
    const rpc = async (method, params) => {
      const res = await fetch(injectedMcp.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      });
      const body = await res.json();
      if (body.error) throw new Error(`MCP ${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    };

    try {
      await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fake-agent", version: "1.0" },
      });
      // stateless 模式下每个 POST 独立，无需 notifications/initialized
      const toolsResult = await rpc("tools/list", {});
      const toolNames = toolsResult.tools.map((t) => t.name);
      const contextResult = await rpc("tools/call", {
        name: "get_trip_context",
        arguments: {},
      });
      const contextText = contextResult.content?.[0]?.text ?? "";
      const context = JSON.parse(contextText);
      update({
        sessionUpdate: "tool_call",
        toolCallId: "mcp-1",
        title: "odessey: get_trip_context",
        kind: "other",
        status: "completed",
        rawInput: "{}",
      });
      update({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `MCP 连接成功。可用工具 ${toolNames.length} 个：${toolNames.slice(0, 5).join(", ")}…；行程「${context.trip?.title}」目的地 ${context.trip?.destinationCity}。\n`,
        },
      });
    } catch (err) {
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `MCP 调用失败：${err.message}\n` },
      });
    }
    respond(requestId, { stopReason: "end_turn" });
    return;
  }

  // 默认 prompt_flow：流式回复 + 模拟 odessey MCP 工具调用
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "收到！我来解析这段攻略……\n" },
  });

  update({
    sessionUpdate: "tool_call",
    toolCallId: "tc-1",
    title: "odessey: search_poi",
    kind: "other",
    status: "in_progress",
    rawInput: JSON.stringify({ keyword: "灵隐寺", city: "杭州" }),
  });

  // 真实调用 MCP：从 session/new 记录的 mcpServers 是 Odessey 注入的；
  // 但假 agent 不直接连 MCP（协议上 agent 自己连）。这里只模拟工具卡片更新。
  await sleep(200);
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-1",
    status: "completed",
    content: { type: "text", text: '找到：灵隐寺 (120.097,30.241)' },
  });

  update({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: `好的，已把「灵隐寺」加入地点库并排进 Day 1。你发的内容开头是：「${text.slice(0, 40)}…」\n`,
    },
  });

  respond(requestId, { stopReason: "end_turn" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
