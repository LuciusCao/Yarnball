/**
 * 打包后签名校验（本地 just package 与 CI release 同一条链路，单点实现）：
 *   1. 只读挂载 bundle/dmg/*.dmg，对 dmg 里的 .app（真正的分发产物）跑
 *      codesign --verify --deep --strict —— 硬门槛，不过即失败
 *   2. 拷出 .app 打上 com.apple.quarantine 属性模拟下载场景，再校验一次封印
 *   3. bundle/macos/*.app 存在时也顺带校验（dmg 打包后 tauri 会清掉它，通常不存在）
 *   4. spctl --assess 仅作信息输出：ad-hoc 签名（无 Developer ID）本就会被
 *      Gatekeeper 默认策略拒绝，不能作为 fail 依据；「已损坏」问题的判据是
 *      codesign 封印是否完整（Sealed Resources 存在且校验通过）。
 *
 * 背景：不配 signingIdentity 时 tauri-bundler 跳过签名，主可执行只剩链接期
 * ad-hoc 签名（Sealed Resources=none），带 quarantine 属性的下载产物会被
 * Gatekeeper 报「已损坏」。tauri.conf.json 已配 "signingIdentity": "-"，
 * bundler 会在打 dmg 前 codesign 封印 .app，本脚本负责防回归。
 *
 * sidecar hardened runtime 断言（M106）：tauri-bundler 默认 hardenedRuntime=true，
 * 会给 sidecar（Node SEA）也带上 runtime flag 且无 entitlements——V8 需要可写可执行
 * 内存，硬化运行时下启动即 EXC_BREAKPOINT(SIGTRAP)，表现为用户首启卡 splash。
 * tauri.conf.json 已配 "hardenedRuntime": false；此处校验 sidecar flags 不含 runtime
 * （若未来改走 entitlements 路线，则要求带 allow-jit / allow-unsigned-executable-memory）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const MACOS_DIR = path.join(APP_DIR, "src-tauri", "target", "release", "bundle", "macos");
const DMG_DIR = path.join(APP_DIR, "src-tauri", "target", "release", "bundle", "dmg");

if (process.platform !== "darwin") {
  console.log("[verify-sign] 非 macOS，跳过签名校验");
  process.exit(0);
}

function verifyApp(appPath) {
  // --deep 覆盖嵌套的 sidecar 二进制；--strict 要求资源封印完整
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
  console.log(`[verify-sign] codesign 校验通过：${appPath}`);
}

/**
 * sidecar 不得带未配 entitlements 的 hardened runtime flag（M106 防回归，见文件头注释）。
 * 当前约定（hardenedRuntime=false）下 flags 应无 runtime；若将来恢复 hardened runtime
 * （如 Developer ID 公证），则必须同时配 allow-jit / allow-unsigned-executable-memory。
 */
function verifySidecarRuntime(appPath) {
  const sidecar = path.join(appPath, "Contents", "MacOS", "yarnball-server");
  if (!fs.existsSync(sidecar)) {
    throw new Error(`sidecar 不存在：${sidecar}（externalBin 未随包分发？）`);
  }
  // codesign -dv 的元数据输出在 stderr
  const meta = spawnSync("codesign", ["-dv", "--verbose=4", sidecar], { encoding: "utf8" });
  if (meta.status !== 0) throw new Error(`codesign -dv 失败：${sidecar}\n${meta.stderr}`);
  // flags 嵌在 CodeDirectory 行内（如 `CodeDirectory v=20400 size=… flags=0x2(adhoc) hashes=…`），
  // 且可能无括号段； hardened runtime 位为 0x10000（CS_RUNTIME）
  const m = meta.stderr.match(/CodeDirectory\b[^\n]*?flags=0x([0-9a-fA-F]+)(?:\(([^)]*)\))?/);
  if (!m) throw new Error(`无法解析 sidecar 签名 flags：${sidecar}`);
  const flagsDesc = `0x${m[1]}(${m[2] ?? ""})`;
  const hasRuntime = (parseInt(m[1], 16) & 0x10000) !== 0;
  if (!hasRuntime) {
    console.log(`[verify-sign] sidecar 无 hardened runtime flag（flags=${flagsDesc}）：${sidecar}`);
    return;
  }
  // 带 runtime 时必须有 JIT 相关 entitlement，否则 Node SEA 启动即崩（V8 需要 RWX 内存）
  const ent = spawnSync("codesign", ["-d", "--entitlements", ":-", sidecar], { encoding: "utf8" });
  const xml = `${ent.stdout ?? ""}${ent.stderr ?? ""}`;
  const hasJit =
    xml.includes("com.apple.security.cs.allow-jit") ||
    xml.includes("com.apple.security.cs.allow-unsigned-executable-memory");
  if (!hasJit) {
    throw new Error(
      `sidecar 带 hardened runtime flag 但无 JIT entitlements（flags=${flagsDesc}）：${sidecar}\n` +
        `Node SEA 在硬化运行时下会因 V8 申请可写可执行内存被拒而启动即崩（M106）。\n` +
        `请在 tauri.conf.json 配 "hardenedRuntime": false，或为 sidecar 配 allow-jit entitlements。`,
    );
  }
  console.log(`[verify-sign] sidecar 带 runtime flag 且含 JIT entitlements（flags=${flagsDesc}）：${sidecar}`);
}

