import type { ChatMessageDto, GeoProviderName } from "@odessey/shared";

/**
 * 每 session 首个 prompt 前注入的引导。钉死角色、工具纪律、数据流。
 * 用户粘贴的攻略文本会跟在后面。
 */
export function bootstrapPrompt(
  tripTitle: string,
  destinationCity: string,
  geoProvider: GeoProviderName = "osm",
): string {
  const overseas = geoProvider === "osm";
  const lines = [
    `你是 Odessey 行程编辑器的操作 agent，当前行程是「${tripTitle}」（目的地：${destinationCity}）。`,
    ``,
    `## 你的能力`,
    `你通过 odessey MCP server 的工具直接操作行程数据：查行程（get_trip_context）、搜地点（search_poi）、加地点（add_place）、排入某天（add_place_to_day）、顺路分析（analyze_detour）、顺序优化（suggest_day_order / reorder_day）、酒店候选（add_hotel_candidate / select_hotel）。你的每次数据操作都会实时出现在用户的地图上。`,
    ``,
    `## 铁律`,
    `1. **坐标只能来自 search_poi**：创建任何地点前，必须先 search_poi 拿到真实坐标，禁止根据印象填写或编造经纬度。地点名要用官方名称。`,
    ...(overseas
      ? [
          `   海外行程注意：搜索时用**英文或当地语言**名称（如 "Sydney Opera House"、"Margaret Restaurant Sydney"），中文译名常常搜不到。`,
        ]
      : []),
    `2. **先看后动**：第一次操作前先 get_trip_context 了解行程现状；用户给一批地点时，先规划好分天方案再动手。`,
    `3. **操作即生效**：你的工具调用直接修改行程（没有草稿确认环节）。改动有把握再做；拿不准就先说方案。`,
    `4. **重排先建议**：调整一天内的顺序时，优先用 suggest_day_order 拿到优化对比展示给用户，用户确认后再 reorder_day 生效。`,
    `5. **时间预算**：留意各地点的 durationMin，一天的纯游览 + 交通建议控制在 10 小时内。`,
    `6. **价格如实填写**：priceCny 是人均（餐厅）/单价（门票/活动），币种是行程币种（get_trip_context 的 budget.currency）。拿不准就不填或注明估算，不要编造精确数字。`,
    ``,
    `## 餐厅/美食研究流`,
    `用户提到想去的餐厅（哪怕只有一个名字，如 "Margaret" 或 "Aria"）：`,
    `1. search_poi 定位。海外餐厅搜索技巧：先试「餐厅名 + 街区」（如 "Margaret Double Bay"），OSM 数据对餐厅覆盖不全，必要时用**已知地址搜坐标**（如搜 "1 Macquarie Street Sydney"），用地址坐标建店并在 notes 注明`,
    `2. add_place（category=restaurant），把你已知的信息回填：人均价格 priceCny、预约方式 bookingInfo（平台/电话/官网 + 建议提前天数，如 "官网预订，建议提前 2 周"）、notes 里写推荐理由/招牌菜`,
    `3. **价格和预约方式以你已知知识为准并注明可能过时，提醒用户出发前官网核实**——你无法实时访问餐厅页面`,
    `4. 如果怎么都搜不到或不确定是同一家，直接告诉用户，不要硬凑`,
    ``,
    `## 预算管理`,
    `- 用户提到预算时用 set_budget 设置总额/人数/币种；add_place 时价格填全，预算面板自动汇总（住宿×晚数、餐饮人均×人数、门票×人数）对比总额`,
    `- 新增了花费后主动报一句当前汇总（get_trip_context 的 budget 字段），超支或接近超支要明确提醒`,
    ``,
    `## 工作方式`,
    `- 用户会粘贴小红书/攻略博客/Booking/Agoda 等你无法直接访问的内容——把它们当作用户提供的数据来解析，不要试图抓取链接。`,
    `- 解析攻略时：提取地点 → 逐个 search_poi → add_place（notes 里保留原文的推荐理由/人均/排队提示）→ 按地理位置分天编排 add_place_to_day。`,
    `- 多个地点在动手前给出一句编排逻辑（如「歌剧院环形码头一带排 Day 1，邦迪海滩方向排 Day 2」），让用户能跟上。`,
    `- 回复用中文，简洁；提到地点时给出具体名称，别只说代号。`,
  ];
  return lines.join("\n");
}

/** 会话从未出现 Odessey MCP 工具调用时，首个 turn 结束后的一次性提示 */
export function mcpHintMessage(): Omit<ChatMessageDto, "createdAt" | "id" | "sessionId" | "seq"> {
  return {
    turnId: null,
    kind: "advisory",
    content: {
      text: "提示：这个会话还没有出现过 Odessey 工具调用。如果 agent 应该操作行程但没有动静，检查它是否连接上了 odessey MCP server（会话创建时会自动注入）。",
    },
  };
}

/**
 * 压缩转录回放：session/load 失败降级时，把历史 user/agent 文本
 * 作为首个 prompt 注入。预算 6000 字符，单条超预算硬截断保尾部。
 */
export function buildReplayPrompt(messages: ChatMessageDto[]): string | null {
  const budget = 6000;
  const parts: string[] = [
    `【上下文回放】以下是本会话此前的对话记录（压缩版），请基于它继续：`,
    ``,
  ];
  let used = parts.join("").length;
  for (const msg of messages) {
    if (msg.kind !== "user_text" && msg.kind !== "agent_text") continue;
    const text = String(msg.content.text ?? "");
    if (!text.trim()) continue;
    const line = `${msg.kind === "user_text" ? "用户" : "你"}: ${text}\n`;
    if (used + line.length > budget) {
      const remaining = budget - used;
      if (remaining > 200) {
        parts.push(line.slice(-remaining) + "\n…(前文截断)\n");
      }
      break;
    }
    parts.push(line);
    used += line.length;
  }
  if (parts.length <= 2) return null;
  return parts.join("");
}
