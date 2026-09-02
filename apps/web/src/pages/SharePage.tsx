import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { useTripStore } from "../stores/tripStore";
import { MapCanvas, DAY_COLORS } from "../features/map/MapCanvas";
import { ItineraryPanel } from "../features/itinerary/ItineraryPanel";
import type { TripBundle } from "@odessey/shared";

/** 只读分享页：地图 + 行程，无编辑无对话 */
export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [bundle, setBundle] = useState<TripBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState({ amapJsKey: "", amapJsSecret: "" });
  const [visibleDay, setVisibleDay] = useState<number | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/share/${token}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("分享链接无效");
        return res.json() as Promise<{ bundle: TripBundle }>;
      })
      .then(({ bundle }) => setBundle(bundle))
      .catch((err) => setError((err as Error).message));
    void api.config().then(setConfig);
  }, [token]);

  if (error) {
    return <div className="flex h-full items-center justify-center text-sm text-red-500">{error}</div>;
  }
  if (!bundle) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400">加载中…</div>;
  }

  const days = [...bundle.days].sort((a, b) => a.dayIndex - b.dayIndex);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <h1 className="text-base font-semibold">{bundle.trip.title}</h1>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
          {bundle.trip.destinationCity} · 只读
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-[2]">
          <MapCanvas
            bundle={bundle}
            amapJsKey={config.amapJsKey}
            amapJsSecret={config.amapJsSecret}
            visibleDayIndex={visibleDay}
            hotelArea={null}
            selectedPlaceId={selectedPlaceId}
            onSelectPlace={(id) => setSelectedPlaceId(id)}
          />
          {days.length > 0 && (
            <div className="absolute left-3 top-3 z-10 flex gap-1.5">
              <button
                onClick={() => setVisibleDay(null)}
                className={`rounded-full px-3 py-1 text-xs font-medium shadow ${
                  visibleDay == null ? "bg-slate-800 text-white" : "bg-white/90 text-slate-600"
                }`}
              >
                全部
              </button>
              {days.map((d) => {
                const color = DAY_COLORS[(d.dayIndex - 1) % DAY_COLORS.length];
                const active = visibleDay === d.dayIndex;
                return (
                  <button
                    key={d.id}
                    onClick={() => setVisibleDay(active ? null : d.dayIndex)}
                    className="rounded-full px-3 py-1 text-xs font-medium shadow"
                    style={
                      active
                        ? { background: color, color: "#fff" }
                        : { background: "rgba(255,255,255,0.9)", color }
                    }
                  >
                    D{d.dayIndex}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 border-l border-slate-200 bg-white">
          <ItineraryPanel
            tripId={bundle.trip.id}
            bundle={bundle}
            selectedPlaceId={selectedPlaceId}
            onSelectPlace={setSelectedPlaceId}
            onDataChanged={() => {}}
          />
        </div>
      </div>
    </div>
  );
}
