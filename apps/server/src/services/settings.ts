import { eq } from "drizzle-orm";
import type { SettingsDto, UpdateSettingsInput } from "@yarnball/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { env } from "../env.js";

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
}

let cache: SettingsRow | null = null;

const nonEmpty = (v: string | null | undefined): v is string => !!v;

/** 启动时从 DB 装载设置缓存（无行时按空处理，全量回退 env） */
export async function initSettingsCache(db: Db): Promise<void> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, SETTINGS_ID));
  cache = row
    ? { amapJsKey: row.amapJsKey, amapServerKey: row.amapServerKey, amapJsSecret: row.amapJsSecret }
    : { amapJsKey: null, amapServerKey: null, amapJsSecret: null };
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

/** GET /api/settings 的返回：生效值 + 各字段是否来自 DB 覆盖 */
export function getSettings(): SettingsDto {
  return {
    amapJsKey: getAmapJsKey(),
    amapServerKey: getAmapServerKey(),
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
