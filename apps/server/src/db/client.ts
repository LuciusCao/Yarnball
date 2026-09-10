import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import * as schema from "./schema.js";

/**
 * 解析 SQLite 数据库文件路径：环境变量 DATABASE_URL（纯路径或 file: 前缀）优先，
 * 未设置时默认 ~/.yarnball/yarnball.db（单机个人数据，随用户走而非随 checkout 走）。
 * M80 起已改用 SQLite：DATABASE_URL 若还是 postgres:// 之类的连接串，直接报错退出，
 * 避免被当成文件路径而创建出垃圾目录。
 */
export function resolveDbPath(value: string | undefined = process.env.DATABASE_URL): string {
  const raw = value && value.trim() !== "" ? value : `${homedir()}/.yarnball/yarnball.db`;
  if (raw === ":memory:") return raw;
  if (raw.startsWith("file:")) return raw.slice("file:".length);
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeMatch) {
    // 只回显 scheme：连接串里可能带用户名密码，原文进错误信息会泄到 stderr/日志
    throw new Error(
      `无法识别的 DATABASE_URL scheme：「${schemeMatch[1]}://」。M80 起已改用 SQLite（better-sqlite3），` +
        `DATABASE_URL 只接受 SQLite 文件路径（可带 file: 前缀），不再支持 postgres:// 等连接串。` +
        `旧 Postgres 数据可用 pnpm -C apps/server migrate:pg-legacy 迁移。`,
    );
  }
  return raw;
}

export function createDb(dbPath: string) {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  // SQLite 默认关闭外键，schema 里的 cascade / set null 全靠它，必须显式开
  sqlite.pragma("foreign_keys = ON");
  return { db: drizzle(sqlite, { schema }), sqlite };
}

export type Db = ReturnType<typeof createDb>["db"];
export { schema };
