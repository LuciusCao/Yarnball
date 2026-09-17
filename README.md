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
- **多人协作**：把行程发给同行的人——只读链接只看，可编辑链接能一起改（地图与时间轴实时同步、在线名单、「谁改了什么」动态流），链接随时可吊销

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

## 让同伴访问

同伴不需要安装任何东西——用浏览器打开你发的链接即可。开始前先弄清两种凭证的分工：

| 凭证 | 在哪生成 | 给谁用 | 权限 |
|---|---|---|---|
| **协作链接**（`/join/:token`） | 行程页右上「分享与协作」面板 | 同行的人 | 按链接角色：**只读**（看行程）或**可编辑**（一起改）；链接可随时吊销，吊销后立即失效 |
| **owner token** | 设置 → 远程访问凭证 | 你自己（在别的设备上） | 完整的主人权限（含设置、agent 会话、行程删除）；仅生成时展示一次，重置即旧 token 失效 |

### 前置：让 server 托管前端

同伴直接访问 server 端口（同源，无 CORS 障碍），因此需要 server 处于生产态——即托管 web 静态产物。从源码运行时先构建一次：

```bash
pnpm build        # 产出 apps/web/dist（server 启动时自动探测并挂载）
```

Tauri 桌面版打包时自带 web 产物，无需此步。

### 方式一：局域网（同一 WiFi）

```bash
# apps/server/.env
SERVER_HOST=0.0.0.0        # 监听全部网卡（默认 127.0.0.1 只有本机能访问）
YARNBALL_ALLOW_REMOTE=1    # 显式确认暴露给其他主机（不设则启动打安全警告，见 .env.example）
```

查一下本机 IP（macOS：`ipconfig getifaddr en0`，假设是 `192.168.1.10`），重启 server 后同伴浏览器打开 `http://192.168.1.10:18788`，把行程页「分享与协作」面板里的链接直接发给他们（面板生成的链接自动带你的当前地址）。

注意两点：

- **局域网里的其他人也能访问这个地址**。鉴权按公网标准实现：他们拿不到你的行程数据（须持某个协作链接 token），也碰不到设置 / agent / 删除等主人专属操作；万一某个链接外泄，在面板里吊销即可兜底。最小暴露原则仍建议用完改回 `127.0.0.1`。
- **你自己在局域网的其他设备上**（比如躺在沙发上用 iPad）：浏览器打开 `http://192.168.1.10:18788` 后，行程页与设置页仍会报「需要访问凭证」——本机 loopback 才默认是主人。此时需在设置页生成 owner token 并妥善带入请求（如 API 调试场景的 `Authorization: Bearer <token>`）；日常浏览推荐直接用同伴形态的协作链接。

### 方式二：公网隧道

服务本身只监听 HTTP，**不建议直接把端口暴露到公网**。用隧道时优先选自带加密的方案：

- **Tailscale**（推荐）：你与同伴都装 Tailscale 加入同一 tailnet，之后对同伴来说就是「局域网形态」——访问 `http://<你的-tailscale-ip>:18788`，流量走 WireGuard 加密，无需暴露任何公网端口。设置同方式一（`SERVER_HOST=0.0.0.0` + `YARNBALL_ALLOW_REMOTE=1`）。
- **cloudflared**（免服务器）：在你的机器上运行

  ```bash
  cloudflared tunnel --url http://localhost:18788
  ```

  它会给出一个 `https://<随机名>.trycloudflare.com` 地址，发给同伴即可。Cloudflare 边缘提供 HTTPS，链路加密。

  **安全必读（同机回源提权）**：cloudflared 与 server 同机时，公网流量经它回源，server 看到的来源是本机——若不处理，任何打开隧道地址的人都会被当成主人。因此该形态**必须**同时设置 `SERVER_HOST=0.0.0.0`（或局域网 IP）+ `YARNBALL_ALLOW_REMOTE=1`：绑定非 loopback 后，本机回源来源不再免凭证，公网访客须持协作链接 token，你自己在其他设备上走 `/login` 登录。保持 `127.0.0.1` 监听 + 代理回源是**不安全**的组合（如确需该形态并自担代理过滤责任，显式设 `YARNBALL_TRUST_LOOPBACK=1`；反之 `YARNBALL_TRUST_LOOPBACK=0` 可在 loopback 绑定下也要求凭证）。
- **frp 等自建转发**：可用，但你必须**自备 TLS**（在 frp 前面挂反向代理签证书，或用 frp 的 https2http 插件），否则落到公网的就是明文 HTTP；同机转发同样适用上面的回源提权注意（改绑 `0.0.0.0` 或局域网 IP）。

> **为什么强调 TLS**：纯 HTTP 公网下，协作链接 token / owner token 都以明文经过链路，任何中间节点都能窃听、甚至原样重放。鉴权再严也防不住明文传输——公网请务必走 HTTPS。

### Agent 手册（MCP 工具）

agent 接入后经 MCP 自动发现全部工具，无需人工配置。每个会话一个 scoped token，agent 只能操作当前会话绑定的行程。能力面：

| 能力 | 工具 |
|---|---|
| 行程全貌 | `get_trip_context`（会话开始先调这个） |
| POI 搜索 | `search_poi`（建任何地点前的必经步骤） |
| 地点库 | `add_place` / `update_place` / `remove_place` / `add_to_trip` / `remove_from_trip`（加入/移出行程） |
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

- 多人协作已支持（可编辑链接实时同改），但同一字段的并发编辑是「后写覆盖」而非逐字合并（CRDT 留待 v2）；页面刷新即取最新快照
- 远程（局域网 / 隧道）场景下，主人在其他设备上用 `/login` 粘贴 owner token 登录（#32；本机 loopback 免登录）；误粘协作链接 token 会被明确提示
- 海外公交路线为估算值（免费公交路由服务不存在）；国内公交走高德真实数据
- Photon / OSRM 是社区免费服务，高频使用建议自托管（代码里换 base URL 即可）
- 未配高德 key 时国内降级：路线按直线距离估算、POI 搜索不可用；海外不受影响

## 环境变量

见 [.env.example](.env.example)。

## License

[MIT](LICENSE)
