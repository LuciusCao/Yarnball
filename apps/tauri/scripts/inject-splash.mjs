/**
 * 生成打包态启动闪屏 apps/web/dist/splash.html（奶油底色 + 居中 app icon）。
 *
 * 为什么写进 web/dist：Tauri 窗口的 WebviewUrl::App 只解析 frontendDist
 * （tauri.conf.json 指向 ../../web/dist）里的资源，splash 必须落在其中才能被
 * tauri:// 资产协议加载。dist 是构建产物（git 忽略），本脚本由 beforeBuildCommand
 * 在 web build 之后、tauri 打包之前调用（vite build 会清空 outDir，顺序不能反）。
 * icon 以 base64 内联，避免再处理相对资源路径。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../..");
const WEB_DIST = path.join(REPO_ROOT, "apps", "web", "dist");
const ICON_PATH = path.join(APP_DIR, "src-tauri", "icons", "128x128@2x.png");

// 与 apps/web/public/icon-1024.png 的底色一致（采样自图标圆角矩形内部）
const CREAM = "#FDFAD9";
// 图标描边的深藏青
const INK = "#232E63";

if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) {
  throw new Error(`web 产物不存在：${WEB_DIST}（inject-splash 必须在 web build 之后运行）`);
}
const iconBase64 = fs.readFileSync(ICON_PATH).toString("base64");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>毛线团</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    background: ${CREAM};
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 20px;
    font-family: -apple-system, "PingFang SC", sans-serif;
    user-select: none; -webkit-user-select: none;
  }
  img {
    width: 180px; height: 180px;
    animation: breathe 1.6s ease-in-out infinite;
  }
  .name { color: ${INK}; font-size: 20px; font-weight: 600; letter-spacing: 2px; }
  .hint { color: ${INK}; font-size: 12px; opacity: 0.45; }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.72; } }
</style>
</head>
<body>
  <img src="data:image/png;base64,${iconBase64}" alt="毛线团" />
  <div class="name">毛线团</div>
  <div class="hint">本地服务启动中…</div>
</body>
</html>
`;

const out = path.join(WEB_DIST, "splash.html");
fs.writeFileSync(out, html);
console.log(`[splash] 已注入 ${out}`);
