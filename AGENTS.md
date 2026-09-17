# 毛线团（Yarnball）

基于地图的旅行攻略编辑器 —— Agent-native，国内海外双引擎。行程不是清单，而是地图上的节点 + 节点间的交通段，按天串联。用户在右侧浮层与**自己的 agent**（通过 ACP 协议接入，如 `kimi acp`、`gemini acp`、`claude-code-acp`）对话，agent 通过 MCP 工具直接读写行程数据结构，全屏地图经 SSE 实时刷新。

## 技术栈

- **Monorepo**：pnpm@10 workspace（`apps/*` + `packages/*`），TypeScript 5.9，ESM（`"type": "module"`）
- **服务端** `apps/server`：Node 22+、Hono 4（`@hono/node-server`）、Drizzle ORM + SQLite（better-sqlite3 内嵌，无需 Docker）、`@agentclientprotocol/sdk`（ACP client）、`@modelcontextprotocol/sdk`（MCP server，stateless streamable HTTP）、zod 4、tsx / vitest
- **前端** `apps/web`：React 19、Vite 7、Tailwind CSS 4（`@tailwindcss/vite`）、react-router 7、zustand、@tanstack/react-query、Radix UI、maplibre-gl（海外 + 国内零配置回退）+ 高德 JSAPI 2.0（国内配 key）、marked + sanitize-html
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
- **地理引擎双 provider**（`src/services/geo.ts`）：创建行程时定死 `amap`（国内 + 配齐高德 key，高德 API，GCJ-02 坐标）或 `osm`（海外，以及**未配 key 的国内零配置回退**（M113）——Photon 搜索 + FOSSGIS OSRM 路线/矩阵 + Nominatim + transitous 真实公交，全部零 key，WGS84），全链路不混用坐标系。国内回退行程由 `trips.country`（建行程解析落库，中国归一为「中国」）+ `geoProvider` 识别（shared 的 `isDomesticOsmTrip`）：创建表单/行程页给一次性降级提示，bootstrap prompt 加「search_poi 用官方全名、公交为估算」纪律；transitous 国内 GTFS 无覆盖，国内公交维持估算口径。存量行程不动：`reResolveCity` 双向翻面防护（amap 行程缺 key 重解析不翻 osm；国内 osm 行程配 key 后重解析 forced=osm 钉住不翻 amap——纠偏通道只对 country=null 的存量误判行程开放）；配 key 后仅**新建**的国内行程回 amap。国内 osm 行程公交 leg 跳过 transitous（国内 GTFS 零覆盖必 miss）直接 OSRM 估算
- **海外真实公交**（M111，transitous = api.transitous.org，MOTIS 2 社区实例 API v6）：osm 公交族请求先走 transitous 真实换乘（`transitousPlan`），命中时 mode 取真实首段 transit 方式（SUBWAY→metro、TRAM→light_rail、BUS/COACH→bus、SUBURBAN/REGIONAL_RAIL/HIGHSPEED_RAIL→train、FERRY→ferry）、transitDetail 带真实线路名/上下车站/分段 polyline（Google polyline precision=6，自带解码器）；查询时刻为行程日（startDate+dayIndex）当地约 09:00（经度近似时区），cache key 含日期。GTFS 瑕疵过滤：纯数字 ≥5 位的内部 ID 不作线路名。降级链 transitous（空 itineraries 不重试/超时/错误）→ OSRM ×1.25 估算 → fallbackRoute；命中时绕行比渡轮启发式与机场线启发式自动退为兜底。usage policy 硬性义务：UA 带 app 名/版本/联系方式（TRANSITOUS_UA）+ 设置抽屉底部署名 transitous.org
- **顺路引擎**（`src/services/tripService.ts`）：provider 距离矩阵 + 最近邻 + 2-opt 重排；交通段自动计算（基础分档 <2km 步行 / 2-6km 公交 / >6km 驾车 + 两条场景化启发式：端点含机场的长距段判 train 机场线、路由里程÷直线 ≥1.8 的跨水段判 ferry 轮渡——osm 侧 transitous 命中时由真实数据取代这两条启发式；方式枚举 9 值 walk/taxi/drive/transit/bus/metro/light_rail/train/ferry，见 `packages/shared/src/domain.ts` TRANSPORT_MODES；地图上渡轮画水蓝点划水上航线、轨道类画深灰划线铁路样式）
- **多城市模型**（M37 地基 + M39 界面层）：`trips.stops` 为有序途经地节点（stops[0] = 主目的地，`destinationCity`/`location` 是其兼容镜像）；`places.cityName` 为归属途经地（建点时自动填充）；`entries.transitMode`（flight/train/drive/bus）区分大交通方式，drive=自驾城际段走真实公路路由拿里程/时长。环线闭合不落库——末段 transit 讫点 == stops[0] 即闭合。前端：行程面板按 stop 分组 + 🚗 自驾卡、地图途经地标记层、候选池按城市分桶（`apps/web/src/features/itinerary/stops.ts` 是 day→stop / 环线闭合的推导单点）
- **防编造校验**：agent 建点时坐标必须落在途经地附近——单城市行程退化为 stops[0] 单中心（国内 150km / 海外 300km），多城市行程为距任一 stop.center ≤200km（osm 保持 300km）；越界拒绝并引导先 `search_poi`
- **行程信息增强**（M101，issue #5/#9/#11）：
  - 天气（#5）：`GET /api/trips/:tripId/weather`（MCP `get_weather`），`src/services/weather.ts` 走 Open-Meteo（零 key 全球覆盖，走 `overseasFetch` 代理约定），按 startDate+dayIndex 对齐真实日期逐天预报（温度区间/晴雨/降水/风速）；仅未来 16 天可信，超窗日期显式 `available=false + reason`；内存短缓存 30min。国内行程 GCJ-02 坐标直接查（偏移 ≪ 11km 预报网格）
  - 每日概要（#9）：`days.summary` 列 + `PATCH /api/days/:dayId/summary` + MCP `set_day_summary`；未撰写时 bundle 层自动生成兜底（`summaryAuto=true`，当日区域/多数派城市 + 主景点 3-4 个，不落库实时重算）
  - 行程级注意事项（#11）：`trip_notes` 表（独立表不挂 trips json 列——逐条 CRUD 有稳定 id，与 places/entries 同构），分类 7 值 communication/climate/power/visa/currency/transport/other（`TRIP_NOTE_CATEGORIES`），REST CRUD `/api/trips/:tripId/notes` + `/api/notes/:noteId` + MCP `add_trip_note/update_trip_note/remove_trip_note`，随 bundle 全量下发
  - title 收敛：`UpdateTripInputSchema` 加 `title`（通用 PATCH 端点），独立 `PATCH /trips/:tripId/title` 保留兼容（前端 renameTrip 未动），内部同走 `tripService.updateTrip`
