import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";
import { createDb } from "./db/client.js";
import * as schema from "./db/schema.js";
import { EventBus } from "./events.js";
import { env } from "./env.js";
import { TripService } from "./services/tripService.js";
import { amapConfigured, initSettingsCache } from "./services/settings.js";
import { AcpSessionManager } from "./acp/sessionManager.js";
import { createMcpApp } from "./mcp/app.js";
import { createApi } from "./routes/api.js";

/**
 * 毛线团（Yarnball）server —— 组装：DB / 事件总线 / TripService / MCP 工具面 / ACP 会话 / REST + SSE。
 */

const { db, sqlite } = createDb(env.databaseUrl);
const bus = new EventBus();
const tripService = new TripService(db, bus);

const acpSessions = new AcpSessionManager(db, bus);

const app = new Hono();

app.use("/api/*", cors({ origin: env.webOrigin }));

const api = createApi(db, bus, tripService, acpSessions);
app.route("/api", api);

// MCP 端点：无 CORS（agent 非 browser），无 /api 前缀。
// 工具命中直接调 manager 的 noteMcpCall：路由内存句柄 + 持久化 has_mcp_call（冒烟提示的 ground truth）
app.route("/mcp", createMcpApp(db, tripService, (chatSessionId) => {
  acpSessions.noteMcpCall(chatSessionId);
}));

app.get("/healthz", (c) => c.json({ ok: true }));

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

const server = serve({ fetch: app.fetch, port: env.serverPort }, async (info) => {
  console.log(`[yarnball] server listening on http://127.0.0.1:${info.port}`);
  await initSettingsCache(db);
  await seedAgents();
  if (!amapConfigured()) {
    console.warn(
      "[yarnball] AMAP keys not configured — POI search / routing will use rough estimates. " +
        "Set them in 设置页 or .env (see .env.example).",
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
