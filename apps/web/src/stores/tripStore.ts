import { create } from "zustand";
import type { ChatMessageDto, TripBundle } from "@yarnball/shared";
import { api, subscribeChat, subscribeTrip } from "../api/client";

/**
 * 全局 store：当前行程 bundle + SSE 增量合并。
 * bundle 事件 = 服务端全量快照，直接替换（单机数据量小，全量最可靠）。
 */

interface TripStore {
  bundle: TripBundle | null;
  error: string | null;
  loading: boolean;
  load: (tripId: string) => Promise<void>;
  subscribe: (tripId: string) => () => void;
  refresh: (tripId: string) => Promise<void>;
}

export const useTripStore = create<TripStore>((set, get) => ({
  bundle: null,
  error: null,
  loading: false,

  load: async (tripId: string) => {
    set({ loading: true, error: null });
    try {
      const { bundle } = await api.getBundle(tripId);
      set({ bundle, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  refresh: async (tripId: string) => {
    try {
      const { bundle } = await api.getBundle(tripId);
      set({ bundle });
    } catch {
      // 静默：SSE 自愈路径
    }
  },

  subscribe: (tripId: string) => {
    const unsubscribe = subscribeTrip(tripId, (event) => {
      const typed = event as { type: string; bundle?: TripBundle; tripId?: string };
      if (typed.type === "bundle" && typed.bundle) {
        set({ bundle: typed.bundle });
      } else if (typed.type === "deleted" && typed.tripId === tripId) {
        set({ bundle: null, error: "行程已被删除" });
      }
    });
    // 订阅即补拉一次，防止错过订阅前后的变更
    void get().refresh(tripId);
    return unsubscribe;
  },
}));

// ---------- chat ----------

interface ChatStore {
  messages: ChatMessageDto[];
  sessionId: string | null;
  /** permission_request 的 requestId → 当前是否待答 */
  subscribe: (sessionId: string) => () => void;
  reset: () => void;
  upsertMessage: (message: ChatMessageDto) => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  sessionId: null,

  upsertMessage: (message) => {
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === message.id);
      if (idx === -1) {
        return { messages: [...state.messages, message] };
      }
      const next = [...state.messages];
      next[idx] = message;
      return { messages: next };
    });
  },

  subscribe: (sessionId: string) => {
    set({ sessionId });
    // 初始加载历史
    void api.chatMessages(sessionId).then(({ messages }) => {
      // SSE 可能已经先推了新消息：按 id 合并而不是直接替换
      set((state) => {
        const existing = new Map(state.messages.map((m) => [m.id, m]));
        const merged = messages.map((m) => existing.get(m.id) ?? m);
        const extras = state.messages.filter((m) => !messages.some((x) => x.id === m.id));
        return { messages: [...merged, ...extras] };
      });
    });

    const unsubscribe = subscribeChat(sessionId, (event) => {
      const typed = event as { type: string; message?: ChatMessageDto };
      if (typed.type === "message" && typed.message) {
        get().upsertMessage(typed.message);
      }
      // session 状态变化由 React Query 的定时 refetch 处理（简化）
    });
    return unsubscribe;
  },

  reset: () => set({ messages: [], sessionId: null }),
}));
