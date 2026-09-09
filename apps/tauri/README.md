# @yarnball/tauri —— 毛线团桌面壳（Tauri 2）

Tauri 2 壳：窗口加载本地 server 提供的界面，server 以 sidecar 单可执行随包分发，由壳进程拉起/回收。

## 架构

```
毛线团.app (Tauri 2, WKWebView)
  ├─ 窗口
  │    ├─ dev  → http://localhost:15173（vite dev server，需先 pnpm dev）
  │    └─ prod → 先加载本地 splash.html（奶油底 + icon，随 frontendDist 打包），
  │              sidecar 健康检查通过后 navigate 到 http://127.0.0.1:<port>/
  └─ sidecar：yarnball-server-<target-triple>（src-tauri/binaries/，git 忽略）
       = 官方 node 二进制 + Node SEA 注入的 server bundle（esbuild CJS 打包）
       · 启动：探测端口 → spawn → 自动迁移 SQLite → 轮询 /healthz
         · 18788 空闲：直接用；被占：先验对端 /healthz 身份（app:"yarnball" + webStatic）
           - 同包 server 且托管 web 产物（dev server / 已运行实例）→ 复用，不再起进程
           - 同包但无静态托管（旧版孤儿 sidecar，指过去就是 404）或陌生进程 → 换系统分配的空闲端口
           - 健康检查轮询同样验 app:"yarnball" 身份，不被旧 server 的 {"ok":true} 骗过
       · 退出：Cmd+Q/菜单退出走 RunEvent::Exit 显式 kill；SIGTERM/SIGINT 由 tokio signal 兜底回收
       · 随包 resources：node_modules/better-sqlite3（原生模块）、migrations/（drizzle 迁移）、
         web-dist/（apps/web 构建产物，壳注入 YARNBALL_WEB_DIST_DIR，server 生产态静态托管）
```

## 常用命令

```bash
# 开发（前置：仓库根目录已 pnpm install；另开终端先起 pnpm dev 提供 :15173 与 :18788）
pnpm tauri:dev                # 根目录透传（M85 加）；等价 pnpm -C apps/tauri dev

# sidecar 单可执行（esbuild bundle + Node SEA + postject + 资源就位 + ad-hoc 签名）
pnpm -C apps/tauri build:sidecar

# 打包（先 build:sidecar；tauri build 的 beforeBuildCommand 会先跑 web build、再注入 splash.html，
#      最后产出 dmg 并复制到仓库根 dist/；脚本名不用 build 以免被根 pnpm -r build / CI 拉起）
pnpm tauri:package            # 根目录透传；产物：dist/毛线团_0.1.0_aarch64.dmg
```

> 根目录 `pnpm tauri dev` 便捷脚本需要改根 package.json（超出本包 scope），已报 tower 协调；
> 在此之前请使用 `pnpm -C apps/tauri ...` 或 `pnpm --filter @yarnball/tauri ...`。

## sidecar 方案选型

- **Node SEA（已落地）**：esbuild 把 server（TS/ESM + 全部依赖 + `@yarnball/shared` TS 源码）打成单 CJS bundle，经 `scripts/sea-entry.ts` 入口（先跑 drizzle 迁移再启动 server），`node --experimental-sea-config` 生成 blob，postject 注入官方 node 二进制副本。底座与开发期 node/tsx 行为一致，风险最低。
- pkg：仓库已归档停维护，排除。
- `bun build --compile`：依赖 bun 工具链，且 ACP agent 子进程 stdio、`@hono/node-server` 在 bun 运行时下的兼容性未验证，排除。
- SEA 对 ESM 入口的支持仍是实验性，因此先转 CJS 再注入（esbuild 处理 ESM→CJS 转换），绕开该限制。
- **import.meta 兼容修正**：esbuild 打 CJS 时 `import.meta` 变 `{}`（无 url），依赖里 `new URL(rel, import.meta.url)` 会抛 Invalid URL。bundle 用 `define: { "import.meta.url": "__seaImportMetaUrl" }` + banner 预置 `pathToFileURL(process.execPath).href` 作锚点——SEA 里模块本无真实文件路径，exe 位置语义上最准（staticWeb 的 dist 候选会被 `YARNBALL_WEB_DIST_DIR` 先行命中，实际用不到它）。
- **底座二进制**：SEA 要求带 sentinel 的官方 node 二进制。Homebrew 的 node 是 shared-libnode 构建（主程序仅 ~68KB，不含 sentinel），脚本会自动下载与当前 node 同版本的官方发行版（缓存于 `dist/.node-bin/`，git 忽略）；也可用 `NODE_SEA_BINARY=/path/to/node` 显式指定。交叉打包其他平台架构时同样用 `NODE_SEA_BINARY` 指向目标平台的官方二进制。

