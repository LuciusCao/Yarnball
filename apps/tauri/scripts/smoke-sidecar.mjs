/**
 * sidecar 启动烟（CI release 与本地 `pnpm -C apps/tauri smoke:sidecar` 同一条链路，单点实现）：
 *   1. 只读挂载 bundle/dmg/*.dmg，把 .app 拷到临时目录（模拟用户安装，不起 GUI 壳）
 *   2. 注入与壳（src-tauri/src/sidecar.rs）同款的 env，直跑 Contents/MacOS/yarnball-server
 *   3. 轮询 /healthz 断言 { ok:true, app:"yarnball", webStatic:true }，通过即 kill 回收
 *
 * 背景（M106）：hardened runtime flag 杀死 Node SEA sidecar 时，表现为用户首启卡 splash
 * （壳等 healthz 超时），codesign 校验完全查不出来——只有真跑一遍才能拦住。本脚本把
 * 这类「打包产物运行时崩溃」变成 CI 红灯。可用 SIDECAR_SMOKE_PORT 覆盖端口。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const DMG_DIR = path.join(APP_DIR, "src-tauri", "target", "release", "bundle", "dmg");

const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 200;

if (process.platform !== "darwin") {
  console.log("[smoke-sidecar] 非 macOS，跳过 sidecar 启动烟");
  process.exit(0);
}

function mountPoint(dmgPath) {
  const out = execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", dmgPath], {
    encoding: "utf8",
  });
  const match = out.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  if (!match) throw new Error(`hdiutil 挂载后找不到 mount-point：${dmgPath}`);
  return match[1];
}

/** 让系统分配一个空闲端口（与壳 pick_free_port 同思路，避免撞到本机 18788 上的 dev server）。 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealthy(port, child, output) {
  const url = `http://127.0.0.1:${port}/healthz`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`sidecar 提前退出（code=${child.exitCode}）\n---- sidecar 输出 ----\n${output()}`);
    }
    try {
      const resp = await fetch(url);
      if (resp.ok) return await resp.json();
    } catch {
      // 连接拒绝：还没起监听，继续等
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  throw new Error(`等待 ${url} 健康检查超时（${HEALTH_TIMEOUT_MS}ms）\n---- sidecar 输出 ----\n${output()}`);
}

const dmgs = fs.existsSync(DMG_DIR) ? fs.readdirSync(DMG_DIR).filter((f) => f.endsWith(".dmg")) : [];
if (dmgs.length === 0) throw new Error(`dmg 不存在：${DMG_DIR}（smoke-sidecar 必须在 tauri build 之后运行）`);

const dmgPath = path.join(DMG_DIR, dmgs[0]);
const vol = mountPoint(dmgPath);
let tmpDir;
let child;
try {
  const innerApps = fs.readdirSync(vol).filter((f) => f.endsWith(".app"));
  if (innerApps.length === 0) throw new Error(`dmg 内没有 .app：${vol}`);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yarnball-sidecar-smoke-"));
  const appPath = path.join(tmpDir, innerApps[0]);
  fs.cpSync(path.join(vol, innerApps[0]), appPath, { recursive: true });

  const resDir = path.join(appPath, "Contents", "Resources");
  const sidecar = path.join(appPath, "Contents", "MacOS", "yarnball-server");
  if (!fs.existsSync(sidecar)) throw new Error(`sidecar 不存在：${sidecar}`);

  const port = process.env.SIDECAR_SMOKE_PORT
    ? Number(process.env.SIDECAR_SMOKE_PORT)
    : await pickFreePort();
  const origin = `http://127.0.0.1:${port}`;

  // 与壳 sidecar.rs 注入的 env 对齐：NODE_PATH（better-sqlite3 原生模块桥接）、
  // YARNBALL_MIGRATIONS_DIR（drizzle 迁移）、YARNBALL_WEB_DIST_DIR（静态托管）；
  // DATABASE_URL 指到临时目录，不碰用户真实库
  child = spawn(sidecar, [], {
    env: {
      ...process.env,
      SERVER_PORT: String(port),
      SERVER_BASE_URL: origin,
      WEB_ORIGIN: origin,
      NODE_PATH: path.join(resDir, "node_modules"),
      YARNBALL_MIGRATIONS_DIR: path.join(resDir, "migrations"),
      YARNBALL_WEB_DIST_DIR: path.join(resDir, "web-dist"),
      DATABASE_URL: path.join(tmpDir, "smoke.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  const output = () => Buffer.concat(chunks).toString("utf8");
  child.stdout.on("data", (d) => chunks.push(d));
  child.stderr.on("data", (d) => chunks.push(d));

  const health = await waitHealthy(port, child, output);
  if (health.ok !== true || health.app !== "yarnball") {
    throw new Error(`/healthz 身份断言失败：${JSON.stringify(health)}`);
  }
  if (health.webStatic !== true) {
    throw new Error(`/healthz webStatic 应为 true（web-dist 资源未随包？）：${JSON.stringify(health)}`);
  }
  console.log(
    `[smoke-sidecar] sidecar 启动烟通过：version=${health.version} webStatic=${health.webStatic} port=${port}`,
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  execFileSync("hdiutil", ["detach", vol, "-quiet"]);
}
