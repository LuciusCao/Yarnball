<div align="center">

<img src="apps/tauri/src-tauri/icons/128x128@2x.png" width="128" alt="毛线团 app 图标" />

# 毛线团（Yarnball）

基于地图的旅行攻略编辑器 —— **Agent-native**，国内海外双引擎

[![CI](https://github.com/LuciusCao/Yarnball/actions/workflows/ci.yml/badge.svg)](https://github.com/LuciusCao/Yarnball/actions/workflows/ci.yml)
[![Release](https://github.com/LuciusCao/Yarnball/actions/workflows/release.yml/badge.svg)](https://github.com/LuciusCao/Yarnball/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

传统攻略按内容组织（清单式的餐厅/景点/酒店列表），毛线团按**空间和时间**组织：行程是地图上的节点 + 节点间的交通段，按天串联。你在右侧悬浮面板里与**自己的 agent** 对话（ACP 接入，如 `kimi acp`、`gemini acp`、`claude-code-acp`），agent 通过 MCP 工具直接读写行程数据结构，全屏地图实时刷新。

```
粘贴攻略 → agent 解析地点 → search_poi 拿真实坐标 → 编排到各天
  → 地图实时出点连线 → 顺路度分析（Bondi Beach 放哪天最顺）→ 酒店候选与推荐区域
```

## 特性

- **地图即行程**：地点是地图上的节点，交通段按距离自动选步行 / 公交 / 驾车并取真实路径
- **坐标零编造**：agent 建点必须先走 POI 搜索拿真实坐标，且必须落在行程途经地附近，越界直接拒绝——不信 agent 的「记忆」，只信搜索结果
- **国内 / 海外双引擎**：创建行程时按目的地自动切换（国内高德 / 海外 Photon + OSRM 免费服务），搜索、路线、地图渲染全链路同一引擎，坐标系不混用；**海外行程零配置、零 key**
- **顺路引擎**：每天的顺序优化建议；任意地点插入某天各位置的时间增量分析（「Bondi Beach 放哪天最顺」）
- **多城市行程**：途经地按天分组，城际大交通（飞机 / 火车 / 自驾 / 大巴）作为时间轴锚点，自驾段取真实公路里程
- **酒店决策**：候选池、按行程地点分布推荐住宿区域、多晚行程分段选酒店
- **营业时间与预订状态**：地点排在营业时间外会告警；无需预订 / 待预订 / 已预订可点选流转
- **预算**：按住宿 / 美食 / 门票分类汇总，可设币种与出行人数，超支与未定价一目了然
- **只读分享链接**：`/share/:token` 发给同行的人

## 安装（macOS · Apple Silicon）

从 [Releases](https://github.com/LuciusCao/Yarnball/releases) 下载最新 dmg，拖进「应用程序」。

> 未做 Developer ID 签名与公证：首次打开若被 Gatekeeper 拦截，请右键 App →「打开」，或在「系统设置 → 隐私与安全性」点「仍要打开」。

也可以从源码运行，见下。

## 从源码运行

前置：Node 22+、pnpm、一个 ACP agent（本机装好 `kimi` 或 `gemini` CLI）。数据库为内嵌 SQLite，无需 Docker。

```bash
git clone https://github.com/LuciusCao/Yarnball.git
cd yarnball
pnpm install
cp .env.example .env && cp .env.example apps/server/.env   # 海外行程零配置；国内行程填 AMAP_*（见下）
pnpm db:migrate      # 初始化 SQLite（默认 ~/.yarnball/yarnball.db，可用 DATABASE_URL 改路径）
pnpm dev             # server :18788 + web :15173
```

打开 http://localhost:15173 → 创建行程（填 "Sydney" 或 "杭州"）→ 右侧面板选择 agent 连接 → 粘贴攻略文本。

### 国内行程需要高德 key

到[高德开放平台](https://lbs.amap.com)申请两个 key：「Web端(JS API)」用于前端地图渲染，「Web服务」用于 POI 搜索与路线规划，填入 `.env` 的 `AMAP_JS_KEY` / `AMAP_SERVER_KEY`（2021-12 之后申请的 JS key 还需配套 `AMAP_JS_SECRET`）。海外行程不需要任何 key。

## Agent 手册（MCP 工具）

agent 接入后经 MCP 自动发现全部工具，无需人工配置。每个会话一个 scoped token，agent 只能操作当前会话绑定的行程。能力面：

| 能力 | 工具 |
|---|---|
| 行程全貌 | `get_trip_context`（会话开始先调这个） |
| POI 搜索 | `search_poi`（建任何地点前的必经步骤） |
| 地点库 | `add_place` / `update_place` / `remove_place` / `lock_place` / `unlock_place` |
| 每日编排 | `add_place_to_day` / `move_entry` / `remove_entry` / `reorder_day` / `unschedule_place` |
| 顺路分析 | `analyze_detour` / `suggest_day_order` / `suggest_day_clusters` |
| 大交通 | `add_transit_entry` / `update_entry`（flight / train / drive / bus） |
| 市内交通 | `get_route` / `set_leg_mode` |
| 酒店 | `add_hotel_candidate` / `select_hotel` / `unselect_hotel` / `recommend_hotel_area` |
| 日期与预算 | `set_start_date` / `set_end_date` / `set_budget` |

## 开发

```bash
pnpm verify   # 提交前质量门：build（tsc + vite）+ smoke 端到端冒烟
```

前置：`pnpm dev` 已运行、DB 已迁移。CI 在 push main 与 PR 上跑同一条 verify；push `v*` tag 触发 release——先过质量门，再打 dmg 附到 GitHub Release（tag 须与应用版本一致，如 `v0.1.0` ↔ `0.1.0`）。架构与代码约定见 [AGENTS.md](AGENTS.md)。

## 已知边界

- 单人编辑 + 只读分享链接；多人实时协同（CRDT）留待 v2
- 海外公交路线为估算值（免费公交路由服务不存在）；国内公交走高德真实数据
- Photon / OSRM 是社区免费服务，高频使用建议自托管（代码里换 base URL 即可）
- 未配高德 key 时国内降级：路线按直线距离估算、POI 搜索不可用；海外不受影响

## 环境变量

见 [.env.example](.env.example)。

## License

[MIT](LICENSE)
