import { UsersRound } from "lucide-react";
import type { PresenceEntry } from "@yarnball/shared";
import { usePresence } from "./usePresence";

/**
 * 在线名单条（issue #19）：「在线：Lucius、小红」。
 * owner 侧（TripPage）与 guest 侧共用——guest 凭 ?token= 订阅同一事件流。
 * 名单展示按 label 去重（同一人开两个标签页是两条 SSE 连接，名单聚合算一个人）；
 * 空 = 只有自己在线（服务端把订阅者都算在线，本组件挂载时自身那条连接至少存在）。
 */
export function PresenceBar({ tripId }: { tripId: string | undefined }) {
  const viewers = usePresence(tripId);

  // 按 label 去重（保持首现顺序）；主人排最前，其余按出现顺序
  const unique: PresenceEntry[] = [];
  const seen = new Set<string>();
  for (const v of [...viewers].sort((a, b) => (a.kind === "human" ? -1 : 0) - (b.kind === "human" ? -1 : 0))) {
    if (seen.has(v.label)) continue;
    seen.add(v.label);
    unique.push(v);
  }
  if (unique.length === 0) return null;

  return (
    <span
      className="flex min-w-0 items-center gap-1.5 rounded-full bg-emerald-500/12 px-2.5 py-1 text-[11px] font-medium text-emerald-700"
      title={`当前在线（打开本行程页面的人）：${unique.map((v) => v.label).join("、")}`}
    >
      <span className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      <UsersRound className="size-3 shrink-0" />
      <span className="truncate">
        在线{unique.length > 1 ? ` ${unique.length} 人` : ""}：{unique.map((v) => v.label).join("、")}
      </span>
    </span>
  );
}
