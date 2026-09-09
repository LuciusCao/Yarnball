/**
 * 把 apps/server 打包为单可执行 sidecar：
 *   1. esbuild 将 server（TS/ESM，含 @yarnball/shared TS 源码与全部 npm 依赖）打成一个 CJS bundle
 *   2. Node SEA（--experimental-sea-config + postject）注入 bundle 到 node 二进制副本
 *   3. 输出 src-tauri/binaries/yarnball-server-<target-triple>，供 Tauri externalBin 随包分发
 *
 * 方案选型：Node SEA。pkg 已归档不维护；bun build --compile 依赖 bun 工具链且
 * ACP 子进程 stdio / hono node-server 在 bun 运行时下的兼容性未验证。SEA 用官方 node
 * 二进制做底座，行为与开发期 tsx/node 直跑一致。已知限制：SEA 不支持内嵌原生模块
 * （M80 的 better-sqlite3），原生 .node 需随包外置分发——见 README「原生模块」一节。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../..");
const DIST_DIR = path.join(APP_DIR, "dist");
const BIN_DIR = path.join(APP_DIR, "src-tauri", "binaries");

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function targetTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = out.match(/^host: (.+)$/m)?.[1]?.trim();
    if (host) return host;
  } catch {
    // 无 rust 工具链时按 node 运行环境推断
  }
  const map = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  const triple = map[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error(`无法推断 target triple：${process.platform}-${process.arch}`);
  return triple;
}

/**
 * 打包产物里把 dotenv/config 打成空操作：桌面应用的环境由壳进程注入，
 * 不能从终端启动时的 cwd 捡到一个陌生 .env（实测会从主 checkout 的 .env 拿到
 * 错误的 DATABASE_URL，导致迁移落到了别的库文件）。
 */
const stripDotenvPlugin = {
  name: "strip-dotenv",
  setup(build) {
    build.onResolve({ filter: /^dotenv\/config$/ }, () => ({
      path: "dotenv/config",
      namespace: "strip-dotenv",
    }));
    build.onLoad({ filter: /.*/, namespace: "strip-dotenv" }, () => ({ contents: "" }));
  },
};

/**
 * SEA 限制：注入脚本里的 require 是 embedderRequire，只允许内置模块，
 * require("better-sqlite3") 会抛 ERR_UNKNOWN_BUILTIN_MODULE。
 * 解法：banner 预置 createRequire(process.execPath) 得到的真实 require 到
 * globalThis.__seaRequire，插件把所有 better-sqlite3 导入改写为经它加载；
 * 模块目录解析靠壳进程注入的 NODE_PATH（指向 bundle resources/node_modules）。
 */
const seaExternalPlugin = {
  name: "sea-external",
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3/ }, (args) => ({
      path: args.path,
      namespace: "sea-ext",
    }));
    build.onLoad({ filter: /.*/, namespace: "sea-ext" }, (args) => ({
      contents: `module.exports = globalThis.__seaRequire(${JSON.stringify(args.path)});`,
    }));
  },
};