- **协作实时体验**（#19，issue #19）：
  - SharePage 实时化：订阅公开端点 `GET /api/share/:token/events`（token 即凭证、服务端内部解析 tripId，与 GET /share/:token 同模式；bundle/activity 事件过 `aliasShareBundleIds` 同套脱敏——访客拿不到真实 tripId 无法直连 trips/:id/events，故必须 share 专用端点）；天气走 `GET /api/share/:token/weather`（react-query，`useShareWeather`，响应无 id 可泄）
  - 在线名单（presence）：SSE 连接建立/断开（`stream.onAbort`）→ `PresenceRegistry`（events.ts）→ 行程频道广播 presence 事件（join/leave 携带全量 viewers，前端整包替换）。owner=「主人」、guest=昵称（displayName ?? label，60s 缓存）、share 订阅者=「访客」（脱敏）；同一页面多组件（PresenceBar/ActivityFeed/协作面板）经 `subscribeTripEvents` 多路复用共享一条 EventSource，避免重复连接把名单算重。`GET /trips/:id/presence` 快照端点供首屏；#17 面板的 90s 近似保留为 presence 不可用时兜底
  - 动态流（谁改了什么）：`trip_activity` 表（id/trip_id cascade/actor_kind/actor_label/action/summary/created_at），`TripService.recordActivity` 在写操作完成后落库 + 滚动保留最近 50 条（超删旧）+ SSE 推 activity 事件；summary 完整句子服务端生成（三端一致），`Actor` 扩展为 `"human" | "agent" | { guest: 昵称 }`（DB 列 createdBy 等仍是二值，guest 归属只记在 trip_activity）；只记结构性变更（增删地点/排程/酒店/须知/概要/行程/预算），字段级微调（update_place/set_leg_mode）刻意不记防刷屏。REST 拉取 `GET /trips/:id/activity`（owner+guest 可读）
  - 编辑防冲突：SSE 整包替换 vs 编辑中表单——`useSyncedInput`（web lib）受控草稿在 focus/IME 组合期间跳过外部同化，失焦后照常对齐；DaySummaryRow/NoteRow/TransitRow 的 React key 去掉可变内容（旧 key 含 summary/时刻文本，bundle 刷新即重挂载卸掉编辑中的 input）

