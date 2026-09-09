import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import * as schema from "./schema.js";

/**
 * 解析 SQLite 数据库文件路径：环境变量 DATABASE_URL（纯路径或 file: 前缀）优先，
 * 未设置时默认 ~/.yarnball/yarnball.db（单机个人数据，随用户走而非随 checkout 走）。
 */
export function resolveDbPath(value: string | undefined = process.env.DATABASE_URL): string {
  const raw = value && value.trim() !== "" ? value : `${homedir()}/.yarnball/yarnball.db`;
  return raw.startsWith("file:") ? raw.slice("file:".length) : raw;
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
