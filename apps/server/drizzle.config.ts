import "dotenv/config";
import { homedir } from "node:os";
import { defineConfig } from "drizzle-kit";

// 与 src/db/client.ts 的 resolveDbPath 保持一致（config 独立加载，不复用 client 以避免 ts 加载器差异）
const raw = process.env.DATABASE_URL?.trim();
const dbPath = raw ? raw.replace(/^file:/, "") : `${homedir()}/.yarnball/yarnball.db`;

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: dbPath },
});
