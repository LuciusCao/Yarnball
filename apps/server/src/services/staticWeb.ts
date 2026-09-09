/**
 * 生产态静态托管：apps/web 构建产物（SPA）。
 * dev 下前端由 vite（:15173）提供；server 只在探测到 dist/index.html 存在时挂载，
 * 挂载后 Tauri 壳的 prod 窗口直接加载 server 端口即可看到 UI。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { env } from "../env.js";

/** 这些前缀永远属于交互面/工具面，静态托管不接管 */
function isReservedPath(p: string): boolean {
  return p === "/healthz" || p === "/api" || p.startsWith("/api/") || p === "/mcp" || p.startsWith("/mcp/");
}

/** 解析 web 构建产物目录；未构建（纯开发态）时返回 null */
function resolveWebDistDir(): string | null {
  const candidates = [
    env.webDistDir,
    // 相对本文件：src/services/ 与编译产物 dist/services/ 同为 apps/server 下两层
    fileURLToPath(new URL("../../../web/dist/", import.meta.url)),
    // 直跑兜底：cwd 为 apps/server 或仓库根
    path.resolve(process.cwd(), "../web/dist"),
    path.resolve(process.cwd(), "apps/web/dist"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

/** 探测到 web dist 时挂载静态托管 + SPA 回退；返回挂载的目录（未挂载返回 null，供启动日志） */
export function mountWebStatic(app: Hono): string | null {
  const dir = resolveWebDistDir();
  if (!dir) return null;

  app.use("*", (c, next) => {
    if (isReservedPath(c.req.path)) return next();
    return serveStatic({ root: dir })(c, next);
  });

  // SPA 回退：未命中静态文件的 GET（如 /share/:token、前端路由深链）一律回 index.html
  app.get("*", (c, next) => {
    if (isReservedPath(c.req.path)) return next();
    return serveStatic({ path: path.join(dir, "index.html") })(c, next);
  });

  return dir;
}