## 代码组织

```
apps/server
  src/acp/        ACP 会话管理（sessionManager.ts ~750 行；permissions.ts 四层权限策略；
                  prompts.ts bootstrap prompt；terminal 协议支持）
  src/mcp/        MCP 工具面：tools.ts（31 个工具 + scoped token 鉴权，含 add_to_trip/remove_from_trip
                  （加入/移出行程）、
                  add_transit_entry/update_entry（大交通 entry，transitMode=flight/train/drive/bus，
                  drive 走真实路由）、suggest_day_clusters（区域聚类分天建议）、
                  set_start_date/set_end_date（出发/结束日期，对话中说「9/23 出发」「玩到 9/28」时写回
                  trip.startDate/endDate）、set_leg_mode（手动覆盖市内交通段方式，9 值含 ferry/metro/light_rail/train/bus 子类型，modeOverride）、
                  recommend_hotel_area（多信号加权推荐住宿区域：每日首末锚点+大交通到发节点加权，
                  segments 按未被酒店覆盖的天段/途经地分段给建议）、unselect_hotel（取消单个
                  已选定酒店）、unschedule_place（按 placeId 撤销其全部日程并退回候选）、
                  set_day_summary（排天时撰写每日概要）、add_trip_note/update_trip_note/remove_trip_note
                  （行程级注意事项，按目的地/日期预填与维护）、get_weather（按天天气预报））、
                  app.ts（HTTP 端点）
  src/services/   tripService.ts（编排/顺路算法核心；含每日概要兜底生成、trip_notes CRUD、
                  trip_activity 动态流记录与滚动清理 #19）、
                  geo.ts（provider 抽象；overseasFetch 为全部零 key 海外上游的统一出口）、
                  weather.ts（Open-Meteo 按天预报，内存短缓存 30min）、settings.ts（全局设置：
                  高德 key 的 DB 覆盖 + env 兜底，/api/settings 响应掩码 amapServerKey）、
                  routing.ts、mappers.ts（DB 行 → DTO）、chatStore.ts
  src/routes/     api.ts（REST + SSE 全部端点；含 #19 的 /share/:token/events|weather 公开端点、
                  /trips/:id/activity|presence 读端点、SSE presence 上报与 actor 注入）、
                  api.collab.test.ts（#19 协作实时体验测试）
  src/db/         schema.ts（drizzle 表定义；含 #19 的 trip_activity 表）、client.ts、migrate.ts
  src/events.ts   EventBus（发布-订阅）+ PresenceRegistry（#19 在线名单注册表：SSE 连接
                  join/leave → 行程频道广播 presence 事件）
  drizzle/        迁移 SQL（随库提交；注意被 .gitignore 的是根 /drizzle/，apps/server/drizzle/ 正常跟踪）
  scripts/        fake-acp-agent.mjs（可脚本化假 agent）、smoke.ts（端到端冒烟）
apps/web
  src/features/   map（amapRenderer + maplibreRenderer 双渲染器 + 途经地标记层）、chat、
                  itinerary（时间轴；stops.ts 多城市 day→stop 推导/环线闭合；
                  intensity.ts 每日强度标签推导；weather.tsx 天气徽章 + useTripWeather/useShareWeather）、
                  candidates（候选池：candidate/joined 状态机；多城市按 cityName 分桶）、
                  settings（设置抽屉：密钥 + agent CLI）、
                  notes（行程级注意事项面板，7 类结构化增删改）、
                  presence（#19 在线名单：usePresence + SSE 多路复用 subscribeTripEvents）、
                  activity（#19 动态流「谁改了什么」：react-query + SSE 增量）、
                  budget —— 按领域划分
  src/pages/      TripListPage / TripPage / SharePage（/share/:token 只读分享；#19 起订阅
                  /api/share/:token/events 实时刷新 + share 天气）
  src/components/ui/  Radix + CVA 的 shadcn 风格基础组件
  src/stores/     tripStore.ts（zustand：bundle 全量快照 + SSE 增量合并）
  src/lib/api.ts  新端点客户端契约单点（设置 / agent 注册 / 候选状态机 / 时间轴 /
                  #19 activity/presence/share-weather），既有端点在 src/api/client.ts，新代码不要往那里加
  src/lib/useSyncedInput.ts  #19 编辑防冲突：受控输入草稿在 focus/IME 组合期间跳过外部同化
                              （SSE 全量刷新不冲掉正在编辑的表单）
packages/shared/src/domain.ts   枚举 / DTO / 请求体 / SSE 事件 / 格式化工具（zod schema）
```

