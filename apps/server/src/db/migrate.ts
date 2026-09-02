import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";
import "dotenv/config";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}

const { db, pool } = createDb(databaseUrl);
await migrate(db, { migrationsFolder: "drizzle" });
console.log("migrations applied");
await pool.end();
