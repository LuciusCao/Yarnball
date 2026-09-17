import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Sparkles, UserRound } from "lucide-react";
import type { TripActivityDto, TripEvent } from "@yarnball/shared";
import { api as libApi } from "../../lib/api";
import { subscribeTripEvents } from "../presence/usePresence";
import { cn } from "../../lib/utils";

/**
 * 动态流（issue #19「谁改了什么」）：行程页角落的轻量动态条。
 *
 * 数据面（动态数据不进 zustand bundle，仓库惯例）：
 * - 首屏 react-query 拉最近 N 条（GET /api/trips/:tripId/activity）；
 * - SSE activity 事件（行程频道）到达时前插并截断到同一上限——服务端已滚动保留 50 条，
 *   前端只保留最近 12 条展示（角落动态条要短）。
 * - SSE 经 presence 模块的多路复用共享一条 EventSource（与 PresenceBar/协作面板同连接，
 *   避免同一页面多连接把 presence 计数算重）。
 *
 * UI 形态：默认单行显示最新一条（「小红 添加了地点 悉尼歌剧院」），点击展开最近 12 条列表。
 * summary 句子由服务端生成（三端文案一致），前端不拼装。
 */
const DISPLAY_KEEP = 12;

/** 相对时间：刚刚 / N 分钟前 / N 小时前（动态条里不展示更老的粒度） */
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "刚刚";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

export function ActivityFeed({ tripId }: { tripId: string | undefined }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["trip-activity", tripId],
    queryFn: () => libApi.listTripActivity(tripId!).then((r) => r.activity),
    enabled: tripId != null,
    staleTime: Infinity, // 动态流是追加型数据：SSE 负责增量，首屏拉过就不再重拉
  });

  // SSE 增量：行程频道的 activity 事件前插进 react-query 缓存（多路复用共享连接）
  useEffect(() => {
    if (!tripId) return;
    const unsubscribe = subscribeTripEvents(tripId, (event) => {
      const typed = event as TripEvent;
      if (typed?.type !== "activity") return;
      const incoming = (typed as { activity: TripActivityDto }).activity;
      queryClient.setQueryData<TripActivityDto[]>(["trip-activity", tripId], (prev) =>
        [incoming, ...(prev ?? [])].slice(0, DISPLAY_KEEP),
      );
    });
    return unsubscribe;
  }, [tripId, queryClient]);

  const items = query.data ?? [];
  if (items.length === 0) return null;
  const latest = items[0];

  return (
    <div className="glass panel-in pointer-events-auto absolute bottom-4 left-4 z-10 max-w-sm">
      {/* 收起态：最新一条动态，点击展开 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-2xl px-3 py-1.5 text-left text-[11px] text-slate-500 transition-colors hover:text-slate-800"
        title="谁改了什么（点击查看最近动态）"
      >
        <Activity className="size-3.5 shrink-0 text-slate-400" />
        <span className="truncate">{latest.summary}</span>
        <span className="shrink-0 text-slate-400">{relativeTime(latest.createdAt)}</span>
      </button>
      {/* 展开态：最近 12 条 */}
      {open && (
        <div className="mt-1 max-h-56 w-72 space-y-0.5 overflow-y-auto rounded-2xl px-2 py-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-1.5 px-1 py-1 text-[11px] leading-relaxed">
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                  item.actorKind === "agent"
                    ? "bg-blue-500/15 text-blue-600"
                    : item.actorKind === "guest"
                      ? "bg-emerald-500/15 text-emerald-600"
                      : "bg-slate-900/8 text-slate-500",
                )}
                title={item.actorKind === "agent" ? "agent" : item.actorKind === "guest" ? "同伴" : "主人"}
              >
                {item.actorKind === "agent" ? (
                  <Sparkles className="size-2.5" />
                ) : (
                  <UserRound className="size-2.5" />
                )}
              </span>
              <span className="min-w-0 flex-1 text-slate-600">{item.summary}</span>
              <span className="shrink-0 text-slate-400">{relativeTime(item.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
