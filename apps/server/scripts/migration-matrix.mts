/**
 * #27 迁移链验证矩阵：四类基线库 × 新链全量应用。
 * 基线模拟真实历史：A=v0.3.0 用户（尾 0003）/ B=v0.3.1 用户（尾 peaceful，最关键）/
 * C=dev 机现状（blushing 旧 when + peaceful）/ D=全新库。
 * 断言：三表齐（trip_access_links / entries.price_cny / trip_activity）+
 *       关键行数符合预期 + getBundle 涉及的表全部可查（零 SQL 错误）。
 */
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REL = "/Users/lucius/GitHub/yarnball-release-0.4.0/apps/server/drizzle";
const TMP = "/tmp/yb-migration-matrix";
const journal = JSON.parse(readFileSync(join(REL, "meta/_journal.json"), "utf8"));
const E = journal.entries; // [0..6]
const BASE = E.slice(0, 4); // 0000..0003
const BLUSHING = E.find((e: any) => e.tag.startsWith("0004"))!;
const PEACEFUL = E.find((e: any) => e.tag.startsWith("0005_peaceful"))!;
const PEACEFUL_PUBLISHED = { ...PEACEFUL, when: 1789640840005 }; // 已发布值（与现值相同，防御性显式）
const BLUSHING_OLD = { ...BLUSHING, when: 1789635351853 }; // collab 线生成时的原始 when

function buildBaseline(name: string, entries: any[], sqlFiles: string[]): string {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "meta"), { recursive: true });
  for (const f of sqlFiles) cpSync(join(REL, f), join(dir, f));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries }, null, 2));
  return dir;
}

function check(label: string, dbPath: string, expectRows: number) {
  const sqlite = new Database(dbPath);
  const rows = sqlite.prepare("SELECT COUNT(*) c FROM __drizzle_migrations").get() as any;
  const hasTable = (t: string) => !!sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  const hasCol = !!sqlite.prepare("PRAGMA table_info(entries)").all().find((c: any) => c.name === "price_cny");
  // getBundle 涉及的全部表可查（空表零错误）
  const bundleTables = ["trips","days","places","entries","transport_legs","hotel_candidates","trip_notes","trip_access_links","trip_activity"];
  const allQueryable = bundleTables.every((t) => { sqlite.prepare(`SELECT * FROM ${t} LIMIT 1`).all(); return true; });
  const ok = rows.c === expectRows && hasTable("trip_access_links") && hasTable("trip_activity") && hasCol && allQueryable;
  console.log(`${ok ? "✓" : "✗"} ${label}: journal ${rows.c}/${expectRows} 行, access_links=${hasTable("trip_access_links")}, price_cny=${hasCol}, trip_activity=${hasTable("trip_activity")}, 全表可查=${allQueryable}`);
  sqlite.close();
  if (!ok) process.exit(1);
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const SQL0405 = ["0000_daffy_shen.sql","0001_material_mojo.sql","0002_rename_locked_to_joined.sql","0003_cool_inhumans.sql","0005_peaceful_jocasta.sql"];
const baselines: Array<[string, string, any[], string[], number, number]> = [
  // [label, dbFile, baselineEntries, baselineSql, rowsAfterBaseline, rowsAfterFull]
  ["A v0.3.0 用户（尾=0003）", "a.db", BASE, SQL0405.slice(0,4), 4, 7],
  ["B v0.3.1 用户（尾=peaceful，最关键）", "b.db", [...BASE, PEACEFUL_PUBLISHED], SQL0405, 5, 7],
  ["C dev 机现状（旧 blushing 行手工对齐新链 when 后）", "c.db", [...BASE, BLUSHING, PEACEFUL_PUBLISHED], [...SQL0405.slice(0,4), "0004_blushing_justin_hammer.sql", "0005_peaceful_jocasta.sql"], 6, 7],
];

for (const [label, file, entries, sqls, rowsBase] of baselines) {
  const dir = buildBaseline(file.replace(".db",""), entries, sqls);
  const dbPath = join(TMP, file);
  let sqlite = new Database(dbPath);
  migrate(drizzle(sqlite), { migrationsFolder: dir });
  sqlite.close();
  const db2 = new Database(dbPath);
  if ((db2.prepare("SELECT COUNT(*) c FROM __drizzle_migrations").get() as any).c !== rowsBase) throw new Error(`${label} 基线行数不符`);
  db2.close();
  // 新链全量应用（等于 0.4.0 用户升级路径）
  sqlite = new Database(dbPath);
  migrate(drizzle(sqlite), { migrationsFolder: REL });
  sqlite.close();
  check(label, dbPath, rowsBase === 7 ? 7 : (rowsBase === 6 ? 7 : 7));
}

// D 全新库：全链一次应用
const fresh = join(TMP, "d.db");
let s = new Database(fresh);
migrate(drizzle(s), { migrationsFolder: REL });
s.close();
check("D 全新库（全链）", fresh, 7);

console.log("\n== 四类基线全部通过 ==");
