import { useState } from "react";
import { formatDistance, formatDuration, type TripBundle, type TransportLegDto } from "@yarnball/shared";
import { toast } from "sonner";
import { BedDouble, Bus, Car, Footprints, Zap } from "lucide-react";
import { api } from "../../api/client";
import { api as libApi } from "../../lib/api";
import { DAY_COLORS } from "../map/MapCanvas";
import { buildDayTimeline, formatHHMM } from "./timeline";

/**
 * 行程面板：按天分组的时间轴。
 * - 每个 entry 显示时段：startTime（agent 写入）+ durationMin 推算结束；
 *   startTime 缺失时按「durationMin + 交通时长」从 09:00 起推算（~ 前缀弱化展示）
 * - entry 之间显示交通段（模式图标 + 时长 + 距离），可手动切换 步行/驾车（M1 leg override 端点）
 * - readOnly（分享页）：隐藏一切编辑操作
 */

interface ItineraryPanelProps {
  tripId: string;
  bundle: TripBundle;
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
  onDataChanged: () => void;
  /** 只读模式（分享页）：不渲染编辑按钮与交通段切换 */
  readOnly?: boolean;
}

export function ItineraryPanel({
  tripId,
  bundle,
  selectedPlaceId,
  onSelectPlace,
  onDataChanged,
  readOnly = false,
}: ItineraryPanelProps) {
  const [busy, setBusy] = useState(false);
  const placeById = new Map(bundle.places.map((p) => [p.id, p]));

  const sortedDays = [...bundle.days].sort((a, b) => a.dayIndex - b.dayIndex);
  const dayEntries = new Map<string, TripBundle["entries"]>();
  for (const day of bundle.days) dayEntries.set(day.id, []);
  for (const entry of [...bundle.entries].sort((a, b) => a.position - b.position)) {
    dayEntries.get(entry.dayId)?.push(entry);
  }
  /** entryId → 其后紧邻的交通段（按 seq：entry→entry 或 entry→酒店） */
  const legAfter = new Map<string, TransportLegDto>();
  for (const day of bundle.days) {
    const legs = bundle.legs.filter((l) => l.dayId === day.id).sort((a, b) => a.seq - b.seq);
    for (const leg of legs) {
      if (leg.fromEntryId) legAfter.set(leg.fromEntryId, leg);
    }
  }
  /** 选定酒店（往返段标注用） */
  const selectedHotel =
    bundle.trip.selectedHotelCandidateId != null
      ? bundle.hotelCandidates.find((h) => h.id === bundle.trip.selectedHotelCandidateId)
      : undefined;
  const hotelPlace = selectedHotel ? placeById.get(selectedHotel.placeId) : undefined;

  async function move(entryId: string, dayIndex: number, position: number) {
    setBusy(true);
    try {
      await api.moveEntry(entryId, dayIndex, position);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry(entryId: string) {
    setBusy(true);
    try {
      await api.removeEntry(entryId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 手动覆盖交通段模式（M1：PATCH /api/legs/:id/mode，mode=null 清除覆盖）；成功后靠 SSE 全量快照刷新，这里再主动拉一次兜底 */
  async function overrideMode(legId: string, mode: "walk" | "drive" | null) {
    setBusy(true);
    try {
      await libApi.setLegMode(legId, mode);
      onDataChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function suggestOrder(dayIndex: number) {
    setBusy(true);
    try {
      const { suggestion } = await api.suggestOrder(tripId, dayIndex);
      const s = suggestion as {
        beforeOrder: { name: string }[];
        afterOrder: { name: string }[];
        savedS: number;
        alreadyOptimal: boolean;
        entryIds: string[];
      };
      if (s.alreadyOptimal) {
        toast.info(`Day ${dayIndex} 的顺序已经是最优，无需调整`);
        return;
      }
      const names = s.afterOrder.map((o) => o.name).join(" → ");
      const saved = Math.round(s.savedS / 60);
      if (confirm(`优化后顺序：${names}\n\n预计节省 ${saved} 分钟交通时间。应用吗？`)) {
        await api.reorderDay(tripId, dayIndex, s.entryIds);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {sortedDays.length === 0 && (
        <div className="p-6 text-center text-sm text-slate-400">
          还没有行程。让 agent 帮你排，或在「搜索添加」里手动加地点。
        </div>
      )}
      {sortedDays.map((day) => {
        const color = DAY_COLORS[(day.dayIndex - 1) % DAY_COLORS.length];
        const entries = dayEntries.get(day.id) ?? [];
        const timeline = buildDayTimeline(entries, placeById, legAfter);
        return (
          <section key={day.id} className="border-b border-slate-900/8 p-3">
            <header className="mb-2 flex items-center gap-2">
              <span
                className="rounded px-2 py-0.5 text-xs font-semibold text-white"
                style={{ background: color }}
              >
                Day {day.dayIndex}
              </span>
              <span className="text-xs text-slate-400">
                {entries.length} 个地点
                {day.date ? ` · ${day.date}` : ""}
                {timeline.length > 0 &&
                  ` · ${timeline[0].estimated ? "~" : ""}${formatHHMM(timeline[0].startMin)} 起`}
              </span>
              {!readOnly && entries.length >= 3 && (
                <button
                  onClick={() => suggestOrder(day.dayIndex)}
                  disabled={busy}
                  className="ml-auto rounded border border-slate-300/60 bg-white/60 px-2 py-0.5 text-xs text-slate-600 hover:bg-white disabled:opacity-50"
                >
                  <Zap className="size-3" />
                  优化顺序
                </button>
              )}
            </header>

            <ol className="space-y-0">
              {entries.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-slate-400">
                  {hotelPlace ? `当天暂无行程（酒店：${hotelPlace.name}）` : "当天暂无行程"}
                </li>
              )}
              {timeline.map(({ entry, place, startMin, endMin, estimated }, i) => {
                const leg = legAfter.get(entry.id);
                const toHotel = leg != null && leg.toPlaceId != null;
                const selected = place.id === selectedPlaceId;
                return (
                  <li key={entry.id}>
                    <div
                      className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ${
                        selected ? "bg-blue-500/12 ring-1 ring-blue-300/60" : "hover:bg-slate-50"
                      }`}
                      onClick={() => onSelectPlace(place.id)}
                    >
                      {/* 时段：startTime 直取；缺失时按 09:00 起推算，~ 前缀表示是估算 */}
                      <span
                        className={`w-[62px] shrink-0 text-[11px] tabular-nums leading-tight ${
                          estimated ? "text-slate-300" : "text-slate-500"
                        }`}
                        title={estimated ? "按停留时长与交通时间推算" : undefined}
                      >
                        {estimated ? "~" : ""}
                        {formatHHMM(startMin)}
                        <br />
                        {formatHHMM(endMin)}
                      </span>
                      <span
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                        style={{ background: color }}
                      >
                        {i + 1}
                      </span>
                      <span className="flex-1 truncate text-sm">
                        {place.name}
                        {place.durationMin ? (
                          <span className="ml-1 text-xs text-slate-400">约{place.durationMin}分钟</span>
                        ) : null}
                      </span>
                      {!readOnly && (
                        <span className="hidden shrink-0 gap-1 group-hover:flex">
                          <button
                            title="上移"
                            disabled={busy || i === 0}
                            onClick={(e) => {
                              e.stopPropagation();
                              void move(entry.id, day.dayIndex, entry.position - 1);
                            }}
                            className="rounded px-1 text-xs text-slate-400 hover:bg-white/80 disabled:opacity-30"
                          >
                            ↑
                          </button>
                          <button
                            title="下移"
                            disabled={busy || i === timeline.length - 1}
                            onClick={(e) => {
                              e.stopPropagation();
                              void move(entry.id, day.dayIndex, entry.position + 1);
                            }}
                            className="rounded px-1 text-xs text-slate-400 hover:bg-white/80 disabled:opacity-30"
                          >
                            ↓
                          </button>
                          <button
                            title="从这天移除"
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeEntry(entry.id);
                            }}
                            className="rounded px-1 text-xs text-slate-400 hover:bg-red-100/80 hover:text-red-500 disabled:opacity-30"
                          >
                            ✕
                          </button>
                        </span>
                      )}
                    </div>
                    {leg && (
                      <LegRow
                        leg={leg}
                        toHotel={toHotel}
                        hotelName={hotelPlace?.name}
                        readOnly={readOnly}
                        busy={busy}
                        onOverride={overrideMode}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/** 交通段行：图标 + 时长 + 距离；非只读时可切换 步行/驾车（覆盖后不被自动重算冲掉） */
function LegRow({
  leg,
  toHotel,
  hotelName,
  readOnly,
  busy,
  onOverride,
}: {
  leg: TransportLegDto;
  toHotel: boolean;
  hotelName?: string;
  readOnly: boolean;
  busy: boolean;
  onOverride: (legId: string, mode: "walk" | "drive" | null) => Promise<void>;
}) {
  // modeOverride 非空 = 人工覆盖过（M1），自动重算不会冲掉；可点击徽标恢复自动
  const overridden = leg.modeOverride != null;
  return (
    <div className="group/leg flex items-center gap-1 py-0.5 pl-9 text-[11px] text-slate-400">
      <TransportIcon mode={toHotel ? "hotel" : leg.mode} />
      <span>
        {toHotel ? `返回 ${hotelName ?? "酒店"} · ` : ""}
        {formatDuration(leg.durationS)}
        {leg.distanceM != null ? ` · ${formatDistance(leg.distanceM)}` : ""}
      </span>
      {overridden &&
        (readOnly || toHotel ? (
          <span className="rounded bg-slate-900/8 px-1 text-[10px] text-slate-500">手动</span>
        ) : (
          <button
            title="恢复自动计算"
            disabled={busy}
            onClick={() => void onOverride(leg.id, null)}
            className="rounded bg-slate-900/8 px-1 text-[10px] text-slate-500 hover:bg-slate-900/15 disabled:opacity-40"
          >
            手动 ✕
          </button>
        ))}
      {!readOnly && !toHotel && (
        <span className="ml-1 hidden items-center gap-0.5 group-hover/leg:flex">
          {(["walk", "drive"] as const).map((mode) => (
            <button
              key={mode}
              title={mode === "walk" ? "改为步行" : "改为驾车"}
              disabled={busy || leg.mode === mode}
              onClick={() => void onOverride(leg.id, mode)}
              className={`rounded p-0.5 disabled:opacity-30 ${
                leg.mode === mode
                  ? "bg-slate-900/10 text-slate-600"
                  : "text-slate-300 hover:bg-white/80 hover:text-slate-500"
              }`}
            >
              {mode === "walk" ? <Footprints className="size-3" /> : <Car className="size-3" />}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

function TransportIcon({ mode }: { mode: string }) {
  if (mode === "hotel") return <BedDouble className="size-3 shrink-0 text-slate-400" />;
  if (mode === "walk") return <Footprints className="size-3 shrink-0 text-slate-400" />;
  if (mode === "transit") return <Bus className="size-3 shrink-0 text-slate-400" />;
  return <Car className="size-3 shrink-0 text-slate-400" />;
}
