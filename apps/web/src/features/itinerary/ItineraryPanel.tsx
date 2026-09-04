import { useState } from "react";
import { formatDistance, formatDuration, type TripBundle } from "@tripmapper/shared";
import { toast } from "sonner";
import { BedDouble, Bus, Car, Footprints, Zap } from "lucide-react";
import { api } from "../../api/client";
import { DAY_COLORS } from "../map/MapCanvas";

/**
 * 行程面板：按天分组的时间轴。
 * entry 之间显示交通段；支持上移/下移、删除、换天。
 */

interface ItineraryPanelProps {
  tripId: string;
  bundle: TripBundle;
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
  onDataChanged: () => void;
}

export function ItineraryPanel({
  tripId,
  bundle,
  selectedPlaceId,
  onSelectPlace,
  onDataChanged,
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
  const legAfter = new Map<string, TripBundle["legs"][number]>();
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
              </span>
              {entries.length >= 3 && (
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
              {entries.map((entry, i) => {
                const place = placeById.get(entry.placeId);
                if (!place) return null;
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
                          disabled={busy || i === entries.length - 1}
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
                    </div>
                    {leg && (
                      <div className="flex items-center gap-1 py-0.5 pl-9 text-[11px] text-slate-400">
                        <TransportIcon mode={toHotel ? "hotel" : leg.mode} />
                        <span>
                          {toHotel ? `返回 ${hotelPlace?.name ?? "酒店"} · ` : ""}
                          {formatDuration(leg.durationS)}
                          {leg.distanceM != null ? ` · ${formatDistance(leg.distanceM)}` : ""}
                        </span>
                      </div>
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

function TransportIcon({ mode }: { mode: string }) {
  if (mode === "hotel") return <BedDouble className="size-3 shrink-0 text-slate-400" />;
  if (mode === "walk") return <Footprints className="size-3 shrink-0 text-slate-400" />;
  if (mode === "transit") return <Bus className="size-3 shrink-0 text-slate-400" />;
  return <Car className="size-3 shrink-0 text-slate-400" />;
}
