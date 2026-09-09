/**
 * sidecar 的 SEA 入口：先跑 drizzle 迁移，再启动 server。
 * 独立入口（而非直接打包 apps/server/src/main.ts）是因为打包后数据库文件
 * 在全新机器上不存在/未迁移，server 启动时的种子写入会立即失败。
 *
 * 迁移目录约定：环境变量 YARNBALL_MIGRATIONS_DIR 优先（打包后由 Tauri 壳指向
 * bundle resource 目录），未设置时回退相对路径 "drizzle"（开发期 cwd=apps/server）。
 */
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { createDb, resolveDbPath } from "../../../apps/server/src/db/client";

const dbPath = resolveDbPath();
const migrationsFolder = process.env.YARNBALL_MIGRATIONS_DIR ?? "drizzle";
const { db, sqlite } = createDb(dbPath);
migrate(db, { migrationsFolder });
sqlite.close();
console.log(`[sidecar] migrations applied: ${dbPath} (${migrationsFolder})`);

import("../../../apps/server/src/main").catch((err) => {
  console.error("[sidecar] server 启动失败", err);
  process.exit(1);
});
