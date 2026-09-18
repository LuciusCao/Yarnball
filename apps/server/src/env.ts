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
  /**
   * loopback 来源是否信任为 owner（Codex P1，防代理提权）：
   * HTTP 层无法可靠区分「本机直连」与「同机代理回源」（X-Forwarded-For 可伪造），采用
   * 绑定形态判定 + 显式逃生阀的组合：
   * - SERVER_HOST 为 loopback（默认，Tauri 壳/dev/纯本机形态）：信任（存量零回归）。
   *   注意：cloudflared `--url localhost:18788` 这类同机隧道回源也属此形态——该部署下
   *   远程流量会以 owner 身份直通！README「让同伴访问」已要求隧道部署改绑 0.0.0.0。
   * - 绑定非 loopback（开放远程访问）：不信任——同机代理回源与本机直连无法区分时，
   *   一律要求凭证（本机浏览器走 /login）。此形态下 loopback 代理回源最多降为匿名。
   * - YARNBALL_TRUST_LOOPBACK=1：显式信任（边角场景自担代理过滤责任）。
   *   YARNBALL_TRUST_LOOPBACK=0：显式不信任（哪怕绑定 loopback，本机也要求凭证——
   *   给「loopback 绑定 + 不想被同机隧道回源提权」的部署用，如 cloudflared 快速隧道）。
   */
  get trustLoopbackOwner() {
    const explicit = process.env.YARNBALL_TRUST_LOOPBACK?.trim().toLowerCase();
    if (explicit === "1" || explicit === "true") return true;
    if (explicit === "0" || explicit === "false") return false;
    const host = this.serverHost;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
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
