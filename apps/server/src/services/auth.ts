import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { AccessLinkRole } from "@yarnball/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { ownerTokenConfigured } from "./settings.js";
import { env } from "../env.js";

/**
 * 访问控制（v0.4 多人协作地基，issue #16）。
 *
 * 身份解析规则（每请求一次，详见 resolvePrincipal）：
 *   1. 带 Bearer token 的请求一律按 token 身份处理（loopback 来源也不静默升为 owner——
 *      这样才能在本机用 curl 自测 guest 路径）：access-link token → guest，owner token → owner
 *   2. 无 token：来源 loopback 且未被代理暴露（SERVER_HOST 为 loopback，桌面形态）→ owner；
 *      绑定非 loopback 时 loopback 来源不再免凭证（同机代理回源防提权，Codex P1）；否则 → 匿名
 *
 * 匿名只放行公开区（/api/share/:token、/api/config），其余 401。
 * /api/trips/:tripId/events 与 /api/chat-sessions/:sessionId/events 额外接受 ?token= query param
 * （EventSource 无法带自定义 header；query token 会进访问日志，自托管场景可接受）。
 */

// ---------- 类型 ----------

export type Principal =
  /** 行程所有者（本机用户或持 owner token 的远程本人）：全权限 */
  | { kind: "owner" }
  /** 同伴（持 access-link token）：绑定单个行程 + 角色，只在该行程范围内有权限 */
  | { kind: "guest"; tripId: string; role: AccessLinkRole; linkId: string }
  /** 远程匿名：无凭证。公开区放行，其余 401 */
  | { kind: "anonymous" };

export interface AuthContext {
  db: Db;
  principal: Principal;
}

// ---------- token 工具 ----------

/** 新 access-link token：随机 32 字节 hex（64 字符），同 trips.shareToken 的 hex 风格 */
export function mintAccessToken(): string {
  return randomBytes(32).toString("hex");
}

/** owner token 生成：随机 32 字节 base64url（同 MCP token 惯例），DB 存 sha256 hash */
export function mintOwnerToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------- last_seen 节流 ----------

/** last_seen_at 写入节流窗口：60s 内不重复写，避免每请求一次写放大 */
const LAST_SEEN_THROTTLE_MS = 60_000;
/**
 * linkId → 上次写入时间。评审 P3：只增不删会让吊销/删除的链接条目永占内存——
 * 写入时超上限（1000）先清窗口外的过期条目（吊销链接的节流记录早过期了），
 * 仍超限则按时间淘汰最旧一半。单机自托管规模下上限形同虚设，纯防长年累积。
 */
const LAST_SEEN_MAP_MAX = 1000;
const lastSeenWrittenAt = new Map<string, number>();

function pruneLastSeenMap(now: number): void {
  if (lastSeenWrittenAt.size <= LAST_SEEN_MAP_MAX) return;
  for (const [k, v] of lastSeenWrittenAt) {
    if (now - v >= LAST_SEEN_THROTTLE_MS) lastSeenWrittenAt.delete(k);
  }
  if (lastSeenWrittenAt.size <= LAST_SEEN_MAP_MAX) return;
  // 过期清理后仍超限（理论上 = 大量近期活跃链接）：按时间淘汰最旧的一半
  const sorted = [...lastSeenWrittenAt.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < sorted.length - Math.floor(LAST_SEEN_MAP_MAX / 2); i++) {
    lastSeenWrittenAt.delete(sorted[i][0]);
  }
}

function shouldTouchLastSeen(linkId: string, lastSeenAt: Date | null): boolean {
  const now = Date.now();
  const lastWrite = lastSeenWrittenAt.get(linkId);
  // 上次 DB 值距现在不足窗口且近期写过 → 跳过（防多实例下时钟漂移误判，两条件都查）
  if (lastSeenAt && now - lastSeenAt.getTime() < LAST_SEEN_THROTTLE_MS) return false;
  if (lastWrite && now - lastWrite < LAST_SEEN_THROTTLE_MS) return false;
  pruneLastSeenMap(now);
  lastSeenWrittenAt.set(linkId, now);
  return true;
}