## 原生模块（better-sqlite3）—— 已实测

SEA 有两层限制，解法均已落地并实测通过（全新 DB 路径下自动迁移 + `/api/trips` 真实查询）：

1. **`.node` 无法内嵌**：`build-sidecar.mjs` 把 better-sqlite3 的 `package.json + lib + prebuilds/`（v13 用 `prebuilds/<platform>-<arch>.node`）拷到 `src-tauri/resources/node_modules/better-sqlite3/`，经 `bundle.resources` 随包分发（`.app/Contents/Resources/node_modules/`）。esbuild 侧标记 external 不进 bundle。
2. **SEA 的 `require` 是 embedderRequire，只允许内置模块**：bundle banner 预置 `globalThis.__seaRequire = createRequire(process.execPath)`，esbuild 插件把所有 `better-sqlite3` 导入改写为经它加载；目录解析由壳启动 sidecar 时注入的 `NODE_PATH=<resources>/node_modules` 完成。

迁移 SQL（`apps/server/drizzle/`）同样作为 resource 分发（`resources/migrations/`），壳以 `YARNBALL_MIGRATIONS_DIR` 指给 sea-entry。跨平台打包时 prebuilds 已全量保留，换 `NODE_SEA_BINARY` 为目标平台官方 node 即可。

## 数据库与环境

- SQLite 库文件默认 `~/.yarnball/yarnball.db`（随用户走，与 dev 同一份数据）；`DATABASE_URL` 已设置则透传（开发机覆盖用）。
- 壳会覆盖 `SERVER_PORT` / `SERVER_BASE_URL` / `WEB_ORIGIN`（指向实际端口，同源加载天然免 CORS）。
- sidecar 的 stdout/stderr 转到壳进程日志（`[server]` 前缀），打包后用 `Console.app` 或终端直跑 `.app/Contents/MacOS/yarnball` 排查。

## 首启引导（占位）

首次启动（app data 目录无 `first-run-done` 标记）弹原生对话框：列出检测到的 agent CLI（`which kimi / gemini / claude-code-acp`），并提醒到应用内「设置」抽屉填高德 key。正式引导页（复用现有设置页）留待后续迭代。

## 构建与分发

```bash
pnpm install                    # 仓库根目录，一次
pnpm -C apps/tauri package      # dmg 复制到仓库根 dist/（原件在 src-tauri/target/release/bundle/dmg/）
```

前置依赖：Rust 工具链（rustup）、Xcode CLT、Node 22+、pnpm 10。打包机会自动下载 SEA 底座（见上）。

### 当前方案：ad-hoc 签名（用户拍板，不买 Apple Developer 账号）

未配置证书时 Tauri 默认即 ad-hoc 签名；sidecar 在 postject 注入后由构建脚本显式 `codesign --sign - --force` 补签（Apple Silicon 上完全不签名的二进制一旦带 `com.apple.provenance`——如从 dmg 拷出——会被 exec 时 SIGKILL，这步是必须的）。

**给朋友的安装说明**（ad-hoc 包的实际体验）：

1. 打开 dmg，把「毛线团」拖进「应用程序」。
2. 首次打开会被 Gatekeeper 拦截（"无法验证开发者"）：**右键图标 → 打开 → 打开**，即可放行。
3. 如果右键打开仍不行（macOS 较新版本的严格模式），终端执行一次：
   ```bash
   xattr -dr com.apple.quarantine /Applications/毛线团.app
   ```
4. 之后正常双击启动。数据在 `~/.yarnball/yarnball.db`，卸载 app 不删数据。

### 后续如买 Developer ID 再启用：正式签名 + 公证（占位）

1. **Developer ID Application 证书**签名（`tauri.conf.json > bundle.macOS.signingIdentity` 固化身份，CI 用 `APPLE_CERTIFICATE` 等环境变量注入，参考 tauri-action）；注意 sidecar 等嵌套二进制由内向外逐个签（`--options runtime`），再签外层 .app。
2. **公证**：
   ```bash
   xcrun notarytool submit "毛线团_0.1.0_aarch64.dmg" \
     --apple-id <apple-id> --team-id <TeamID> --password <app-specific-password> --wait
   xcrun stapler staple "毛线团_0.1.0_aarch64.dmg"
   ```
3. 公证后首次打开无需右键放行。

### 已知边界（脚手架阶段）

- Windows / Linux 目标未验证（配置仅启用了 dmg target）。
