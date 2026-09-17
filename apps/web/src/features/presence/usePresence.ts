import { useEffect, useState } from "react";
import type { PresenceEntry, PresenceEvent, TripEvent } from "@yarnball/shared";
import { api as libApi } from "../../lib/api";
import { usePrincipalStore } from "../../lib/principal";

// ---------- 行程频道 SSE 多路复用（issue #19） ----------
//
// presence / activity 等旁路消费方都要听行程频道（bundle 归 tripStore 的独立订阅，不掺和）。
// 模块级多路复用：同一页面多个组件共享一条 EventSource（owner 在 TripPage 上 PresenceBar +
// ActivityFeed + ShareCollabDialog 三处消费，单连接避免三份心跳/三倍服务端 presence 计数——
// 服务端按连接数登记在线名单，多连接会把同一人算多次）。

type TripEventListener = (event: unknown) => void;

interface MuxEntry {
  es: EventSource;
  listeners: Set<TripEventListener>;
}

const tripEventMux = new Map<string, MuxEntry>();

/** 订阅行程频道（guest 凭 ?token=，与 tripStore 的 subscribeTrip 同规则）；返回退订函数 */
export function subscribeTripEvents(tripId: string, onEvent: TripEventListener): () => void {
  let entry = tripEventMux.get(tripId);
  if (!entry) {
    const token = usePrincipalStore.getState().active?.token;
    const url = token
      ? `/api/trips/${tripId}/events?token=${encodeURIComponent(token)}`
      : `/api/trips/${tripId}/events`;
    const es = new EventSource(url);
    entry = { es, listeners: new Set() };
    tripEventMux.set(tripId, entry);
    es.onmessage = (e) => {
      if (!e.data) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        return;
      }
      for (const listener of entry!.listeners) listener(parsed);
    };
  }
  entry.listeners.add(onEvent);
  return () => {
    const cur = tripEventMux.get(tripId);
    if (!cur) return;
    cur.listeners.delete(onEvent);
    if (cur.listeners.size === 0) {
      cur.es.close();
      tripEventMux.delete(tripId);
    }
  };
}

/**
 * 在线名单（issue #19）：组件内 state 消费，不进 zustand bundle（连接态是动态数据）。
 *
 * 数据面三路汇合：
 * 1. 首屏 GET /api/trips/:tripId/presence 拉全量名单；
 * 2. SSE presence 事件（join/leave 携带事件后全量 viewers）整包替换——与 bundle 事件同频道同模式；
 * 3. EventSource 断线自动重连后服务端重新 join 并广播，名单自愈，无需轮询兜底。
 */
export function usePresence(tripId: string | undefined): PresenceEntry[] {
  const [viewers, setViewers] = useState<PresenceEntry[]>([]);

  // 首屏拉取（SSE 订阅建立前的名单；presence 事件到达后整包替换）
  useEffect(() => {
    if (!tripId) return;
    let cancelled = false;
    libApi
      .getTripPresence(tripId)
      .then(({ viewers }) => {
        if (!cancelled) setViewers(viewers);
      })
      .catch(() => {
        // 名单拉取失败不阻塞页面：SSE 事件到达后会补上
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  // 消费行程频道里的 presence 事件（多路复用共享一条 EventSource）
  useEffect(() => {
    if (!tripId) return;
    const unsubscribe = subscribeTripEvents(tripId, (event) => {
      const typed = event as TripEvent;
      if (typed?.type === "presence") {
        setViewers((typed.presence as PresenceEvent).viewers);
      }
    });
    return unsubscribe;
  }, [tripId]);

  return viewers;
}
