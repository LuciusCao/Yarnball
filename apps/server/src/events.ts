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