async function bundleServer() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const outfile = path.join(DIST_DIR, "server.cjs");
  await esbuild.build({
    // sea-entry：先跑迁移再启动 server（打包后全新机器上 DB 不存在，必须自动迁移）
    entryPoints: [path.join(APP_DIR, "scripts/sea-entry.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    logLevel: "info",
    banner: {
      js: 'globalThis.__seaRequire = require("node:module").createRequire(process.execPath);',
    },
    plugins: [seaExternalPlugin, stripDotenvPlugin],
    // 原生依赖不进 bundle：better-sqlite3 的 .node 由 stageResources() 外置分发
    external: ["better-sqlite3"],
  });
  return outfile;
}

/**
 * 把运行期文件落到 src-tauri/resources/（tauri.conf.json 的 bundle.resources 引用这里）：
 *   - migrations/：drizzle 迁移 SQL（sea-entry 启动时执行）
 *   - node_modules/better-sqlite3/：原生模块整包（SEA 无法内嵌 .node；
 *     壳启动 sidecar 时以 NODE_PATH 指向 resources/node_modules）
 */
function stageResources() {
  const RES_DIR = path.join(APP_DIR, "src-tauri", "resources");
  fs.rmSync(RES_DIR, { recursive: true, force: true });

  const migrationsTarget = path.join(RES_DIR, "migrations");
  fs.cpSync(path.join(REPO_ROOT, "apps/server", "drizzle"), migrationsTarget, { recursive: true });

  const require = createRequire(path.join(REPO_ROOT, "apps/server", "package.json"));
  const sqlitePkgDir = path.dirname(require.resolve("better-sqlite3/package.json"));
  const sqliteTarget = path.join(RES_DIR, "node_modules", "better-sqlite3");
  fs.mkdirSync(sqliteTarget, { recursive: true });
  // better-sqlite3 v13 用 prebuilds/<platform>-<arch>.node（lib/binding.js 按平台加载），
  // 只需拷 package.json + lib + prebuilds；全量 prebuilds 保留，跨平台打包时底座换 arch 即可
  for (const entry of ["package.json", "lib", "prebuilds"]) {
    fs.cpSync(path.join(sqlitePkgDir, entry), path.join(sqliteTarget, entry), { recursive: true });
  }
  const native = path.join(sqliteTarget, "prebuilds", `${process.platform}-${process.arch}.node`);
  if (!fs.existsSync(native)) throw new Error(`better-sqlite3 原生绑定缺失：${native}`);
  console.log(`[sidecar] resources staged: migrations/ + better-sqlite3 (${sqlitePkgDir.split("better-sqlite3@")[1]?.split("/")[0] ?? "unknown"})`);
}

function binaryHasSentinel(binPath) {
  // Homebrew 等 shared-libnode 构建的 node 主程序只有几十 KB，不含 SEA sentinel
  try {
    return fs.readFileSync(binPath).includes(SENTINEL_FUSE);
  } catch {
    return false;
  }
}

/**
 * SEA 底座二进制优先级：$NODE_SEA_BINARY > 当前 node（含 sentinel 时）> 自动下载官方发行版。
 * Homebrew 的 node 是 shared-libnode 构建、不含 SEA sentinel，必须换官方二进制。
 */
async function baseNodeBinary() {
  if (process.env.NODE_SEA_BINARY) {
    const p = path.resolve(process.env.NODE_SEA_BINARY);
    if (!binaryHasSentinel(p)) throw new Error(`NODE_SEA_BINARY (${p}) 不含 SEA sentinel，请换官方发行版二进制`);
    return p;
  }
  if (binaryHasSentinel(process.execPath)) return process.execPath;

  if (process.platform === "win32") {
    throw new Error("当前 node 不含 SEA sentinel；Windows 请从 nodejs.org 下载官方 node.exe 并设 NODE_SEA_BINARY");
  }
  const version = process.version; // 与开发机 node 版本对齐
  const platform = { darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!platform || !arch) throw new Error(`不支持的 SEA 底座平台：${process.platform}-${process.arch}`);
  const name = `node-${version}-${platform}-${arch}`;
  const cacheDir = path.join(DIST_DIR, ".node-bin");
  const cached = path.join(cacheDir, name, "bin", "node");
  if (binaryHasSentinel(cached)) return cached;

  const url = `https://nodejs.org/dist/${version}/${name}.tar.gz`;
  console.log(`[sidecar] 当前 node 无 SEA sentinel，下载官方底座 ${url}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const tgz = path.join(cacheDir, `${name}.tar.gz`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载官方 node 失败：HTTP ${res.status}（${url}）`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xzf", tgz, "-C", cacheDir], { stdio: "inherit" });
  if (!binaryHasSentinel(cached)) throw new Error(`下载的 ${cached} 仍不含 SEA sentinel`);
  return cached;
}

async function seaInject(bundlePath, outPath) {
  const blobPath = path.join(DIST_DIR, "sea-prep.blob");
  const seaConfigPath = path.join(DIST_DIR, "sea-config.json");
  fs.writeFileSync(
    seaConfigPath,
    JSON.stringify({
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    }),
  );
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

  const base = await baseNodeBinary();
  fs.copyFileSync(base, outPath);
  fs.chmodSync(outPath, 0o755);

  if (process.platform === "darwin") {
    // postject 要求目标二进制不带签名（官方 node 是签名的）
    execFileSync("codesign", ["--remove-signature", outPath], { stdio: "inherit" });
  }

  const postjectBin = path.join(APP_DIR, "node_modules", ".bin", "postject");
  const args = [outPath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SENTINEL_FUSE];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  execFileSync(postjectBin, args, { stdio: "inherit" });

  if (process.platform === "darwin") {
    // Apple Silicon 要求可执行文件至少带 ad-hoc 签名；完全不签名的二进制一旦被系统
    // 打上 com.apple.provenance（如从 dmg 拷出）会被 exec 时 SIGKILL。注入后补 ad-hoc 签名。
    // 正式发布时由 tauri 的 signingIdentity / 外层 codesign 用 Developer ID 重签覆盖。
    execFileSync("codesign", ["--sign", "-", "--force", outPath], { stdio: "inherit" });
  }
}

const triple = targetTriple();
const ext = process.platform === "win32" ? ".exe" : "";
const outPath = path.join(BIN_DIR, `yarnball-server-${triple}${ext}`);

const bundlePath = await bundleServer();
stageResources();
fs.mkdirSync(BIN_DIR, { recursive: true });
seaInject(bundlePath, outPath);

console.log(`[sidecar] ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
