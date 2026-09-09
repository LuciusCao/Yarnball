import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, resolveDbPath } from "./client.js";
import "dotenv/config";

const dbPath = resolveDbPath();
const { db, sqlite } = createDb(dbPath);
migrate(db, { migrationsFolder: "drizzle" });
console.log(`migrations applied: ${dbPath}`);
sqlite.close();