function spctlInfo(appPath) {
  // ad-hoc 签名预期被 spctl 拒绝（无 Developer ID），只记录不作为门槛
  try {
    const out = execFileSync("spctl", ["--assess", "--verbose=2", appPath], { encoding: "utf8" });
    console.log(`[verify-sign] spctl 评估（信息项）：${out.trim()}`);
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    console.log(`[verify-sign] spctl 评估（信息项，ad-hoc 预期 rejected）：${out}`);
  }
}

function mountPoint(dmgPath) {
  const out = execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", dmgPath], {
    encoding: "utf8",
  });
  const match = out.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  if (!match) throw new Error(`hdiutil 挂载后找不到 mount-point：${dmgPath}`);
  return match[1];
}

// 注意：dmg 打包完成后 tauri 会 Clean bundle/macos/*.app，磁盘上通常只剩 dmg——
// 因此 dmg 内的 .app（真正的分发产物）是主校验对象，磁盘 .app 存在时才顺带校验
const apps = fs.existsSync(MACOS_DIR) ? fs.readdirSync(MACOS_DIR).filter((f) => f.endsWith(".app")) : [];
for (const app of apps) {
  const appPath = path.join(MACOS_DIR, app);
  verifyApp(appPath);
  verifySidecarRuntime(appPath);
}

const dmgs = fs.existsSync(DMG_DIR) ? fs.readdirSync(DMG_DIR).filter((f) => f.endsWith(".dmg")) : [];
if (dmgs.length === 0) throw new Error(`dmg 不存在：${DMG_DIR}（verify-sign 必须在 tauri build 之后运行）`);

for (const dmg of dmgs) {
  const dmgPath = path.join(DMG_DIR, dmg);
  const vol = mountPoint(dmgPath);
  try {
    const innerApps = fs.readdirSync(vol).filter((f) => f.endsWith(".app"));
    if (innerApps.length === 0) throw new Error(`dmg 内没有 .app：${vol}`);
    for (const app of innerApps) {
      const appPath = path.join(vol, app);
      verifyApp(appPath);
      verifySidecarRuntime(appPath);
      spctlInfo(appPath);

      // 模拟下载场景：拷出 .app 并打上 quarantine 属性（浏览器下载即如此），
      // 确认带隔离属性时封印仍完整（「已损坏」的判据），spctl 结果仅作信息项
      const tmpApp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yarnball-quarantine-")), app);
      try {
        fs.cpSync(appPath, tmpApp, { recursive: true });
        execFileSync("xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", "-r", tmpApp]);
        verifyApp(tmpApp);
        spctlInfo(tmpApp);
      } finally {
        fs.rmSync(path.dirname(tmpApp), { recursive: true, force: true });
      }
    }
  } finally {
    execFileSync("hdiutil", ["detach", vol, "-quiet"]);
  }
}

console.log("[verify-sign] 全部产物签名校验通过");
