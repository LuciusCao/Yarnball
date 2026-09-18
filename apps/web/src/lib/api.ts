import {
  POSSIBLE_DUPLICATE_CODE,
  PossibleDuplicatePayloadSchema,
  type AccessLinkRole,
  type AddEntryInput,
  type AgentAvailability,
  type AgentRegistryDto,
  type ChatSessionDto,
  type CreateAgentInput,
  type CreatePlaceInput,
  type CreateTripInput,
  type CreateTripNoteInput,
  type DayDto,
  type EntryDto,
  type JoinActivateResult,
  type JoinInfo,
  type OwnerTokenStatus,
  type PlaceDto,
  type PlaceStatus,
  type PresenceEntry,
  type SelectHotelInput,
  type SettingsDto,
  type SetLegModeInput,
  type SuggestDayClustersResult,
  type TransportMode,
  type TripAccessLinkDto,
  type TripActivityDto,
  type TripBundle,
  type TripDto,
  type TripNoteDto,
  type TripPackageEnvelope,
  type TripWeather,
  type UpdateAgentInput,
  type UpdateEntryInput,
  type UpdatePlaceInput,
  type UpdateSettingsInput,
  type UpdateTripInput,
  type UpdateTripNoteInput,
} from "@yarnball/shared";
import { ApiError, apiFetch } from "./http";

/**
 * UX 重构新增端点的客户端契约（单点）。
 * 设置页（M2）/ 候选（M3）/ 时间轴（M4）一律从这里消费；
 * 既有端点仍在 ../api/client.ts，新代码不要在那里加方法。
 * 底层 fetch 走 lib/http.ts 的 apiFetch（guest 凭证存在时统一注入 Bearer，issue #18）。
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status, body.code);
  }
  return res.json() as Promise<T>;
}

/**
 * 疑似重复信号（POST /places 409）：模糊判重命中已有地点时不创建，
 * 错误里带回已有 place，调用方弹确认框后用 allowDuplicate=true 重试强制创建。
 */
export class PossibleDuplicateError extends Error {
  readonly existingPlace: PlaceDto;
  constructor(existingPlace: PlaceDto, message: string) {
    super(message);
    this.name = "PossibleDuplicateError";
    this.existingPlace = existingPlace;
  }
}

