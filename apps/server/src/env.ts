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
  /**
   * 监听地址，默认仅 loopback（推荐保持）。v0.4 起 /api 已按 principal 鉴权，绑定非
   * loopback 不再是无条件 RCE，但最小暴露原则不变：局域网/隧道部署见 README「让同伴访问」。
   */
  get serverHost() {
    return process.env.SERVER_HOST ?? "127.0.0.1";
  },
  /**
   * SERVER_HOST 非 loopback 时的显式确认（issue #21）：=1 表示「我知道我在把服务暴露给
   * 其他主机」。未设置时启动打显著警告并指向部署文档——自托管工具不硬阻断。
   */
  get allowRemote() {
    const v = process.env.YARNBALL_ALLOW_REMOTE?.trim().toLowerCase();
    return v === "1" || v === "true";
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
