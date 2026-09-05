# 毛线团（Yarnball）

基于地图的旅行攻略编辑器 —— Agent-native，国内海外双引擎。行程不是清单，而是地图上的节点 + 节点间的交通段，按天串联。用户在右侧浮层与**自己的 agent**（通过 ACP 协议接入，如 `kimi acp`、`gemini acp`、`claude-code-acp`）对话，agent 通过 MCP 工具直接读写行程数据结构，全屏地图经 SSE 实时刷新。

## 技术栈

- **Monorepo**：pnpm@10 workspace（`apps/*` + `packages/*`），TypeScript 5.9，ESM（`"type": "module"`）
- **服务端** `apps/server`：Node 22+、Hono 4（`@hono/node-server`）、Drizzle ORM + PostgreSQL 16（Docker）、`@agentclientprotocol/sdk`（ACP client）、`@modelcontextprotocol/sdk`（MCP server，stateless streamable HTTP）、zod 4、tsx / vitest
- **前端** `apps/web`：React 19、Vite 7、Tailwind CSS 4（`@tailwindcss/vite`）、react-router 7、zustand、@tanstack/react-query、Radix UI、maplibre-gl（海外）+ 高德 JSAPI 2.0（国内）、marked + sanitize-html
- **共享包** `packages/shared`：zod schema 单一定义点（REST / MCP / 前端三处共享），纯 TS 源码导出（`"main": "src/index.ts"`，无构建产物）

## 架构（三层分离）

```
Browser ── REST(人类直接编辑) + SSE(实时刷新) ──┐
                                                │
Hono Server (apps/server, :18788)               │
  ├─ /api/*        REST + SSE（交互面，CORS 白名单 WEB_ORIGIN）
  ├─ /mcp          MCP streamable HTTP（工具面，无 CORS）◄─ agent 子进程用 URL+Bearer 直连
  └─ AcpSessionManager（对话面）
       └─ spawn agent 子进程（stdio JSON-RPC）
```

- 前端 Vite dev server 在 `:15173`，`/api` 代理到服务端（见 `apps/web/vite.config.ts`）
- **地理引擎双 provider**（`src/services/geo.ts`）：创建行程时按目的地定死 `amap`（国内，高德 API，GCJ-02 坐标）或 `osm`（海外，Photon 搜索 + FOSSGIS OSRM 路线/矩阵 + Nominatim，全部零 key，WGS84），全链路不混用坐标系
- **顺路引擎**（`src/services/tripService.ts`）：provider 距离矩阵 + 最近邻 + 2-opt 重排；交通段自动计算（<2km 步行 / 其余驾车，真实路径 polyline）
- **防编造校验**：agent 建点时坐标必须落在目的城市附近（国内 150km / 海外 300km），越界拒绝并引导先 `search_poi`

## 代码组织

```
apps/server
  src/acp/        ACP 会话管理（sessionManager.ts ~750 行；permissions.ts 四层权限策略；
                  prompts.ts bootstrap prompt；terminal 协议支持）
  src/mcp/        MCP 工具面：tools.ts（20 个工具 + scoped token 鉴权，含 lock_place/unlock_place、
                  add_transit_entry/update_entry（大交通 entry）与 suggest_day_clusters（区域聚类分天建议））、
                  app.ts（HTTP 端点）
  src/services/   tripService.ts（编排/顺路算法核心）、geo.ts（provider 抽象）、settings.ts（全局设置：
                  高德 key 的 DB 覆盖 + env 兜底，/api/settings 响应掩码 amapServerKey）、
                  routing.ts、mappers.ts（DB 行 → DTO）、chatStore.ts
  src/routes/     api.ts（REST + SSE 全部端点）
  src/db/         schema.ts（drizzle 表定义）、client.ts、migrate.ts
  drizzle/        迁移 SQL（随库提交；注意被 .gitignore 的是根 /drizzle/，apps/server/drizzle/ 正常跟踪）
  scripts/        fake-acp-agent.mjs（可脚本化假 agent）、smoke.ts（端到端冒烟）
apps/web
  src/features/   map（amapRenderer + maplibreRenderer 双渲染器）、chat、itinerary（时间轴）、
                  candidates（候选池：candidate/locked 状态机）、settings（设置抽屉：密钥 + agent CLI）、
                  budget —— 按领域划分
  src/pages/      TripListPage / TripPage / SharePage（/share/:token 只读分享）
  src/components/ui/  Radix + CVA 的 shadcn 风格基础组件
  src/stores/     tripStore.ts（zustand：bundle 全量快照 + SSE 增量合并）
  src/lib/api.ts  新端点客户端契约单点（设置 / agent 注册 / 候选状态机 / 时间轴），
                  既有端点在 src/api/client.ts，新代码不要往那里加
packages/shared/src/domain.ts   枚举 / DTO / 请求体 / SSE 事件 / 格式化工具（zod schema）
```

