/**
 * 测试用迁移装载：drizzle-orm 的 better-sqlite3 migrator 跑真实迁移 SQL
 * （含 0004 的 trip_access_links 建表与存量 shareToken 回填语句），
 * 让内存库的表结构与生产一致。路径相对 cwd（vitest 从 apps/server 跑）。
 */
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

export function insertMigration(sqlite: Database.Database): void {
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
}
