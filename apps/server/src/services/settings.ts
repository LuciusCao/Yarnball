import { eq } from "drizzle-orm";
import type { OwnerTokenStatus, SettingsDto, UpdateSettingsInput } from "@yarnball/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { env } from "../env.js";
import { mintOwnerToken, setOwnerTokenHashCache } from "./auth.js";

/**
 * 全局设置：settings 表单行（id="global"），DB 值覆盖同名 env（DB > env）。
 * 高德 key 的消费方（geo.ts / tripService / routes）都同步读这里的进程内缓存，
 * 因此 PUT /api/settings 后立即生效，无需重启。缓存由 initSettingsCache 在启动时装载。
 */

const SETTINGS_ID = "global";

interface SettingsRow {
  amapJsKey: string | null;
  amapServerKey: string | null;
  amapJsSecret: string | null;
  ownerTokenHash: string | null;
}

let cache: SettingsRow | null = null;

const nonEmpty = (v: string | null | undefined): v is string => !!v;

/** 启动时从 DB 装载设置缓存（无行时按空处理，全量回退 env） */
export async function initSettingsCache(db: Db): Promise<void> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, SETTINGS_ID));
  cache = row
    ? {
        amapJsKey: row.amapJsKey,
        amapServerKey: row.amapServerKey,
        amapJsSecret: row.amapJsSecret,
        ownerTokenHash: row.ownerTokenHash ?? null,
      }
    : { amapJsKey: null, amapServerKey: null, amapJsSecret: null, ownerTokenHash: null };
  // owner token hash 同步给 auth 模块的比对缓存（避免每请求查库）
  setOwnerTokenHashCache(cache.ownerTokenHash);
}

export function getAmapJsKey(): string {
  return (cache?.amapJsKey ?? "") || env.amapJsKey;
}

export function getAmapServerKey(): string {
  return (cache?.amapServerKey ?? "") || env.amapServerKey;
}

export function getAmapJsSecret(): string {
  return (cache?.amapJsSecret ?? "") || env.amapJsSecret;
}

/** 前端 JS key + 服务端 key 齐备才算可用（与 env.amapConfigured 同口径） */
export function amapConfigured(): boolean {
  return getAmapServerKey() !== "" && getAmapJsKey() !== "";
}

/**
 * amapServerKey 是服务端密钥（POI 搜索 / 路线规划），永不下发浏览器：
 * GET/PUT /api/settings 响应里统一掩码为固定串，配置态靠非空 + overridden 布尔判断，
 * 前端拿不到明文也无法回显。写入侧（PUT body）仍接受明文。
 * amapJsKey / amapJsSecret 保持明文返回属设计使然 —— 高德 JSAPI 2.0 强制 key + 安全密钥
 * 在浏览器端初始化（经 /api/config 下发），本就藏不住，靠高德后台的域名白名单防盗用。
 */
const MASKED_SERVER_KEY = "********";

/** GET /api/settings 的返回：生效值 + 各字段是否来自 DB 覆盖（amapServerKey 掩码） */
export function getSettings(): SettingsDto {
  const serverKey = getAmapServerKey();
  return {
    amapJsKey: getAmapJsKey(),
    amapServerKey: serverKey === "" ? "" : MASKED_SERVER_KEY,
    amapJsSecret: getAmapJsSecret(),
    amapConfigured: amapConfigured(),
    overridden: {
      amapJsKey: nonEmpty(cache?.amapJsKey),
      amapServerKey: nonEmpty(cache?.amapServerKey),
      amapJsSecret: nonEmpty(cache?.amapJsSecret),
    },
  };
}

/** PUT /api/settings：写 DB 覆盖（null = 清除覆盖回退 env）并刷新缓存 */
export async function updateSettings(db: Db, input: UpdateSettingsInput): Promise<SettingsDto> {
  const row: SettingsRow = {
    amapJsKey: cache?.amapJsKey ?? null,
    amapServerKey: cache?.amapServerKey ?? null,
    amapJsSecret: cache?.amapJsSecret ?? null,
    ownerTokenHash: cache?.ownerTokenHash ?? null,
  };
  if (input.amapJsKey !== undefined) row.amapJsKey = input.amapJsKey || null;
  if (input.amapServerKey !== undefined) row.amapServerKey = input.amapServerKey || null;
  if (input.amapJsSecret !== undefined) row.amapJsSecret = input.amapJsSecret || null;
  await db
    .insert(schema.settings)
    .values({ id: SETTINGS_ID, ...row, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.id,
      set: { ...row, updatedAt: new Date() },
    });
  cache = row;
  return getSettings();
}

// ---------- owner token（issue #16） ----------

/** owner token 是否已配置（auth 模块的快速判定入口；hash 本身不出模块） */
export function ownerTokenConfigured(): boolean {
  return (cache?.ownerTokenHash ?? null) !== null;
}

/** GET /api/owner-token：只报配置态，明文永不回显 */
export function getOwnerTokenStatus(): OwnerTokenStatus {
  return { configured: ownerTokenConfigured() };
}

/**
 * POST /api/owner-token/reset：生成/重置 owner token（旧 token 立即失效）。
 * 明文仅此一次返回；DB 只存 sha256 hash（同 MCP token 惯例）。
 */
export async function resetOwnerToken(db: Db): Promise<{ token: string }> {
  const { token, tokenHash } = mintOwnerToken();
  const row: SettingsRow = {
    amapJsKey: cache?.amapJsKey ?? null,
    amapServerKey: cache?.amapServerKey ?? null,
    amapJsSecret: cache?.amapJsSecret ?? null,
    ownerTokenHash: tokenHash,
  };
  await db
    .insert(schema.settings)
    .values({ id: SETTINGS_ID, ...row, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.settings.id,
      set: { ownerTokenHash: tokenHash, updatedAt: new Date() },
    });
  cache = row;
  setOwnerTokenHashCache(tokenHash);
  return { token };
}