## 常用命令

```bash
# 首次启动
pnpm install
cp .env.example .env && cp .env.example apps/server/.env   # dotenv 从 server 目录读取
pnpm db:up              # docker compose up -d db（Postgres 16 @ localhost:5433）
pnpm db:migrate
pnpm dev                # 并行起 server (:18788) + web (:15173)

# 单端 / 其他
pnpm dev:server         # tsx watch src/main.ts
pnpm dev:web            # vite
pnpm build              # pnpm -r build（server: tsc --noEmit；web: tsc -b && vite build；shared: tsc --noEmit）
pnpm test               # vitest run（server；目前无测试文件，测试主要靠 smoke）
pnpm smoke              # fake-acp-agent 端到端冒烟：prompt 流 / permission 停泊 / MCP 真实调用
                        # 前置：pnpm dev 已运行、DB 已迁移
pnpm db:generate        # 改完 schema.ts 后生成迁移 SQL（drizzle-kit generate）
```

## 代码约定

- **注释与文档用中文**；提交信息也用中文（如「Agent 面板去标题条：红绿灯换成一个收起把手」）
- 数据模型/请求体/事件一律先在 `packages/shared/src/domain.ts` 定义 zod schema，三端共用，不要各写一份类型
- DB 行 → DTO 的映射统一在 `apps/server/src/services/mappers.ts`；列名显式 snake_case；主键为应用侧 `crypto.randomUUID()` 生成的 UUID 文本
- 服务端 tsconfig 为 `module: NodeNext`，相对 import 必须带 `.js` 后缀（如 `./db/client.js`）
- 服务端 `strict: true`、`noEmit`（dev 靠 tsx，生产目前也主要靠 tsx/直跑）
- 前端组件用函数组件 + hooks；状态走 zustand store，服务端数据用 react-query / SSE 订阅
- SSE 的 bundle 事件是**服务端全量快照，前端直接替换**（单机数据量小，全量最可靠），不要在前端做增量合并优化

## Agent 集成关键点（改这块前先读 README 和对应源码）

- **MCP 鉴权**：每个 chat session 一个 token（随机 32 字节，DB 存 sha256）；`/mcp` 每请求从 `Authorization: Bearer` + `x-yarnball-session-id` header 重解析并绑定到该会话的 trip —— agent 永远只能操作当前会话的行程（`src/mcp/tools.ts`）
- **ACP 权限四层策略**（`src/acp/permissions.ts`）：Yarnball MCP 工具自动批准 → 只读 kind 自动批准 → 会话级 allow-all → 停靠到 UI 等用户 120s
- **bootstrap prompt**（`src/acp/prompts.ts`）钉死「坐标必须来自 search_poi」纪律 + 海外英文搜索提示；恢复会话走 `session/new` + 压缩转录回放（ACP `session/load` 待 SDK 封装）
- **大交通与预订状态**：`add_transit_entry` / `update_entry` 管理大交通 entry（🛬抵达 / 🛫离开 / 🚄城市间，departTime/arriveTime 是排程硬锚点）；地点带 `openingHours`（营业时间，排期完全无交叠时前端告警）与 `bookingStatus`（无需预订/待预订/已预订，UI 可点选流转）；`suggest_day_clusters`（对应 REST `GET /api/trips/:id/suggest-clusters`）按地理位置聚类给出分天建议
- 验证 agent 链路改动**不依赖真 agent**：用 `pnpm smoke`（fake-acp-agent.mjs 是可脚本化的假 ACP agent）

## 环境变量与安全

- 见 `.env.example`；必填 `DATABASE_URL`，其余有默认值（`SERVER_PORT=18788`、`WEB_ORIGIN=http://localhost:15173`、`SERVER_BASE_URL` 默认 loopback）
- 高德三个 key（`AMAP_JS_KEY` / `AMAP_SERVER_KEY` / `AMAP_JS_SECRET`）**仅国内行程需要**；海外行程零配置。未配 key 时国内路线降级为直线距离 × 1.3 估算、POI 搜索不可用，海外不受影响
- `.env` 不入库；MCP token 只存 hash；agent 经 `session/new` 注入的 URL+header 直连 `/mcp`，不经浏览器
- 前端渲染 agent 文本用 marked + sanitize-html，不要绕过 sanitize 直接 `dangerouslySetInnerHTML`

## 已知边界（v1）

- 单人编辑 + 只读分享链接（`/share/:token`）；多人实时协同（CRDT）留待 v2
- 海外公交路线为估算（驾车时长 × 1.25 + 换乘惩罚）；国内公交走高德真实数据
- Photon / OSRM 是社区免费服务，高频使用应自托管（代码里换 base URL 即可）
- ACP `session/load` 直连与 `session/cancel` 通知通道待 SDK（ActiveSession 封装）暴露后补