## 常用命令

```bash
# just 封装（justfile，等价于下面的 pnpm 命令；just --list 查看全部）
just setup            # 首次初始化：install + .env + migrate（SQLite 文件库，无需起数据库）
just up / just down   # 后台起/停 server + web；日志在 .logs/
just status / just logs [svc]
just tauri-dev        # Tauri 桌面壳 dev（前置 just up 已跑）
just package          # Tauri 打 dmg（含签名校验），产物复制到仓库根 dist/（深路径 apps/tauri/src-tauri/target/release/bundle/dmg/）
just smoke-sidecar    # sidecar 启动烟：从 dmg 拷出 .app 注入壳同款 env 直跑 sidecar，断言 /healthz ok（M106，CI release 同款）
just icon             # 从 apps/web/public/icon-1024.png 重生成图标种子

# 首次启动
pnpm install
cp .env.example .env && cp .env.example apps/server/.env   # dotenv 从 server 目录读取
pnpm db:migrate         # 初始化 SQLite（默认 ~/.yarnball/yarnball.db，DATABASE_URL 可改路径）
                        # 旧 Postgres（M80 前）数据迁移：pnpm -C apps/server migrate:pg-legacy
pnpm dev                # 并行起 server (:18788) + web (:15173)

# 单端 / 其他
pnpm dev:server         # tsx watch src/main.ts
pnpm dev:web            # vite
pnpm tauri:dev          # 透传 apps/tauri（Tauri 桌面壳 dev，前置 pnpm dev 起 vite+server）
pnpm tauri:package      # 透传 apps/tauri 打 dmg（sidecar + web 产物）
pnpm build              # pnpm -r build（server: tsc --noEmit；web: tsc -b && vite build；shared: tsc --noEmit）
pnpm test               # vitest run（server；目前无测试文件，测试主要靠 smoke）
pnpm smoke              # fake-acp-agent 端到端冒烟：prompt 流 / permission 停泊 / MCP 真实调用
                        # 前置：pnpm dev 已运行、DB 已迁移
pnpm verify             # 提交前质量门：build + smoke 串行，任一失败即红；前置同 smoke
                        # （脚本本身假设 server 环境就绪，不负责起服务；
                        #  CI 里由 .github/workflows/ci.yml 起 server :18789 后跑同一条 verify）
pnpm db:generate        # 改完 schema.ts 后生成迁移 SQL（drizzle-kit generate）

# 发布：没有 pnpm 命令，push tag v* 触发 .github/workflows/release.yml——
# 复用 ci.yml 质量门（workflow_call）后在 macOS arm64 runner 打 dmg 附 GitHub Release；
# tag（去 v 前缀）须与 tauri.conf.json 的 version 一致（v0.1.0 ↔ 0.1.0），带 - 后缀自动 prerelease。
# 版本号两处同步（release.yml 的 tag 校验会同时核对，不一致直接红）：
#   - apps/tauri/src-tauri/tauri.conf.json 的 version（dmg 文件名 / 壳版本）
#   - apps/server/package.json 的 version（/healthz 下发的 version，排障与壳探测看它）
#
# 签名约定（v0.2.x 起）：tauri.conf.json 的 bundle.macOS.signingIdentity="-"（ad-hoc）。
# 不配 identity 时 tauri-bundler 完全跳过签名，主可执行只剩链接期 ad-hoc 签名
# （Sealed Resources=none），带 quarantine 的下载产物会被 Gatekeeper 报「已损坏」；
# "-" 让 bundler 在打 dmg 前 codesign 封印整个 .app（含 sidecar 嵌套二进制）。
# 打包链路的 verify:sign（apps/tauri/scripts/verify-sign.mjs）对 bundle/macos 与 dmg 内的
# .app 跑 codesign --verify --deep --strict，并断言 sidecar 不带未配 entitlements 的
# hardened runtime flag，不过则 fail（本地 just package 与 CI 同一脚本）；
# spctl 对 ad-hoc 必拒（无 Developer ID），只作信息项不卡门槛。
#
# hardened runtime 约定（M106）：tauri.conf.json 配 "hardenedRuntime": false。
# tauri-bundler 默认 hardenedRuntime=true，会给 sidecar（Node SEA）也带上 runtime flag
# 且无 entitlements——V8 需要可写可执行内存，硬化运行时下 sidecar 启动即
# EXC_BREAKPOINT(SIGTRAP)，用户看到的是首启卡 splash（壳等 healthz 超时）。
# ad-hoc 无公证场景下 hardened runtime 本就零收益（Gatekeeper 不评估 ad-hoc 产物），
# 故直接关掉。若未来上 Developer ID + 公证，改走 entitlements 路线（恢复 hardenedRuntime，
# 为 sidecar 配 com.apple.security.cs.allow-jit / allow-unsigned-executable-memory；
# 注意 tauri 的 entitlements 配置对主 app 与 sidecar 统一生效，主 app 是 wry 不需要 JIT）。
# CI 另有 sidecar 启动烟兜底（release.yml 的 smoke:sidecar 步）：从 dmg 拷出 .app 注入壳同款
# env 直跑 sidecar，断言 /healthz ok——签名再对也查不出运行时崩溃，只有真跑能拦住；
# 本地对应 pnpm -C apps/tauri smoke:sidecar（just smoke-sidecar）。
```

