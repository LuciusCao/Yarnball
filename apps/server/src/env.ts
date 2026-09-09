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
  /** 监听地址，默认仅 loopback（/api 无鉴权，绑全接口会暴露 LAN）。LAN 调试显式设 0.0.0.0 */
  get serverHost() {
    return process.env.SERVER_HOST ?? "127.0.0.1";
  },
  /** agent 子进程访问 MCP 端点的基址。agent 与服务端同机，默认 loopback。 */
  get serverBaseUrl() {
    return process.env.SERVER_BASE_URL ?? `http://127.0.0.1:${this.serverPort}`;
  },
  get webOrigin() {
    return process.env.WEB_ORIGIN ?? "http://localhost:15173";
  },
  /** web 静态产物目录覆盖（Tauri 壳注入指向 bundle resources；未设置时自动探测 apps/web/dist） */
  get webDistDir() {
    return process.env.YARNBALL_WEB_DIST_DIR ?? "";
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
