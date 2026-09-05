# 毛线团（Yarnball）

基于地图的旅行攻略编辑器 —— **Agent-native**，国内海外双引擎。

传统攻略按内容组织（清单式的餐厅/景点/酒店列表），毛线团按**空间和时间**组织：行程是地图上的节点 + 节点间的交通段，按天串联。你在右侧悬浮的 mac 毛玻璃面板里与**自己的 agent** 对话（ACP 接入，如 `kimi acp`、`gemini acp`、`claude-code-acp`），agent 通过 MCP 工具直接读写行程数据结构，全屏地图实时刷新。

```
粘贴攻略 → agent 解析地点 → search_poi 拿真实坐标 → 编排到各天
  → 地图实时出点连线 → 顺路度分析（Bondi Beach 放哪天最顺）→ 酒店候选与推荐区域
```

## 地理引擎（国内/海外自动切换）

创建行程时按目的地自动判定 provider，搜索/路线/矩阵/地图渲染全链路走同一 provider（坐标系不混用）：

| | 国内（amap） | 海外（osm） |
|---|---|---|
| POI 搜索 | 高德地点搜索 | Photon（komoot，零 key） |
| 路线规划 | 高德步行/驾车/公交 | OSRM（FOSSGIS，步行/驾车；公交为估算） |
| 距离矩阵 | 高德 distance API | OSRM table API |
| 地图渲染 | 高德 JSAPI 2.0（GCJ-02） | MapLibre GL + OSM 瓦片（WGS84，零 key） |

**海外行程完全零配置可用**——不需要任何 API key。海外搜索的全球同名地点会按行程城市 150km 内过滤（科罗拉多的 "Sydney Opera House" 不会混进来）。

## 架构

三层分离（与 [agent-legion](https://github.com/lucius/agent-legion) 验证过的模式同构）：

```
Browser ── REST(人类直接编辑) + SSE(实时刷新) ──┐
                                                │
Hono Server                                     │
  ├─ /api/*        REST + SSE（交互面）          │
  ├─ /mcp          MCP streamable HTTP（工具面） ◄─ agent 经 session/new 注入的
  │                 scoped token 调用             │ URL+header 直连
  └─ AcpSessionManager（对话面）                  │
       └─ spawn agent 子进程（stdio JSON-RPC）    │
            prompt / session/update /             │
            permission / terminal 协议            │
```

- **ACP client**（`@agentclientprotocol/sdk`）：每会话一个 agent 子进程；permission 四层策略（Yarnball 工具自动批准 → 只读 kind 自动批准 → allow-all → 停靠 UI 120s）；terminal 协议五方法（kimi 的 Bash/Grep 依赖）；bootstrap prompt（钉死「坐标必须来自 search_poi」纪律 + 海外英文搜索提示）；压缩转录回放恢复
- **MCP server**（`@modelcontextprotocol/sdk`，stateless streamable HTTP）：每请求从 header 重解析 scoped token，绑定到会话的 trip；20 个工具（get_trip_context / search_poi / add_place / add_place_to_day / add_transit_entry / update_entry / analyze_detour / suggest_day_order / suggest_day_clusters / lock_place / unlock_place / add_hotel_candidate / select_hotel …）
- **顺路引擎**：provider 距离矩阵 + 最近邻 + 2-opt 重排；插入位置全枚举的时间增量分析；交通段自动计算（<2km 步行 / 其余驾车，真实路径 polyline）
- **UI**：全屏地图打底，mac 毛玻璃浮层（traffic lights：红=隐藏 / 黄=收成竖条 / 绿=展开），Day 筛选 chips，酒店推荐区域圆
- **防编造校验**：agent 建点时坐标必须落在目的城市附近（国内 150km / 海外 300km），越界拒绝并引导先 search_poi

## 快速开始

前置：Node 22+、pnpm、Docker、一个 ACP agent（本机装好 `kimi` 或 `gemini` CLI）。**海外行程无需任何 key**；国内行程需[高德开放平台](https://lbs.amap.com)两个 key（「Web端(JS API)」+「Web服务」）。

```bash
pnpm install
cp .env.example .env        # 海外行程可跳过 key；国内行程填 AMAP_*
cp .env.example apps/server/.env  # dotenv 从 server 目录读取
docker compose up -d db     # Postgres 16 (localhost:5433)
pnpm db:migrate
pnpm dev                    # server :18788 + web :15173
```

打开 http://localhost:15173 → 创建行程（填 "Sydney" 或 "杭州"）→ 右侧面板选择 agent 连接 → 粘贴攻略文本。

### 验证（不依赖真 agent）

```bash
pnpm smoke                  # fake-acp-agent 端到端：prompt 流 / permission 停泊 / MCP 真实调用
```

## Agent 手册（MCP 工具）

| 工具 | 说明 |
|---|---|
| `get_trip_context` | 行程全貌 + 用户 UI 选中态；会话开始先调这个 |
| `search_poi` | 高德地点搜索；**建任何地点前的必经步骤** |
| `add_place` / `update_place` / `remove_place` | 地点库 CRUD |
| `add_place_to_day` / `move_entry` / `remove_entry` / `reorder_day` | 每日行程编排（立即生效，地图实时刷新） |
| `analyze_detour` | 顺路度：某地点插入某天各位置的时间增量 + 最优位置 |
| `suggest_day_order` | 顺序优化建议（最近邻 + 2-opt，只建议不生效） |
| `get_route` | 两点路线（步行/驾车/公交） |
| `add_hotel_candidate` / `select_hotel` | 酒店候选与选定 |

## 目录

```
apps/server
  src/acp/        ACP 会话管理（spawn/permission/terminal/bootstrap prompt）
  src/mcp/        MCP 工具面（tools 注册 + streamable HTTP 端点 + token）
  src/services/   TripService（编排/顺路算法）、geo（高德 provider+缓存+降级）
  src/routes/     REST + SSE
  scripts/        fake-acp-agent.mjs（可脚本化假 agent）、smoke.ts（端到端）
apps/web          React 19 + Vite + Tailwind 4（地图 2/3 + 对话/行程/酒店 1/3）
packages/shared   zod schema 单一定义点（REST/MCP/前端三处共享）
```

## 已知边界（v1）

- 单人编辑 + 只读分享链接（`/share/:token`）；多人实时协同（CRDT）留待 v2
- 海外公交路线为估算值（驾车时长 × 1.25 + 换乘惩罚）——免费公交路由服务不存在；国内公交走高德真实数据
- Photon/OSRM 是社区免费服务，高频使用时请自托管（Photon / OSRM 均可 docker 部署），代码里换 base URL 即可
- resume 走 session/new + 6k 字符压缩转录回放（kimi 的 session store 不可靠，agent-legion 同款降级）；ACP `session/load` 直连留待 SDK 暴露 ActiveSession 封装
- cancel 按钮的 ACP `session/cancel` 通知通道待补（SDK ActiveSession 未封装，需要底层 connection 直发）
- 无 key 降级：国内行程未配高德 key 时路线用直线距离 × 1.3 系数估算、POI 搜索不可用；海外行程不受影响

## 环境变量

见 `.env.example`。`SERVER_BASE_URL` 默认 `http://127.0.0.1:18788`（agent 子进程连 MCP 的基址，同机部署不用改）。
