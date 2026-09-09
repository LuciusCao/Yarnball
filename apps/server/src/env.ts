import "dotenv/config";
import { resolveDbPath } from "./db/client.js";

export const env = {
  /** SQLite 数据库文件路径（DATABASE_URL 支持纯路径或 file: 前缀，默认 ~/.yarnball/yarnball.db） */
  get databaseUrl() {
    return resolveDbPath();
  },
  get serverPort() {
    return Number(process.env.SERVER_PORT ?? 18788);
  },
  /** agent 子进程访问 MCP 端点的基址。agent 与服务端同机，默认 loopback。 */
  get serverBaseUrl() {
    return process.env.SERVER_BASE_URL ?? `http://127.0.0.1:${this.serverPort}`;
  },
  get webOrigin() {
    return process.env.WEB_ORIGIN ?? "http://localhost:15173";
  },
  get amapServerKey() {
    return process.env.AMAP_SERVER_KEY ?? "";
  },
  get amapJsKey() {
    return process.env.AMAP_JS_KEY ?? "";
  },
  get amapJsSecret() {
    return process.env.AMAP_JS_SECRET ?? "";
  },
  get amapConfigured() {
    return this.amapServerKey !== "" && this.amapJsKey !== "";
  },
};