// ---------- 身份解析 ----------

function bearerToken(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}

/** loopback 判定：127.0.0.1 / ::1（含 IPv4-mapped ::ffff:127.0.0.1） */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** 请求来源地址：@hono/node-server 把 IncomingMessage 挂在 c.env.incoming */
function remoteAddress(c: Context): string | undefined {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress;
}

/**
 * 解析请求身份（每请求一次，挂到 c.set("principal", ...)）。
 * 带无效/已吊销 token → 抛 AuthError(401)，绝不静默降级为 loopback owner。
 * tokenOverride：SSE 端点用（?token= query param 复用同一套 token 解析规则，EventSource 带
 * 不了 header）；不传时从 Authorization: Bearer 解析。
 */
export async function resolvePrincipal(c: Context, db: Db, tokenOverride?: string): Promise<Principal> {
  const token = tokenOverride ?? bearerToken(c);
  if (token !== null) {
    // 1. owner token（settings 表，全权限凭证，hash 比对）
    if (ownerTokenConfigured() && hashToken(token) === currentOwnerTokenHash()) {
      return { kind: "owner" };
    }
    // 2. access-link token（trip_access_links，明文比对，未吊销记录）
    const [link] = await db
      .select()
      .from(schema.tripAccessLinks)
      .where(and(eq(schema.tripAccessLinks.token, token), isNull(schema.tripAccessLinks.revokedAt)));
    if (link) {
      if (shouldTouchLastSeen(link.id, link.lastSeenAt)) {
        // 异步落库：不阻塞请求路径（失败只影响在线状态展示，不影响鉴权）
        void db
          .update(schema.tripAccessLinks)
          .set({ lastSeenAt: new Date() })
          .where(eq(schema.tripAccessLinks.id, link.id))
          .catch(() => {});
      }
      return { kind: "guest", tripId: link.tripId, role: link.role as AccessLinkRole, linkId: link.id };
    }
    throw new AuthError(401, "无效或已失效的访问令牌");
  }
  // 3. 无 token：loopback = owner（桌面应用形态）；远程匿名只进公开区。
  //    代理提权防护（Codex P1）：绑定非 loopback（已开放远程访问）时，loopback 来源不再
  //    免凭证视为 owner——cloudflared/tailscale 等同机代理的远程流量 socket peer 也是
  //    127.0.0.1。此形态下本机浏览器同样走登录（/login）或 owner token。
  if (isLoopbackAddress(remoteAddress(c)) && env.trustLoopbackOwner) return { kind: "owner" };
  return { kind: "anonymous" };
}

// ---------- owner token hash 的进程内缓存（settings 模块维护，避免每请求查库） ----------

let ownerTokenHashCache: string | null = null;

/** settings 缓存装载/更新时同步（见 settings.ts 的 initSettingsCache / resetOwnerToken） */
export function setOwnerTokenHashCache(hash: string | null): void {
  ownerTokenHashCache = hash;
}

function currentOwnerTokenHash(): string | null {
  return ownerTokenHashCache;
}

/** SSE 心跳复验用（api.ts 的 tokenStillValid）：当前生效的 owner token hash（未配置为 null） */
export function getOwnerTokenHash(): string | null {
  return ownerTokenHashCache;
}

// ---------- 错误与 guard ----------

