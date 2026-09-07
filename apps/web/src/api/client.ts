import type {
  ChatMessageDto,
  ChatSessionDto,
  PoiCandidate,
  TripBundle,
  TripDto,
} from "@yarnball/shared";

/**
 * 前端 API 层 —— 全部走 Vite 代理（/api → server），无跨域。
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
  config: () =>
    request<{
      amapConfigured: boolean;
      amapJsKey: string;
      amapJsSecret: string;
      activeChatSessions: number;
    }>("/config"),

  listTrips: () => request<{ trips: TripDto[] }>("/trips"),
  createTrip: (input: { title: string; destinationCity: string; stops?: string[] }) =>
    request<{ trip: TripDto }>("/trips", { method: "POST", body: JSON.stringify(input) }),
  deleteTrip: (tripId: string) => request<{ ok: true }>(`/trips/${tripId}`, { method: "DELETE" }),
  getBundle: (tripId: string) => request<{ bundle: TripBundle }>(`/trips/${tripId}`),
  /** 目的地自愈：重新解析城市中心（创建时网络失败/旧数据定位错误） */
  resolveCity: (tripId: string) =>
    request<{ trip: TripDto }>(`/trips/${tripId}/resolve-city`, { method: "POST" }),
  /** 城市联想（创建表单自动补全） */
  citySuggest: (q: string) =>
    request<{
      suggestions: { name: string; country: string | null; center: { lng: number; lat: number } }[];
    }>(`/city-suggest?q=${encodeURIComponent(q)}`),

  searchPoi: (tripId: string, keyword: string) =>
    request<{ candidates: PoiCandidate[]; error?: string }>(
      `/trips/${tripId}/search?keyword=${encodeURIComponent(keyword)}`,
    ),
  createPlace: (
    tripId: string,
    input: {
      name: string;
      category: string;
      location: { lng: number; lat: number };
      address?: string | null;
      amapPoiId?: string | null;
      sourceType?: string;
      notes?: string | null;
    },
  ) => request<{ place: TripBundle["places"][number] }>(`/trips/${tripId}/places`, {
    method: "POST",
    body: JSON.stringify(input),
  }),

  addEntry: (tripId: string, placeId: string, dayIndex: number, position?: number) =>
    request<{ dayId: string; position: number }>(`/trips/${tripId}/entries`, {
      method: "POST",
      body: JSON.stringify({ placeId, dayIndex, position: position ?? null }),
    }),
  removeEntry: (entryId: string) =>
    request<{ ok: true }>(`/entries/${entryId}`, { method: "DELETE" }),
  moveEntry: (entryId: string, dayIndex: number, position: number) =>
    request<{ ok: true }>(`/entries/${entryId}/move`, {
      method: "POST",
      body: JSON.stringify({ dayIndex, position }),
    }),
  reorderDay: (tripId: string, dayIndex: number, entryIds: string[]) =>
    request<{ ok: true }>(`/trips/${tripId}/days/${dayIndex}/reorder`, {
      method: "POST",
      body: JSON.stringify({ entryIds }),
    }),

  addHotelCandidate: (
    tripId: string,
    input: { name: string; location: { lng: number; lat: number }; pricePerNight?: number | null; notes?: string | null; address?: string | null },
  ) =>
    request<{ candidate: TripBundle["hotelCandidates"][number] }>(
      `/trips/${tripId}/hotel-candidates`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  selectHotel: (tripId: string, candidateId: string | null) =>
    request<{ ok: true }>(`/trips/${tripId}/select-hotel`, {
      method: "POST",
      body: JSON.stringify({ candidateId }),
    }),
  hotelArea: (tripId: string) =>
    request<{ area: { center: { lng: number; lat: number }; radiusM: number } | null }>(
      `/trips/${tripId}/hotel-area`,
    ),

  suggestOrder: (tripId: string, dayIndex: number) =>
    request<{ suggestion: unknown }>(`/trips/${tripId}/suggest-order?dayIndex=${dayIndex}`),
  analyzeDetour: (tripId: string, placeId: string, dayIndex: number) =>
    request<{ analysis: unknown }>(
      `/trips/${tripId}/analyze-detour?placeId=${placeId}&dayIndex=${dayIndex}`,
    ),

  // 预算
  getBudget: (tripId: string) =>
    request<{
      summary: {
        currency: string;
        budgetCny: number | null;
        travelerCount: number;
        nights: number;
        hotelSelected: boolean;
        hotelCny: number | null;
        diningCny: number;
        ticketsCny: number;
        totalCny: number;
        remainingCny: number | null;
        unpricedCount: number;
      };
    }>(`/trips/${tripId}/budget`),
  updateBudget: (
    tripId: string,
    input: { budgetCny?: number | null; travelerCount?: number; currency?: string },
  ) =>
    request<{ ok: true }>(`/trips/${tripId}/budget`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  chatSessions: (tripId: string) =>
    request<{ sessions: ChatSessionDto[] }>(`/trips/${tripId}/chat-sessions`),
  createChatSession: (tripId: string, agentId: string) =>
    request<{ session: ChatSessionDto }>(`/trips/${tripId}/chat-sessions`, {
      method: "POST",
      body: JSON.stringify({ agentId }),
    }),
  chatMessages: (sessionId: string) =>
    request<{ messages: ChatMessageDto[] }>(`/chat-sessions/${sessionId}/messages`),
  sendPrompt: (sessionId: string, text: string) =>
    request<{ ok: true }>(`/chat-sessions/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  answerPermission: (sessionId: string, requestId: string, optionId: string | null) =>
    request<{ ok: boolean }>(`/chat-sessions/${sessionId}/permissions/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ optionId }),
    }),
  setAllowAll: (sessionId: string, enabled: boolean) =>
    request<{ ok: true }>(`/chat-sessions/${sessionId}/allow-all`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  setUiContext: (sessionId: string, context: unknown) =>
    request<{ ok: true }>(`/chat-sessions/${sessionId}/ui-context`, {
      method: "POST",
      body: JSON.stringify(context),
    }),
  closeChatSession: (sessionId: string) =>
    request<{ ok: true }>(`/chat-sessions/${sessionId}`, { method: "DELETE" }),
};

/** SSE 订阅（EventSource 自动重连；断线补拉由调用方处理） */
export function subscribeTrip(tripId: string, onEvent: (event: unknown) => void): () => void {
  const es = new EventSource(`/api/trips/${tripId}/events`);
  es.onmessage = (e) => {
    if (e.data) onEvent(JSON.parse(e.data));
  };
  return () => es.close();
}

export function subscribeChat(sessionId: string, onEvent: (event: unknown) => void): () => void {
  const es = new EventSource(`/api/chat-sessions/${sessionId}/events`);
  es.onmessage = (e) => {
    if (e.data) onEvent(JSON.parse(e.data));
  };
  return () => es.close();
}