## 代码约定

- **注释与文档用中文**；提交信息也用中文（如「Agent 面板去标题条：红绿灯换成一个收起把手」）
- 数据模型/请求体/事件一律先在 `packages/shared/src/domain.ts` 定义 zod schema，三端共用，不要各写一份类型
- DB 行 → DTO 的映射统一在 `apps/server/src/services/mappers.ts`；列名显式 snake_case；主键为应用侧 `crypto.randomUUID()` 生成的 UUID 文本
- 服务端 tsconfig 为 `module: NodeNext`，相对 import 必须带 `.js` 后缀（如 `./db/client.js`）
- 服务端 `strict: true`、`noEmit`（dev 靠 tsx，生产目前也主要靠 tsx/直跑）
- 前端组件用函数组件 + hooks；状态走 zustand store，服务端数据用 react-query / SSE 订阅
- 动态接口数据（如天气，会随时间变化、非行程事实）走 react-query 缓存/刷新，**不进 zustand bundle**；bundle 只承载行程数据快照
- SSE 的 bundle 事件是**服务端全量快照，前端直接替换**（单机数据量小，全量最可靠），不要在前端做增量合并优化
- Tauri 壳新增 `#[tauri::command]` 必须同步两处 ACL 声明（M104 export_pdf 漏配被「Command xxx not allowed by ACL」拦截的教训）：`src-tauri/build.rs` 的 `AppManifest::commands`（自动生成 `allow-<cmd>` 权限，下划线转连字符）+ `capabilities/default.json` 引用该权限；注意生产态窗口加载 sidecar 回源 `http://127.0.0.1:<port>`，tauri 归类为 remote 来源，能力必须带 `remote.urls` 段权限才对壳内生效
- **macOS 原生面板/模态必须跑在主线程，且主线程绝不能阻塞等其结果**：Tauri 同步命令在 macOS 直接跑在主线程（wry `send_user_message` 有主线程 inline 快路径），命令体内「弹模态后 `rx.recv()` 等结果」会自锁——面板出现后全 app 冻结（M107 export_pdf 死锁：sheet 的完成回调要靠主线程事件循环驱动，而主线程已被 recv 泊死）。需要用户交互的系统对话框优先走插件的 JS 入口（如 `plugin:dialog|save` 是 async 命令，跑在 tokio 工作线程，阻塞等待不碰主线程事件循环）；确需在 Rust 侧弹面板的，只能在工作线程调用并经 `run_on_main_thread` 调度

