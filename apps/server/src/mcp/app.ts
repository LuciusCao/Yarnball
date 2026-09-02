import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Db } from "../db/client.js";
import type { TripService } from "../services/tripService.js";
import {
  MCP_SERVER_NAME,
  SESSION_ID_HEADER,
  authenticateMcpRequest,
  registerOdesseyTools,
} from "./tools.js";

/**
 * /mcp streamable HTTP 端点（stateless）：
 * 每个请求新建 transport + McpServer，从请求头重新解析 token/session。
 * 这样天然规避了 session-manager 生命周期和 token 中途换绑的问题
 * （agent-legion 在 Python 版踩过的坑）。
 * MCP stateless 模式没有跨请求会话，工具调用全部是一次性 JSON-RPC，符合我们的用法。
 */

const SERVER_VERSION = "0.1.0";

export function createMcpApp(
  db: Db,
  tripService: TripService,
  markMcpObserved: (chatSessionId: string) => void,
): Hono {
  const app = new Hono();

  app.all("/", async (c) => {
    const auth = await authenticateMcpRequest(
      db,
      c.req.header("Authorization"),
      c.req.header(SESSION_ID_HEADER) ?? null,
    );
    if (!auth) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const observed = { marked: false };
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: SERVER_VERSION },
      // stateless：sessionIdGenerator 为 undefined，不产生跨请求状态
      { capabilities: { tools: {} } },
    );
    registerOdesseyTools(server, {
      db,
      tripService,
      chatSessionId: auth.chatSession.id,
      tripId: auth.tripId,
      markMcpObserved: () => {
        if (!observed.marked) {
          observed.marked = true;
          markMcpObserved(auth.chatSession.id);
        }
      },
    });

    try {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      return response;
    } finally {
      await server.close();
    }
  });

  return app;
}
