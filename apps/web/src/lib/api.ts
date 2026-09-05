import type {
  AddEntryInput,
  AgentAvailability,
  AgentRegistryDto,
  CreateAgentInput,
  EntryDto,
  PlaceDto,
  PlaceStatus,
  SelectHotelInput,
  SettingsDto,
  SetLegModeInput,
  SuggestDayClustersResult,
  TransportMode,
  UpdateAgentInput,
  UpdateEntryInput,
  UpdatePlaceInput,
  UpdateSettingsInput,
} from "@yarnball/shared";

/**
 * UX 重构新增端点的客户端契约（单点）。
 * 设置页（M2）/ 候选池（M3）/ 时间轴（M4）一律从这里消费；
 * 既有端点仍在 ../api/client.ts，新代码不要在那里加方法。
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ---------- 候选状态机 ----------

  /** 锁定/解锁地点（PATCH /api/places/:id/status） */
  setPlaceStatus: (placeId: string, status: PlaceStatus) =>
    request<{ place: PlaceDto }>(`/places/${placeId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  /** 排地点到某天，可带 startTime（HH:MM）（POST /api/trips/:tripId/entries） */
  addEntry: (tripId: string, input: AddEntryInput) =>
    request<{ entryId: string; dayId: string; position: number }>(`/trips/${tripId}/entries`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * 创建大交通节点（POST /api/trips/:tripId/entries，entryType=transit）。
   * 起讫点各给 fromPlaceId（行程内地点，走真实坐标锚定）或 fromName（自由文本）之一，讫点同理。
   */
  addTransitEntry: (
    tripId: string,
    input: Omit<AddEntryInput, "entryType" | "placeId">,
  ) =>
    request<{ entryId: string; dayId: string; position: number }>(`/trips/${tripId}/entries`, {
      method: "POST",
      body: JSON.stringify({ ...input, entryType: "transit" }),
    }),

  /**
   * 编辑 entry（PATCH /api/entries/:id）：startTime/durationMin/note 通用；
   * departTime/arriveTime/fromPlaceId/toPlaceId/fromName/toName 仅 transit entry（传 null 清除）。
   */
  updateEntry: (entryId: string, input: UpdateEntryInput) =>
    request<{ entry: EntryDto }>(`/entries/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  /** 编辑地点字段（PATCH /api/places/:id）：含 openingHours（营业时间）/bookingStatus（预订状态）等 */
  updatePlace: (placeId: string, input: UpdatePlaceInput) =>
    request<{ place: PlaceDto }>(`/places/${placeId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  /** 区域聚类建议（GET /api/trips/:tripId/suggest-clusters，只建议不落库）：未排期地点聚成 1-4 片，建议每天一片 */
  suggestDayClusters: (tripId: string) =>
    request<{ suggestion: SuggestDayClustersResult }>(`/trips/${tripId}/suggest-clusters`),

  /** 手动覆盖交通段方式；mode=null 清除覆盖（PATCH /api/legs/:id/mode） */
  setLegMode: (legId: string, mode: TransportMode | null) =>
    request<{ ok: true }>(`/legs/${legId}/mode`, {
      method: "PATCH",
      body: JSON.stringify({ mode } satisfies SetLegModeInput),
    }),

  // ---------- 多酒店选定 ----------

  /**
   * 选定酒店（POST /api/trips/:tripId/select-hotel）。
   * checkInDay/checkOutDay 为 1-based 闭开区间（覆盖第 checkInDay..checkOutDay-1 晚），
   * 缺省由服务端智能建议未被覆盖的天段；同一行程已选定酒店区间不得重叠。
   * 返回最终生效的天区间。
   */
  selectHotel: (tripId: string, input: SelectHotelInput) =>
    request<{ ok: true; checkInDay?: number; checkOutDay?: number }>(
      `/trips/${tripId}/select-hotel`,
      { method: "POST", body: JSON.stringify(input) },
    ),

  /** 取消单个酒店的选定（POST /api/trips/:tripId/unselect-hotel） */
  unselectHotel: (tripId: string, candidateId: string) =>
    request<{ ok: true }>(`/trips/${tripId}/unselect-hotel`, {
      method: "POST",
      body: JSON.stringify({ candidateId }),
    }),

  // ---------- 设置 ----------

  /** 生效设置（DB 覆盖 > env）（GET /api/settings） */
  getSettings: () => request<{ settings: SettingsDto }>("/settings"),

  /** 写设置覆盖；字段传 null 清除覆盖回退 env（PUT /api/settings） */
  updateSettings: (input: UpdateSettingsInput) =>
    request<{ settings: SettingsDto }>("/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  // ---------- agent 注册 ----------

  /** 全部注册 agent（含 disabled；会话创建按 enabled 过滤）（GET /api/agents） */
  listAgents: () => request<{ agents: AgentRegistryDto[] }>("/agents"),

  /** 各 agent 的 command 本机可用性检测（GET /api/agents/detect） */
  detectAgents: () => request<{ agents: AgentAvailability[] }>("/agents/detect"),

  createAgent: (input: CreateAgentInput) =>
    request<{ agent: AgentRegistryDto }>("/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateAgent: (agentId: string, input: UpdateAgentInput) =>
    request<{ agent: AgentRegistryDto }>(`/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  /** 有历史会话引用的 agent 只停用不删除（disabled=true 表示走了停用） */
  deleteAgent: (agentId: string) =>
    request<{ ok: true; disabled: boolean }>(`/agents/${agentId}`, { method: "DELETE" }),
};