## Agent 集成关键点（改这块前先读 README 和对应源码）

- **MCP 鉴权**：每个 chat session 一个 token（随机 32 字节，DB 存 sha256）；`/mcp` 每请求从 `Authorization: Bearer` + `x-yarnball-session-id` header 重解析并绑定到该会话的 trip —— agent 永远只能操作当前会话的行程（`src/mcp/tools.ts`）
- **ACP 权限四层策略**（`src/acp/permissions.ts`）：Yarnball MCP 工具自动批准 → 只读 kind 自动批准 → 会话级 allow-all → 停靠到 UI 等用户 120s
- **bootstrap prompt**（`src/acp/prompts.ts`）钉死「坐标必须来自 search_poi」纪律 + 海外英文搜索提示 + 国内开源引擎行程的「search_poi 用官方全名、公交为估算」纪律（M113，按 trips.country 判定）+ 多城市纪律（search_poi 传 city、add_place 带 cityName、城际移动走 add_transit_entry、自驾段 transitMode=drive）+ 行程信息引导（目的地/日期确定后 add_trip_note 预填注意事项、排天时 set_day_summary 写每日概要）；恢复会话走 `session/new` + 压缩转录回放（ACP `session/load` 待 SDK 封装）
- **大交通与预订状态**：`add_transit_entry` / `update_entry` 管理大交通 entry（🛬抵达 / 🛫离开 / 🚄城市间，departTime/arriveTime 是排程硬锚点）；地点带 `openingHours`（营业时间，排期完全无交叠时前端告警）与 `bookingStatus`（无需预订/待预订/已预订，UI 可点选流转）；`suggest_day_clusters`（对应 REST `GET /api/trips/:id/suggest-clusters`）多城市先按途经地分组、组内按地理位置聚类（k 按点数自适应 1-4，不被已建天数截断），同城天优先分配给出分天建议
- 验证 agent 链路改动**不依赖真 agent**：用 `pnpm smoke`（fake-acp-agent.mjs 是可脚本化的假 ACP agent）

## 环境变量与安全