export const api = {
  // ---------- 行程 ----------

  /**
   * 创建行程（POST /api/trips）。完整 CreateTripInput（含 startDate/stops/geoProvider）；
   * 旧 client.ts 的 createTrip 类型窄（无 startDate），创建表单一律走这里。
   */
  createTrip: (input: CreateTripInput) =>
    request<{ trip: TripDto }>("/trips", { method: "POST", body: JSON.stringify(input) }),

  /** 更新行程字段（PATCH /api/trips/:tripId）：当前仅 startDate（出发日期，null = 清除） */
  updateTrip: (tripId: string, input: UpdateTripInput) =>
    request<{ trip: TripDto }>(`/trips/${tripId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  /**
   * 修改行程标题（issue #12，PATCH /api/trips/:tripId/title）。
   * 独立小端点（非 updateTrip 的 title 字段）：UpdateTripInputSchema 在 shared 包，
   * 被并行 mission 占用，服务端用路由内联 zod 承接；后续可收敛进 updateTrip。
   */
  renameTrip: (tripId: string, title: string) =>
    request<{ trip: TripDto }>(`/trips/${tripId}/title`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  // ---------- 候选状态机 ----------

  /**
   * 创建地点候选（POST /api/trips/:tripId/places）。
   * 命中模糊判重时抛 PossibleDuplicateError（409 + 已有 place DTO）；
   * 确认是不同地点后传 allowDuplicate: true 重试强制创建。
   */
  createPlace: async (tripId: string, input: CreatePlaceInput) => {
    const res = await apiFetch(`/api/trips/${tripId}/places`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (res.status === 409) {
      const body: unknown = await res.json().catch(() => null);
      const parsed = PossibleDuplicatePayloadSchema.safeParse(body);
      if (parsed.success && parsed.data.code === POSSIBLE_DUPLICATE_CODE) {
        throw new PossibleDuplicateError(parsed.data.existingPlace, parsed.data.error);
      }
      throw new Error((body as { error?: string } | null)?.error ?? "HTTP 409");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as { place: PlaceDto };
  },

  /** 地点加入/移出行程（PATCH /api/places/:id/status，joined=已加入、必排进日程） */
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

  // ---------- 行程信息（M102：#5 天气 / #9 每日概要 / #11 注意事项） ----------

  /**
   * 按天天气预报（GET /api/trips/:tripId/weather）。动态数据：调用方用 react-query
   * 缓存/刷新，不进 zustand bundle；超预报窗的天 available=false 并带 reason。
   */
  getTripWeather: (tripId: string) =>
    request<{ weather: TripWeather }>(`/trips/${tripId}/weather`),

  /** 撰写/更新每日概要（PATCH /api/days/:dayId/summary）；summary 传 null = 清除撰写值，恢复服务端自动兜底 */
  setDaySummary: (dayId: string, summary: string | null) =>
    request<{ day: DayDto }>(`/days/${dayId}/summary`, {
      method: "PATCH",
      body: JSON.stringify({ summary }),
    }),

  /** 新增行程级注意事项（POST /api/trips/:tripId/notes）；position 缺省排末尾 */
  createTripNote: (tripId: string, input: CreateTripNoteInput) =>
    request<{ note: TripNoteDto }>(`/trips/${tripId}/notes`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** 更新注意事项（PATCH /api/notes/:noteId）：category/content/position 按需传 */
  updateTripNote: (noteId: string, input: UpdateTripNoteInput) =>
    request<{ note: TripNoteDto }>(`/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  /** 删除注意事项（DELETE /api/notes/:noteId） */
  removeTripNote: (noteId: string) =>
    request<{ ok: true }>(`/notes/${noteId}`, { method: "DELETE" }),

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

  // ---------- owner token（issue #16：远程访问凭证，仅设置页用） ----------

  /**
   * owner token 配置态（GET /api/owner-token）。明文永不回显（server 只存 sha256 hash），
   * 生成/重置时一次性展示（resetOwnerToken 的返回值）。
   */
  getOwnerTokenStatus: () => request<OwnerTokenStatus>("/owner-token"),

  /**
   * 生成/重置 owner token（POST /api/owner-token/reset）。
   * token 明文仅此响应一次返回；重置后旧 token 立即失效。
   */
  resetOwnerToken: () => request<{ token: string }>("/owner-token/reset", { method: "POST" }),

  // ---------- 行程访问链接（issue #16：链接管理面板 UI 在 #17，此处先落契约） ----------

  /** 行程的全部访问链接（含已吊销；token 明文供 owner 复制）（GET /api/trips/:tripId/access-links） */
  listAccessLinks: (tripId: string) =>
    request<{ links: TripAccessLinkDto[] }>(`/trips/${tripId}/access-links`),

  /** 创建访问链接（POST /api/trips/:tripId/access-links）；label 缺省按角色给默认 */
  createAccessLink: (tripId: string, role: AccessLinkRole, label?: string | null) =>
    request<{ link: TripAccessLinkDto }>(`/trips/${tripId}/access-links`, {
      method: "POST",
      body: JSON.stringify({ role, ...(label != null ? { label } : {}) }),
    }),

  /** 更新链接备注名（PATCH /api/access-links/:linkId） */
  updateAccessLink: (linkId: string, label: string | null) =>
    request<{ link: TripAccessLinkDto }>(`/access-links/${linkId}`, {
      method: "PATCH",
      body: JSON.stringify({ label }),
    }),

  /** 吊销链接（DELETE /api/access-links/:linkId）：持该 token 的同伴下次请求即 401 */
  revokeAccessLink: (linkId: string) =>
    request<{ ok: true }>(`/access-links/${linkId}`, { method: "DELETE" }),

  // ---------- 同伴入口（issue #18：/join/:token 公开端点，token 在 URL 即凭证） ----------

  /**
   * 链接信息（GET /api/join/:token/info）：行程标题 / 角色 / 已填昵称。
   * 无效/已吊销抛 ApiError（code=join_link_not_found | join_link_revoked，
   * JoinPage 据此出「链接无效」vs「已被主人撤销」的不同文案）。
   */
  getJoinInfo: (token: string) => request<JoinInfo>(`/join/${token}/info`),

  /**
   * 激活链接（POST /api/join/:token/activate）：写昵称，返回 tripId/role/displayName。
   * token 不回传（就在 URL 里）；调用方把 token 与返回值组装成 guest 凭证存入 principal store。
   */
  activateJoinLink: (token: string, displayName: string) =>
    request<JoinActivateResult>(`/join/${token}/activate`, {
      method: "POST",
      body: JSON.stringify({ displayName }),
    }),

  // ---------- 协作实时体验（issue #19：动态流 / 在线名单 / 分享页实时化） ----------

  /**
   * 行程动态流（GET /api/trips/:tripId/activity）：最近 N 条「谁改了什么」。
   * 动态数据（含 presence），走 react-query 或组件内 state，不进 zustand bundle。
   */
  listTripActivity: (tripId: string) =>
    request<{ activity: TripActivityDto[] }>(`/trips/${tripId}/activity`),

  /** 当前在线名单快照（GET /api/trips/:tripId/presence）：首屏拉取，之后靠 SSE presence 事件增量更新 */
  getTripPresence: (tripId: string) =>
    request<{ viewers: PresenceEntry[] }>(`/trips/${tripId}/presence`),

  /** 分享页天气（GET /api/share/:token/weather，公开端点：token 即凭证，响应无真实 id） */
  getShareWeather: (token: string) =>
    request<{ weather: TripWeather }>(`/share/${token}/weather`),

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

  // ---------- chat 会话 ----------

  /**
   * 手动重连 agent（POST /api/chat-sessions/:id/reconnect）。
   * server 重启 / agent 崩溃后的懒恢复（session/new + 压缩转录回放），与 prompt 的自动恢复同路径；
   * prompt 端点本身也会自动恢复，此方法供「重新连接」按钮不带消息地触发。
   */
  reconnectChatSession: (sessionId: string) =>
    request<{ ok: true; session: ChatSessionDto }>(`/chat-sessions/${sessionId}/reconnect`, {
      method: "POST",
    }),

  // ---------- 行程数据包（issue #34：离线分享） ----------

  /** 导出加密数据包（owner-only）：返回信封 JSON，调用方落 .yarnball 文件 */
  exportTripPackage: (tripId: string, password: string) =>
    request<{ package: TripPackageEnvelope }>(`/trips/${tripId}/package`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  /** 导入数据包（owner-only）：文件全文 + 密码 → 新行程 bundle（前端跳转） */
  importTripPackage: (packageText: string, password: string) =>
    request<{ bundle: TripBundle }>("/trips/import-package", {
      method: "POST",
      body: JSON.stringify({ package: packageText, password }),
    }),
};
