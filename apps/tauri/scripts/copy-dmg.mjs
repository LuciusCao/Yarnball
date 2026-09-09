/**
 * 打包完成后把 dmg 复制到仓库根 dist/（浅路径，便于取用与 CI 归档）。
 * 深路径 src-tauri/target/release/bundle/dmg/ 里的原件保留不动。
 * 仓库根 dist/ 已被根 .gitignore 的 `dist/` 规则覆盖，无需额外配置。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../..");
const DMG_DIR = path.join(APP_DIR, "src-tauri", "target", "release", "bundle", "dmg");
const OUT_DIR = path.join(REPO_ROOT, "dist");

if (!fs.existsSync(DMG_DIR)) {
  throw new Error(`dmg 目录不存在：${DMG_DIR}（copy-dmg 必须在 tauri build 之后运行）`);
}
const dmgs = fs.readdirSync(DMG_DIR).filter((f) => f.endsWith(".dmg"));
if (dmgs.length === 0) {
  throw new Error(`dmg 目录下没有 .dmg 产物：${DMG_DIR}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const dmg of dmgs) {
  const target = path.join(OUT_DIR, dmg);
  fs.copyFileSync(path.join(DMG_DIR, dmg), target);
  console.log(`[dmg] ${path.relative(REPO_ROOT, target)}（${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MB）`);
}
