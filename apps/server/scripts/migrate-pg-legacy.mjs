#!/usr/bin/env node
/**
 * 一次性迁移工具：把旧 Postgres 库（M80 之前）的数据搬到 SQLite。
 *
 * 背景：M80 起数据库从 Postgres 切换为 better-sqlite3（默认 ~/.yarnball/yarnball.db），
 * 本脚本负责把旧 PG 容器（默认 docker 容器 yarnball-db，postgres:16）里的业务数据导出、
 * 按 apps/server/src/db/schema.ts 的 sqlite schema 逐列转换后写入 SQLite。
 *
 * 用法（仓库根或 apps/server 下均可）：
 *   node apps/server/scripts/migrate-pg-legacy.mjs [--db /path/to/yarnball.db] [--container yarnball-db]
 *   pnpm -C apps/server migrate:pg-legacy -- --db /path/to/yarnball.db
 *
 *   --db         目标 SQLite 文件路径；缺省取 DATABASE_URL（支持 file: 前缀），再缺省 ~/.yarnball/yarnball.db
 *   --container  PG docker 容器名，默认 yarnball-db（库内连接参数固定 -U yarnball -d yarnball）
 *
 * 行为约定：
 * - 迁移前自动备份：cp 目标 SQLite（若存在）与 pg_dump 全库到 /tmp，文件名带时间戳。
 * - 幂等策略：**按主键跳过已存在的行**（INSERT OR IGNORE），重复执行不会产生重复数据，
 *   也不会覆盖 SQLite 里更新的行。若希望以 PG 为准重灌，请先手动清空目标表再跑。
 * - PG 里不存在的表直接跳过；全部写入在单事务内完成，任一步失败整体回滚。
 * - 类型转换：boolean → 0/1；timestamptz → 毫秒整数（schema 的 timestamp_ms）；jsonb → JSON 文本；
 *   numeric → real；uuid/文本列原样保留。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

// ---- 参数解析 ----
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const container = argValue("--container") ?? "yarnball-db";
function resolveTargetDb() {
  const fromArg = argValue("--db");
  const raw = fromArg ?? (process.env.DATABASE_URL?.trim() || undefined) ?? `${homedir()}/.yarnball/yarnball.db`;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) && !raw.startsWith("file://")) {
    console.error(`✗ 目标 DATABASE_URL 的 scheme 无法识别（${raw}）。M80 起已改用 SQLite，请传 SQLite 文件路径（可用 --db 覆盖）。`);
    process.exit(1);
  }
  return raw.startsWith("file:") ? raw.slice("file:".length) : raw;
}
const dbPath = resolve(resolveTargetDb());

// ---- 表与列规格（以 src/db/schema.ts 为准逐列核对；类型：text/int/real/bool/ts/json）----
// 顺序按外键依赖排列（父表先插）。
const TABLES = [
  ["trips", {
    id: "text", title: "text", destination_city: "text", city_adcode: "text",
    geo_provider: "text", city_center_lng: "real", city_center_lat: "real",
    stops: "json", start_date: "text", end_date: "text",
    selected_hotel_candidate_id: "text", budget_cny: "int", traveler_count: "int",
    currency: "text", share_token: "text", created_at: "ts", updated_at: "ts",
  }],
  ["agent_registry", {
    id: "text", label: "text", command: "text", args: "json", enabled: "bool", created_at: "ts",
  }],
  ["settings", {
    id: "text", amap_js_key: "text", amap_server_key: "text", amap_js_secret: "text", updated_at: "ts",
  }],
  ["days", { id: "text", trip_id: "text", day_index: "int", date: "text" }],
  ["places", {
    id: "text", trip_id: "text", name: "text", category: "text", lng: "real", lat: "real",
    address: "text", website: "text", booking_url: "text", phone: "text", city_name: "text",
    amap_poi_id: "text", source_type: "text", source_url: "text", notes: "text",
    duration_min: "int", visit_duration_min: "int", price_cny: "int", booking_info: "text",
    opening_hours: "text", booking_status: "text", created_by: "text", status: "text",
    created_at: "ts",
  }],
  ["entries", {
    id: "text", trip_id: "text", day_id: "text", place_id: "text", entry_type: "text",
    position: "int", start_time: "text", duration_min: "int", note: "text",
    depart_time: "text", arrive_time: "text", from_place_id: "text", to_place_id: "text",
    from_name: "text", to_name: "text", transit_mode: "text",
  }],
  ["transport_legs", {
    id: "text", trip_id: "text", day_id: "text", from_entry_id: "text", to_entry_id: "text",
    from_place_id: "text", to_place_id: "text", seq: "int", mode: "text", mode_override: "text",
    distance_m: "int", duration_s: "int", polyline: "json", transit_detail: "json",
    computed_at: "ts",
  }],
  ["hotel_candidates", {
    id: "text", trip_id: "text", place_id: "text", price_per_night: "int", notes: "text",
    selected: "bool", check_in_day: "int", check_out_day: "int",
  }],
  ["chat_sessions", {
    id: "text", trip_id: "text", agent_registry_id: "text", agent_label: "text",
    acp_session_id: "text", status: "text", allow_all_permissions: "bool",
    has_mcp_call: "bool", last_error: "text", ui_context: "json", created_at: "ts", updated_at: "ts",
  }],
  ["chat_messages", {
    id: "text", session_id: "text", turn_id: "text", seq: "int", kind: "text",
    content: "json", created_at: "ts",
  }],
  ["agent_tokens", {
    id: "text", chat_session_id: "text", token_hash: "text", revoked_at: "ts", created_at: "ts",
  }],
];

// ---- 值转换 ----
function toMs(v) {
  if (v == null) return null;
  // PG 输出形如 2026-09-09T07:36:24.443073+00:00；JS Date 只认 3 位毫秒，先截断微秒
  const s = String(v).replace(/\.(\d{3})\d+/, ".$1");
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间戳: ${v}`);
  return ms;
}
function convert(value, type) {
  if (value == null) return null;
  switch (type) {
    case "bool": return value ? 1 : 0;
    case "ts": return toMs(value);
    case "json": return typeof value === "string" ? value : JSON.stringify(value);
    case "int": return Number(value);
    case "real": return Number(value);
    default: return String(value);
  }
}

// ---- PG 导出（docker exec psql -At + row_to_json，逐行 JSON，不新增依赖）----
function psql(sql) {
  return execFileSync("docker", ["exec", container, "psql", "-U", "yarnball", "-d", "yarnball", "-At", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
}
function exportTable(table) {
  // json_agg(行别名) 直接把整表聚合成一个 JSON 数组（空表 coalesce 成 []），避免逐行解析的行边界问题
  const out = psql(`select coalesce(json_agg(t)::text, '[]') from ${table} t`);
  return JSON.parse(out.trim() || "[]");
}

// ---- 备份 ----
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const pgDumpPath = `/tmp/yarnball-pg-backup-${ts}.sql`;
console.log(`① 备份 PG 全库 → ${pgDumpPath}`);
// pg_dump 输出可能很大，直接 shell 重定向落盘，不走 node buffer
execFileSync("bash", ["-c", `docker exec ${container} pg_dump -U yarnball -d yarnball > ${pgDumpPath}`]);
if (existsSync(dbPath)) {
  const sqliteBackup = `/tmp/yarnball-sqlite-backup-${ts}.db`;
  copyFileSync(dbPath, sqliteBackup);
  console.log(`② 备份目标 SQLite → ${sqliteBackup}`);
} else {
  console.log(`② 目标 SQLite 尚不存在（${dbPath}），跳过文件备份（将直接新建）`);
}

// ---- 打开目标库并迁移（单事务，INSERT OR IGNORE 幂等）----
mkdirSync(dirname(dbPath), { recursive: true });
const sqlite = new Database(dbPath);
sqlite.pragma("foreign_keys = ON");

const existingTables = new Set(
  psql("select table_name from information_schema.tables where table_schema='public'").split("\n").map((s) => s.trim()).filter(Boolean),
);

const summary = [];
sqlite.transaction(() => {
  for (const [table, cols] of TABLES) {
    if (!existingTables.has(table)) {
      summary.push(`${table}: PG 中不存在，跳过`);
      continue;
    }
    const rows = exportTable(table);
    if (rows.length === 0) {
      summary.push(`${table}: 0 行`);
      continue;
    }
    const colNames = Object.keys(cols);
    const stmt = sqlite.prepare(
      `INSERT OR IGNORE INTO ${table} (${colNames.join(",")}) VALUES (${colNames.map(() => "?").join(",")})`,
    );
    let inserted = 0;
    for (const row of rows) {
      const values = colNames.map((c) => convert(row[c], cols[c]));
      inserted += stmt.run(...values).changes;
    }
    summary.push(`${table}: 导出 ${rows.length} 行，新插入 ${inserted} 行，跳过已存在 ${rows.length - inserted} 行`);
  }
})();

console.log("③ 迁移完成（单事务，OR IGNORE 幂等）：");
for (const line of summary) console.log(`   ${line}`);

// ---- 迁移后行数核对 ----
console.log("④ SQLite 目标库行数：");
for (const [table] of TABLES) {
  const c = sqlite.prepare(`select count(*) as c from ${table}`).get().c;
  console.log(`   ${table}: ${c}`);
}
sqlite.close();
console.log("✓ 全部完成。备份文件在 /tmp，确认无误后可自行清理。");
