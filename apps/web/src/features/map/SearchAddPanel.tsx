import { useState } from "react";
import type { PoiCandidate, TripBundle } from "@tripmapper/shared";
import { toast } from "sonner";
import { api } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Input, Select } from "../../components/ui/input";

/** 搜索添加地点（人类直接编辑路径，与 agent 并行） */
export function SearchAddPanel({
  tripId,
  bundle,
  onDataChanged,
}: {
  tripId: string;
  bundle: TripBundle;
  onDataChanged: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [candidates, setCandidates] = useState<PoiCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPoiId, setBusyPoiId] = useState<string | null>(null);
  const [dayIndex, setDayIndex] = useState(1);

  const maxDay = Math.max(bundle.days.length, 3);

  async function search() {
    if (!keyword.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const { candidates, error } = await api.searchPoi(tripId, keyword.trim());
      setCandidates(candidates);
      if (error) setError(error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function add(poi: PoiCandidate, asEntry: boolean) {
    setBusyPoiId(poi.poiId);
    try {
      const { place } = await api.createPlace(tripId, {
        name: poi.name,
        category: "other",
        location: poi.location,
        address: poi.address,
        amapPoiId: poi.poiId,
        sourceType: "manual",
      });
      if (asEntry) {
        await api.addEntry(tripId, place.id, dayIndex);
      }
      onDataChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyPoiId(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-900/8 p-3">
        <div className="flex gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
            placeholder="搜索地点，如「灵隐寺」"
            className="flex-1 rounded-lg border border-slate-300/60 bg-white/70 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
          />
          <button
            onClick={search}
            disabled={searching || !keyword.trim()}
            className="rounded-lg bg-slate-800/90 px-3 py-2 text-sm text-white shadow disabled:opacity-50"
          >
            {searching ? "…" : "搜索"}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
          加到：
          <select
            value={dayIndex}
            onChange={(e) => setDayIndex(Number(e.target.value))}
            className="rounded border border-slate-300/60 bg-white/70 px-2 py-1"
          >
            {Array.from({ length: Math.max(maxDay, dayIndex) }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                Day {d}
              </option>
            ))}
          </select>
          ，或只存入地点库
        </div>
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </div>

      <div className="flex-1 overflow-y-auto">
        {candidates.map((poi) => (
          <div
            key={poi.poiId}
            className="flex items-center gap-2 border-b border-slate-900/5 px-3 py-2 hover:bg-white/60"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{poi.name}</p>
              <p className="truncate text-xs text-slate-400">{poi.address ?? ""}</p>
            </div>
            <button
              disabled={busyPoiId === poi.poiId}
              onClick={() => void add(poi, true)}
              className="shrink-0 rounded-lg bg-blue-600 px-2 py-1 text-xs text-white shadow-sm disabled:opacity-50"
            >
              +Day{dayIndex}
            </button>
            <button
              disabled={busyPoiId === poi.poiId}
              onClick={() => void add(poi, false)}
              className="shrink-0 rounded-lg border border-slate-300/60 bg-white/60 px-2 py-1 text-xs text-slate-600 disabled:opacity-50"
            >
              存地点库
            </button>
          </div>
        ))}
        {candidates.length === 0 && !searching && (
          <p className="p-6 text-center text-xs text-slate-400">
            搜索结果会显示在这里。未配置高德 key 时无法搜索。
          </p>
        )}
      </div>
    </div>
  );
}
