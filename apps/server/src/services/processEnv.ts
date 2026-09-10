import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * PATH 增强：Tauri sidecar / GUI 启动的 server 进程 PATH 极简（常只有 /usr/bin:/bin:...），
 * 用户经 npm/brew/nvm/volta 装的 agent CLI 全在 PATH 之外。这里解析出「增强 PATH」，
 * /agents/detect 检测与 ACP spawn 子进程共用同一套，保证「检测得到」与「启动得了」一致。
 *
 * 解析顺序（去重后缓存，进程生命周期内只算一次）：
 * 1. 登录 shell 的 PATH（macOS /bin/zsh -lic，3s 超时兜底；读不到用户的 .zshrc 配置就靠后面补）
 * 2. 常见用户级 bin 目录（存在的才收）
 * 3. 当前进程自带 PATH 兜底
 */

/** 登录 shell PATH 解析超时（毫秒）：防用户 rc 脚本卡死拖垮整个 server */
const LOGIN_SHELL_TIMEOUT_MS = 3000;

/** 输出哨兵：用户 rc 脚本可能往 stdout 打日志，只取哨兵之后的内容 */
const PATH_MARKER = "__YARNBALL_PATH__";

let cachedPath: Promise<string> | null = null;

/** 取增强 PATH（缓存）。首次调用可能花到一次登录 shell 启动的时间（正常 <100ms）。 */
export function getEnhancedPath(): Promise<string> {
  cachedPath ??= resolveEnhancedPath();
  return cachedPath;
}

/** 清缓存重新解析（测试用 / 用户装好 CLI 后手动刷新场景预留） */
export function refreshEnhancedPath(): Promise<string> {
  cachedPath = null;
  return getEnhancedPath();
}

/** 基于增强 PATH 的进程 env（spawn agent 子进程统一走这里） */
export async function getEnhancedEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await getEnhancedPath() };
}

/**
 * 在增强 PATH 里查找可执行命令：
 * - command 含路径分隔符（绝对/相对路径）时直接查文件存在且可执行，不走 PATH 搜索
 * - 否则逐目录找同名可执行文件（不依赖外部 which，极简 PATH 下 which 本身都可能在）
 */
export async function findExecutable(command: string): Promise<string | null> {
  if (!command) return null;
  if (command.includes("/")) {
    return isExecutableFile(command) ? command : null;
  }
  const pathEnv = await getEnhancedPath();
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

async function resolveEnhancedPath(): Promise<string> {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (dirs: Iterable<string>) => {
    for (const d of dirs) {
      const dir = d.trim();
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        parts.push(dir);
      }
    }
  };

  push((await loginShellPath())?.split(delimiter) ?? []);
  push(wellKnownBinDirs().filter((d) => existsSync(d)));
  push((process.env.PATH ?? "").split(delimiter));
  return parts.join(delimiter);
}

/** 登录 shell 的 PATH；失败/超时返回 null（绝不抛出，纯增强不阻断） */
function loginShellPath(): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  // macOS 默认 zsh；-l 读 .zprofile、-i 读 .zshrc，nvm/volta/homebrew 的 PATH 都藏在这俩里
  const shell = process.platform === "darwin" ? "/bin/zsh" : (process.env.SHELL ?? "/bin/bash");
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lic", `echo ${PATH_MARKER}$PATH`],
      { timeout: LOGIN_SHELL_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null);
        const idx = stdout.lastIndexOf(PATH_MARKER);
        if (idx < 0) return resolve(null);
        const value = stdout
          .slice(idx + PATH_MARKER.length)
          .split("\n")[0]
          ?.trim();
        resolve(value || null);
      },
    );
  });
}

/** 常见用户级 bin 目录（GUI 环境 PATH 之外的典型安装位置） */
function wellKnownBinDirs(): string[] {
  const home = homedir();
  const dirs = [
    "/opt/homebrew/bin", // Apple Silicon Homebrew
    "/usr/local/bin", // Intel Homebrew / 手动安装
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"), // npm config prefix=~/.npm-global
    join(home, ".volta", "bin"),
    join(home, ".fnm", "aliases", "default", "bin"),
  ];
  const nvmLatest = latestNvmNodeBin(home);
  if (nvmLatest) dirs.push(nvmLatest);
  return dirs;
}

/** nvm 下最新版本的 node bin 目录（~/.nvm/versions/node/vX.Y.Z/bin） */
function latestNvmNodeBin(home: string): string | null {
  const versionsDir = join(home, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(versionsDir).filter((v) => /^v\d/.test(v));
    if (versions.length === 0) return null;
    // numeric 排序取最新（v9 < v10 字典序会错）
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return join(versionsDir, versions[versions.length - 1]!, "bin");
  } catch {
    return null;
  }
}

/** 文件存在、是常规文件（目录也有可执行位，须排除）且当前用户有执行权限 */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