export class AuthError extends Error {
  constructor(
    public status: 401 | 403,
    public message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * principal 解析中间件：guard 区统一挂载。
 * 解析结果挂 Hono context（c.get("principal")）；解析失败（无效 token）直接 401。
 */
export function principalMiddleware(db: Db): MiddlewareHandler {
  return async (c, next) => {
    try {
      c.set("principal", await resolvePrincipal(c, db));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    await next();
  };
}

// ---------- 浏览器攻击面防护（评审二 P1-1：drive-by RCE / DNS rebinding） ----------
//
// 威胁模型：桌面形态（loopback=owner 免凭证）下，受害者开着 app 期间浏览器访问恶意网页：
//   1. 恶意 JS 用 simple request（text/plain，绕过 CORS 预检）POST /api/agents + chat-sessions
//      ——hono 不校验 content-type，副作用已发生（注册任意命令 + spawn），等价用户权限 RCE；
//   2. DNS rebinding：服务端不校验 Host，恶意域 A 记录重绑 127.0.0.1 后请求变「同源」，
//      CORS 完全失效，可读全部 /api（含 access-links 明文 token）。
//
// 防护分层（评审三 P1-1a/P1-1b 修正：**仅桌面形态生效**）：
//   - 攻击前提「loopback 免凭证 = owner」只存在于桌面形态（trustLoopbackOwner=true）；
//     部署形态（绑非 loopback）下 loopback 来源不再免凭证、敏感操作强制 token，
//     principal 即安全边界——Origin/Host 校验在那里零收益纯误杀（同伴的 Origin/Host
//     是 LAN IP / tailscale IP / 反代域名，无法穷举白名单）。
//   - 桌面形态下只对「无凭证」请求做 Origin 白名单（杀 drive-by；沙箱 iframe / file://
//     发的 "null" 一律拒——评审三 P1-1a 曾因豁免 null 被 RCE 复现）+ Host 允许集
//     （杀 rebinding）。带凭证请求跳过：有效 token 本身就是鉴权，无效由 principal
//     中间件 401 兜底，凭证无法被恶意网页伪造。
//   - curl / agent 子进程不发 Origin 头，天然放行。

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostOf(header: string): string {
  // Host 头形如 "127.0.0.1:18788"；IPv6 字面量带端口时是 "[::1]:18788"
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

/** Origin / Host 防护的允许集（进程内缓存：启动时定格，env 不会运行中变） */
const allowedBrowserOrigins = new Set<string>();
const allowedHosts = new Set<string>();

function buildBrowserAllowlist(): void {
  const port = String(env.serverPort);
  // Origin 白名单：vite dev、生产同源（loopback 全变体，含 IPv6 与 0.0.0.0 部署绑定值）
  allowedBrowserOrigins.add(env.webOrigin);
  for (const host of ["127.0.0.1", "localhost", "[::1]", "::1"]) {
    allowedBrowserOrigins.add(`http://${host}:${port}`);
  }
  // Host 允许集：loopback 变体 + WEB_ORIGIN 的 host（vite 代理转发形态）
  for (const h of LOOPBACK_HOSTS) allowedHosts.add(h);
  try {
    allowedHosts.add(new URL(env.webOrigin).hostname.toLowerCase());
  } catch {
    // WEB_ORIGIN 非法时忽略（env 校验另有兜底）
  }
}
buildBrowserAllowlist();

/**
 * 浏览器攻击面防护中间件（**仅桌面形态生效**，评审四 P1 修正）：
 *
 * 分层依据：drive-by / rebinding 的攻击前提是「loopback 免凭证 = owner」，这只存在于
 * 桌面形态（trustLoopbackOwner=true）。部署形态（绑非 loopback）下 loopback 来源不再
 * 免凭证、敏感操作全部强制 token（principal 即安全边界），Origin/Host 校验在那里零收益
 * 纯误杀（同伴的 Origin/Host 是 LAN IP / tailscale IP / 反代域名，无法穷举白名单）。
 *
 * 桌面形态下对**无 Bearer 凭证**的请求做两层校验：
 *   - Origin 白名单：浏览器跨站/simple request 必带 Origin；"null"（沙箱 iframe / file:// /
 *     跨源重定向）是攻击标准形态，一律拒（评审三 P1-1a）；
 *   - Host 允许集：杀 DNS rebinding（Host=evil 域名 → 403）。
 *
 * 「凭证」只认 Authorization Bearer（评审四 P1）：浏览器 JS 无法对跨源请求设置
 * Authorization 头（非 CORS-safelisted，设置即触发 preflight 被 CORS 拦）——它才是
 * 恶意网页无法伪造的凭证形态。?token= query / join·share 路径 token 是 JS 可控的
 * URL 内容，垃圾值即可伪造，**不能**作为跳过依据（曾因此被绕过：guard 区的
 * principalMiddleware 不解析 query token，无效值静默落回 loopback owner = RCE）。
 * SSE 端点的合法 query token 由 sseAuth 自行解析与兜底，无需在此放行。
 * 不带 Origin 的请求（curl / agent / 同源 GET）只过 Host 校验。
 */
export function browserGuardMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!env.trustLoopbackOwner) {
      // 部署形态：principal 强制凭证已是安全边界，浏览器形态校验整体跳过
      await next();
      return;
    }
    if (bearerToken(c) !== null) {
      // Authorization Bearer：恶意网页无法设置的凭证形态，交 principal 鉴权（无效 → 401）
      await next();
      return;
    }
    const origin = c.req.header("Origin");
    if (origin !== undefined && !allowedBrowserOrigins.has(origin)) {
      return c.json({ error: "跨站请求被拒绝" }, 403);
    }
    const host = c.req.header("Host");
    if (host !== undefined && !allowedHosts.has(hostOf(host))) {
      return c.json({ error: "无效的 Host 头" }, 403);
    }
    await next();
  };
}

/** 从 context 取 principal（principalMiddleware 之后的 handler 里用） */
export function getPrincipal(c: Context): Principal {
  const p = c.get("principal") as Principal | undefined;
  if (!p) throw new Error("principal 未初始化：handler 必须挂在 principalMiddleware 之后");
  return p;
}

// ---------- 权限矩阵 guard（单点） ----------
//
// 端点分级与 guard 对应关系（guest 能力）：
//   requireOwner       —— owner-only：DELETE /trips/:id、agents CRUD、settings 读写、
//                         chat-sessions 全家、access-links 管理、owner-token 管理
//   tripReadGuard      —— viewer 与 editor 都可：GET /trips/:id（bundle）、weather、budget 读、
//                         hotel-area、suggest/analyze 只读族、SSE events
//   tripWriteGuard     —— 仅 editor：places / entries / notes / day summary / legs / hotels /
//                         budget 写、search（issue 措辞：editor 全部行程编辑端点）
// 行程归属（guest 只能访问自己 tripId 对应的行程）在 tripReadGuard/tripWriteGuard 内校验；
// owner-only 与非行程级端点不需要归属检查（guest 一律 403）。

/** guard 前置检查：owner 直接过；guest 必须在指定行程范围内；匿名 401 */
function guardTripScope(c: Context, tripId: string, need: "read" | "write"): void {
  const p = getPrincipal(c);
  if (p.kind === "owner") return;
  if (p.kind === "anonymous") throw new AuthError(401, "需要访问凭证");
  if (p.tripId !== tripId) throw new AuthError(403, "无权访问该行程");
  if (need === "write" && p.role !== "editor") {
    throw new AuthError(403, "只读链接无编辑权限（请让行程主人提供可编辑链接）");
  }
}

/** 行程读端点 guard：owner / 本行程 viewer+editor 放行 */
export function tripReadGuard(tripId: string, c: Context): void {
  guardTripScope(c, tripId, "read");
}

/** 行程写端点 guard：owner / 本行程 editor 放行（viewer 403） */
export function tripWriteGuard(tripId: string, c: Context): void {
  guardTripScope(c, tripId, "write");
}

/** owner-only 端点 guard：guest 一律 403；匿名（未认证）401——语义与 HTTP 约定一致 */
export function requireOwner(c: Context): void {
  const p = getPrincipal(c);
  if (p.kind === "owner") return;
  if (p.kind === "anonymous") throw new AuthError(401, "需要访问凭证");
  throw new AuthError(403, "仅行程主人可执行此操作");
}

/** guard 区内兜底：未被任何 guard 放行的 guest/anonymous 请求一律拒绝（防止新端点漏挂 guard 直通） */
export function rejectNonOwner(c: Context): void {
  const p = getPrincipal(c);
  if (p.kind === "owner") return;
  if (p.kind === "anonymous") throw new AuthError(401, "需要访问凭证");
  throw new AuthError(403, "无权访问该端点");
}
