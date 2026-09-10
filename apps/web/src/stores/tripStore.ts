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

/** 进行中的 bundle 请求按 tripId 去重：mount 时 load() 与 subscribe 补拉并发时只发一个请求 */
const bundleInflight = new Map<string, Promise<void>>();

export const useTripStore = create<TripStore>((set, get) => ({
  bundle: null,
  error: null,
  loading: false,

  load: (tripId: string) => {
    const pending = bundleInflight.get(tripId);
    if (pending) return pending;
    const p = (async () => {
      set({ loading: true, error: null });
      try {
        const { bundle } = await api.getBundle(tripId);
        set({ bundle, loading: false });
      } catch (err) {
        set({ error: (err as Error).message, loading: false });
      } finally {
        bundleInflight.delete(tripId);
      }
    })();
    bundleInflight.set(tripId, p);
    return p;
  },

  refresh: (tripId: string) => {
    const pending = bundleInflight.get(tripId);
    if (pending) return pending;
    const p = (async () => {
      try {
        const { bundle } = await api.getBundle(tripId);
        set({ bundle });
      } catch {
        // 静默：SSE 自愈路径
      } finally {
        bundleInflight.delete(tripId);
      }
    })();
    bundleInflight.set(tripId, p);
    return p;
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
  /** 是否还有更早的消息在服务器端（分页翻页驱动；全量在内存时为 false） */
  hasMore: boolean;
  /** 向更早翻页请求进行中（「加载更早」按钮 loading 态） */
  loadingEarlier: boolean;
  sessionId: string | null;
  /** 订阅会话的 SSE 消息流并加载历史（最新一页）；切换到不同 sessionId 时清空上一会话的消息 */
  subscribe: (sessionId: string) => () => void;
  reset: () => void;
  upsertMessage: (message: ChatMessageDto) => void;
  /** 「加载更早」：按本页最早 seq 向服务器翻页，前插进消息列表 */
  loadEarlier: () => Promise<void>;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  hasMore: false,
  loadingEarlier: false,
  sessionId: null,

  upsertMessage: (message) => {
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === message.id);
      // upsert 后需按 seq 稳定排序：服务端会把回合终端消息（advisory）重赋 seq 补发同 id 事件
      //（迟到 chunk 重排，见 server promoteTurnTerminal），原位替换会让终端消息停在旧位置。
      // 但绝大多数事件是尾部追加/原位更新，先 O(n) 检查有序性，仅在乱序时才全量 sort，
      // 避免每个流式 chunk 都对长列表 O(n log n)
      const next = [...state.messages];
      if (idx === -1) next.push(message);
      else next[idx] = message;
      let ordered = true;
      for (let i = 1; i < next.length; i++) {
        if (next[i - 1].seq > next[i].seq) {
          ordered = false;
          break;
        }
      }
      if (!ordered) next.sort((a, b) => a.seq - b.seq);
      return { messages: next };
    });
  },

  loadEarlier: async () => {
    const { sessionId, messages, loadingEarlier } = get();
    if (!sessionId || loadingEarlier || messages.length === 0) return;
    const oldestSeq = messages[0].seq;
    if (!get().hasMore) return;
    set({ loadingEarlier: true });
    try {
      const { messages: older, hasMore } = await api.chatMessages(sessionId, { beforeSeq: oldestSeq });
      // 请求途中切了会话：这份历史属于旧会话，直接丢弃
      if (get().sessionId !== sessionId) return;
      set((state) => {
        // 与内存中已有消息按 id 去重（SSE 可能已推过重叠区间的消息）
        const existing = new Set(older.map((m) => m.id));
        const merged = [...older, ...state.messages.filter((m) => !existing.has(m.id))];
        merged.sort((a, b) => a.seq - b.seq);
        return { messages: merged, hasMore };
      });
    } finally {
      set({ loadingEarlier: false });
    }
  },

  subscribe: (sessionId) => {
    // 切换 trip/session 时清空上一会话的消息（TripPage/ChatPanel 不随路由 param 重挂载，
    // 否则旧会话消息会在历史合并里作为 extras 残留并累积进新会话）
    if (get().sessionId !== sessionId) {
      set({ messages: [], hasMore: false, sessionId });
    }
    // 初始加载最新一页（分页；更早的按需「加载更早」）
    void api.chatMessages(sessionId).then(({ messages, hasMore }) => {
      // 请求途中又切了会话：这份历史属于旧会话，直接丢弃
      if (get().sessionId !== sessionId) return;
      // SSE 可能已经先推了新消息：按 id 合并而不是直接替换，最终同样按 seq 排序
      set((state) => {
        const incoming = new Map(messages.map((m) => [m.id, m]));
        const merged = [...messages, ...state.messages.filter((m) => !incoming.has(m.id))];
        merged.sort((a, b) => a.seq - b.seq);
        return { messages: merged, hasMore };
      });
    });

    const unsubscribe = subscribeChat(sessionId, (event) => {
      const typed = event as { type: string; message?: ChatMessageDto };
      if (typed.type === "message" && typed.message) {
        get().upsertMessage(typed.message);
      }
      // session 状态变化由 ChatPanel 的 3s 轮询（前台标签页）处理
    });
    return unsubscribe;
  },

  reset: () => set({ messages: [], hasMore: false, loadingEarlier: false, sessionId: null }),
}));