- 见 `.env.example`；无必填项（`DATABASE_URL` 为 SQLite 文件路径，可选，默认 `~/.yarnball/yarnball.db`；M80 起 `postgres://` 等无法识别的 scheme 会直接报错退出，不再被当成文件路径），其余有默认值（`SERVER_PORT=18788`、`WEB_ORIGIN=http://localhost:15173`、`SERVER_BASE_URL` 默认 loopback）
- `SERVER_HOST` 默认 `127.0.0.1`（推荐保持）。v0.4 起 `/api` 已按 principal 鉴权（loopback 无 token=owner、Bearer owner token=owner、access-link token=guest、远程匿名 401），绑 `0.0.0.0` 不再是无条件 RCE——但 agents（spawn agent 子进程）/ settings / chat-sessions 等敏感端点仍仅 owner 可达，最小暴露原则不变。绑定非 loopback 地址需 `YARNBALL_ALLOW_REMOTE=1` 显式确认（#21），未设置时启动打显著警告并指向 README「让同伴访问」部署指南（局域网 / tailscale / cloudflared / frp；纯 HTTP 明文公网会泄露 token，必须走 TLS）。Tauri 桌面壳场景保持默认即可
- 生产态 server 直接托管 web 静态产物：探测到 `apps/web/dist/index.html`（或 `YARNBALL_WEB_DIST_DIR` 指定目录，Tauri 打包后由壳注入）即挂载 serve-static + SPA 回退，`/api` `/mcp` `/healthz` 优先不受影响；dev（vite :15173）无 dist 时行为不变（`apps/server/src/services/staticWeb.ts`）
- `/healthz` 返回 `{ ok, app:"yarnball", version, webStatic }`：Tauri 壳靠 `app`/`webStatic` 判定 18788 占用者身份——同包且托管 web 产物才复用，否则换端口，避免窗口被指向旧版孤儿 sidecar 的 404（`apps/tauri/src-tauri/src/sidecar.rs`）
- 高德三个 key（`AMAP_JS_KEY` / `AMAP_SERVER_KEY` / `AMAP_JS_SECRET`）是**国内行程的可选增强**（M113 起不再是国内必需）：配齐后新建国内行程走高德（POI 搜索/真实公交数据更准）；未配 key 时新建国内行程自动走 OSM 开源栈（与海外同代码路径，零配置可用，公交为估算），海外行程始终零配置。仅存的降级路径：M113 前创建的存量 amap 行程在无 key 环境仍是高德引擎——POI 搜索不可用、路线降级直线距离 × 1.3 估算（配 key 即恢复）
- 海外上游请求（Photon / Nominatim / OSRM / Open-Meteo / transitous，见 `geo.ts` 的 `overseasFetch`）支持标准代理环境变量：`https_proxy > all_proxy > http_proxy`（大小写均认），遵守 `no_proxy`；未设置时直连。国内高德请求永远直连，不走代理。transitous 走带版本/联系方式的专用 UA（TRANSITOUS_UA），其余上游共用 OSM_UA
- `.env` 不入库；MCP token 只存 hash；agent 经 `session/new` 注入的 URL+header 直连 `/mcp`，不经浏览器
- 前端渲染 agent 文本用 marked + sanitize-html，不要绕过 sanitize 直接 `dangerouslySetInnerHTML`

## 已知边界（v0.4）

- 多人协作已支持（v0.4 里程碑 #16-#21）：owner 本机编辑 + 协作链接同伴（viewer 只读 / editor 可编辑）+ 只读分享链接（`/share/:token`），实时体验含 SSE 同步 / 在线名单 / 动态流；并发编辑语义为 last-write-wins，无 CRDT（留待 v2）
- 远程访问（局域网 / 公网隧道）的部署形态与安全口径见 README「让同伴访问」；web 界面暂无 owner token 登录入口，主人远程用 UI 时推荐以同伴协作链接形态浏览
- 海外公交走 transitous（MOTIS 2）真实换乘：覆盖城市命中真实线路/方式/分段；未覆盖（如部分小城返回空 itineraries）、超时或错误时降级为估算（真实驾车路由时长 × 1.25 + 换乘惩罚），transitous 为社区 best-effort 服务无 SLA。国内公交：高德引擎行程走高德真实数据，开源引擎回退行程（M113）为估算（transitous 国内 GTFS 无覆盖）；transitous 未命中时的渡轮仍按直线水域航线估算（含候船缓冲）
- Photon / OSRM / transitous 是社区免费服务，高频使用应自托管（代码里换 base URL 即可）；transitous usage policy 要求 UA 带联系方式 + UI 署名 transitous.org（已在设置抽屉底部，改动时不得删除）
- ACP `session/load` 直连与 `session/cancel` 通知通道待 SDK（ActiveSession 封装）暴露后补
