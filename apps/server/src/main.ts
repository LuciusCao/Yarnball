import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pkg from "../package.json" with { type: "json" };
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";
import { createDb } from "./db/client.js";
import * as schema from "./db/schema.js";
import { EventBus } from "./events.js";
import { env } from "./env.js";
import { TripService } from "./services/tripService.js";
import { amapConfigured, initSettingsCache } from "./services/settings.js";
import { browserGuardMiddleware, isLoopbackAddress } from "./services/auth.js";
import { AcpSessionManager } from "./acp/sessionManager.js";
import { createMcpApp } from "./mcp/app.js";
import { createApi } from "./routes/api.js";
import { mountWebStatic } from "./services/staticWeb.js";

/**
 * 毛线团（Yarnball）server —— 组装：DB / 事件总线 / TripService / MCP 工具面 / ACP 会话 / REST + SSE。
 */

/** 监听地址是否 loopback（127.x / ::1；localhost 域名解析后必为 loopback，不单独特判） */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || isLoopbackAddress(host) || host.startsWith("127.");
}

const { db, sqlite } = createDb(env.databaseUrl);
const bus = new EventBus();
const tripService = new TripService(db, bus);

const acpSessions = new AcpSessionManager(db, bus);

const app = new Hono();

// 浏览器攻击面防护（评审二 P1-1，先于 CORS）：Origin 白名单（杀恶意网页 drive-by——simple
// request 绕得过 CORS 预检但绕不过 Origin 检查）+ Host 校验（杀 DNS rebinding 读面）。
// 不带 Origin 的调用方（curl / agent 子进程 / 壳内非浏览器 fetch）不受影响。
app.use("/api/*", browserGuardMiddleware());
app.use("/api/*", cors({ origin: env.webOrigin }));

const api = createApi(db, bus, tripService, acpSessions);
app.route("/api", api);

// MCP 端点：无 CORS（agent 非 browser），无 /api 前缀。
// 工具命中直接调 manager 的 noteMcpCall：路由内存句柄 + 持久化 has_mcp_call（冒烟提示的 ground truth）
app.route("/mcp", createMcpApp(db, tripService, (chatSessionId) => {
  acpSessions.noteMcpCall(chatSessionId);
}));

// 生产态静态托管：apps/web/dist 存在时挂载（SPA 回退 index.html；/api、/mcp、/healthz 优先级不受影响）。
// dev 模式（vite :15173）下通常无 dist，不挂载，行为不变。
// 注意必须先于 /healthz 注册执行：healthz 响应里的 webStatic 依赖此处的探测结果。
const webDistDir = mountWebStatic(app);

// 健康检查 + 身份标识（M90）：Tauri 壳据此区分「同包 server」与「碰巧占用端口的陌生进程 /
// 旧版孤儿 sidecar」——占用 18788 但响应里没有 app:"yarnball"，或 yarnball 但未托管 web 产物
// （旧版打包残留的孤儿 sidecar，指过去就是 404），壳会换端口而不是复用。
app.get("/healthz", (c) =>
  c.json({ ok: true, app: "yarnball", version: pkg.version, webStatic: webDistDir !== null }),
);

// ---------- agent registry 种子 ----------

const SEED_AGENTS = [
  { id: "kimi", label: "Kimi Code", command: "kimi", args: ["acp"] },
  { id: "gemini", label: "Gemini CLI", command: "gemini", args: ["acp"] },
  { id: "claude-code", label: "Claude Code (ACP)", command: "claude-code-acp", args: [] },
];

async function seedAgents() {
  for (const agent of SEED_AGENTS) {
    const [existing] = await db
      .select()
      .from(schema.agentRegistry)
      .where(eq(schema.agentRegistry.id, agent.id));
    if (!existing) {
      await db.insert(schema.agentRegistry).values(agent);
      console.log(`[seed] agent registered: ${agent.label} (${agent.command} ${agent.args.join(" ")})`);
    }
  }
}

const server = serve({ fetch: app.fetch, port: env.serverPort, hostname: env.serverHost }, async (info) => {
  console.log(`[yarnball] server listening on http://${env.serverHost}:${info.port}`);
  if (webDistDir) console.log(`[yarnball] serving web dist: ${webDistDir}`);
  // 非 loopback 绑定 = 暴露给局域网/公网（issue #16 鉴权 / #21 收敛）：需 YARNBALL_ALLOW_REMOTE=1
  // 显式确认。自托管工具不硬阻断——未确认时打显著警告并指向部署文档，确认后正常起（保留一行提示可见性）。
  if (!isLoopbackHost(env.serverHost)) {
    if (env.allowRemote) {
      console.log(
        `[yarnball] YARNBALL_ALLOW_REMOTE=1：远程访问已确认（SERVER_HOST=${env.serverHost}）。` +
          "鉴权按公网标准（本机/owner token=主人，协作链接 token=同伴）；" +
          "未配 TLS 反代时传输为明文。部署指南见 README「让同伴访问」。",
      );
    } else {
      console.warn("=".repeat(72));
      console.warn(
        `[安全警告] SERVER_HOST=${env.serverHost}：服务端已绑定非 loopback 地址，` +
          "局域网/公网内的任何主机都可访问本服务，而本次启动没有拿到显式确认。\n" +
          "  - /api 已按公网标准鉴权：敏感端点（agents / settings / chat-sessions / 行程删除）仅 owner 可用" +
          "（本机访问即 owner，远程需 Bearer owner token，设置页生成）；\n" +
          "    行程数据须持 access-link token（viewer 只读 / editor 可编辑，分享与协作面板发放，可吊销）。\n" +
          "  - 未配 TLS 反代时传输层为明文 HTTP：token 会被链路窃听，公网暴露务必加 TLS。\n" +
          "  - 确认要暴露：设置环境变量 YARNBALL_ALLOW_REMOTE=1 后重启（不硬阻断，仅提示）。\n" +
          "  - 部署指南（局域网 / tailscale / cloudflared / frp）：README「让同伴访问」一节。",
      );
      console.warn("=".repeat(72));
    }
  }
  await initSettingsCache(db);
  await seedAgents();
  if (!amapConfigured()) {
    console.warn(
      "[yarnball] AMAP keys not configured — 国内行程将使用开源地图引擎（OSM），" +
        "POI/公交数据质量低于高德。在设置页或 .env 配置 key 后，新建国内行程自动回高德（见 .env.example）。",
    );
  }
});

// ---------- 优雅关闭 ----------

async function shutdown() {
  console.log("[yarnball] shutting down…");
  await acpSessions.stopAll();
  server.close();
  sqlite.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
