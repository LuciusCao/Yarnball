/**
 * 进程内事件总线：所有行程/会话变更（人经 REST、agent 经 MCP）都经此广播，
 * SSE 路由订阅后推给浏览器。单机部署，无需外部 broker。
 */

type Listener = (event: unknown) => void;

export class EventBus {
  private channels = new Map<string, Set<Listener>>();

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.channels.delete(channel);
    };
  }

  publish(channel: string, event: unknown): void {
    const set = this.channels.get(channel);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[events] listener error on ${channel}:`, err);
      }
    }
  }
}

export const tripChannel = (tripId: string) => `trip:${tripId}`;
export const chatChannel = (sessionId: string) => `chat:${sessionId}`;
/** 行程列表页：任意 trip 元数据变化 */
export const TRIPS_CHANNEL = "trips";

/**
 * 在线名单（presence，issue #19）：进程内的行程订阅者注册表。
 * SSE 连接建立时 join、断开（stream.onAbort）时 leave，变更后向行程频道广播
 * presence 事件（含全量名单）——订阅者名单本身只在内存（连接态数据不落库）。
 * 不直接放 EventBus：channel 只是「发布-订阅」无状态语义，注册表需要自持状态与查询接口。
 */
export class PresenceRegistry {
  /** tripId → 连接集合（每条 SSE 连接一项；同一人开多标签页 = 多条连接） */
  private trips = new Map<string, Map<number, { label: string; kind: "human" | "agent" | "guest" }>>();
  private nextSeq = 1;

  /**
   * 记录一条连接并广播 join 事件。返回连接句柄（离场时调 leave）。
   * 事件由调用方注入的 publish 走行程频道（与 bundle 事件同频道，前端一次订阅全收到）。
   */
  join(
    tripId: string,
    entry: { label: string; kind: "human" | "agent" | "guest" },
    publish: (tripId: string, event: unknown) => void,
  ): { leave: () => void } {
    const seq = this.nextSeq++;
    let conn = this.trips.get(tripId);
    if (!conn) {
      conn = new Map();
      this.trips.set(tripId, conn);
    }
    conn.set(seq, entry);
    const leave = () => {
      const current = this.trips.get(tripId);
      if (!current?.delete(seq)) return;
      if (current.size === 0) this.trips.delete(tripId);
      publish(tripId, {
        type: "presence",
        presence: { kind: "leave", entry, viewers: this.viewersOf(tripId) },
      });
    };
    publish(tripId, {
      type: "presence",
      presence: { kind: "join", entry, viewers: this.viewersOf(tripId) },
    });
    return { leave };
  }

  /** 当前行程的全部在线连接（顺序稳定：按加入顺序） */
  viewersOf(tripId: string): { label: string; kind: "human" | "agent" | "guest" }[] {
    const conn = this.trips.get(tripId);
    return conn ? [...conn.values()] : [];
  }
}