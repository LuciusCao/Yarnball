import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { MapCanvas, dayColor } from "../features/map/MapCanvas";
import { ItineraryPanel } from "../features/itinerary/ItineraryPanel";
import type { TripBundle } from "@odessey/shared";

/** 只读分享页：全屏地图 + 毛玻璃浮层行程面板（无编辑无对话） */
export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [bundle, setBundle] = useState<TripBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState({ amapJsKey: "", amapJsSecret: "" });
  const [visibleDay, setVisibleDay] = useState<number | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<"expanded" | "collapsed" | "hidden">("expanded");

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
    return <div className="flex h-full items-center justify-center bg-slate-100 text-sm text-slate-400">加载中…</div>;
  }

  const days = [...bundle.days].sort((a, b) => a.dayIndex - b.dayIndex);

  return (
    <div className="relative h-full overflow-hidden">
      <div className="absolute inset-0">
        <MapCanvas
          bundle={bundle}
          amapJsKey={config.amapJsKey}
          amapJsSecret={config.amapJsSecret}
          visibleDayIndex={visibleDay}
          hotelArea={null}
          selectedPlaceId={selectedPlaceId}
          onSelectPlace={(id) => setSelectedPlaceId(id)}
        />
      </div>

      {/* 顶部信息条 */}
      <header className="glass panel-in pointer-events-auto absolute left-4 top-4 z-10 flex items-center gap-2.5 rounded-2xl px-4 py-2">
        <h1 className="glass-text text-sm font-semibold">{bundle.trip.title}</h1>
        <span className="rounded-full bg-slate-900/8 px-2 py-0.5 text-[11px] font-medium text-slate-500">
          {bundle.trip.destinationCity} · 只读
        </span>
      </header>

      {/* Day chips */}
      {days.length > 0 && (
        <div className="panel-in absolute left-4 top-[60px] z-10 flex flex-wrap gap-1.5 pr-4">
          <button
            onClick={() => setVisibleDay(null)}
            className={`glass rounded-full px-3 py-1 text-xs font-medium transition-all hover:scale-105 ${
              visibleDay == null ? "!bg-slate-900/80 !border-transparent text-white" : "glass-text"
            }`}
          >
            全部
          </button>
          {days.map((d) => {
            const color = dayColor(d.dayIndex);
            const active = visibleDay === d.dayIndex;
            return (
              <button
                key={d.id}
                onClick={() => setVisibleDay(active ? null : d.dayIndex)}
                className="glass rounded-full px-3 py-1 text-xs font-medium shadow transition-all hover:scale-105"
                style={active ? { background: color, color: "#fff", borderColor: "transparent" } : { color }}
              >
                D{d.dayIndex}
              </button>
            );
          })}
        </div>
      )}

      {/* 行程浮层面板 */}
      {panelMode === "hidden" ? (
        <button
          onClick={() => setPanelMode("expanded")}
          className="glass panel-in absolute right-4 top-4 z-20 rounded-2xl px-3.5 py-2 text-xs font-medium text-slate-600 shadow-lg transition-transform hover:scale-105"
        >
          🗓 显示行程
        </button>
      ) : panelMode === "collapsed" ? (
        <button
          onClick={() => setPanelMode("expanded")}
          className="glass panel-in absolute right-4 top-4 z-20 rounded-2xl px-3.5 py-2 text-xs font-medium text-slate-600 shadow-lg transition-transform hover:scale-105"
        >
          🗓 行程
        </button>
      ) : (
        <aside className="glass-deep panel-in absolute bottom-4 right-4 top-4 z-20 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl">
          <div className="flex items-center gap-2 border-b border-white/40 px-4 py-2.5">
            <div className="flex gap-1.5">
              <span className="h-3 w-3 rounded-full border border-black/10" style={{ background: "#ff5f57" }} />
              <span className="h-3 w-3 rounded-full border border-black/10" style={{ background: "#febc2e" }} />
              <button
                onClick={() => setPanelMode("collapsed")}
                title="收起"
                className="h-3 w-3 rounded-full border border-black/10 transition-transform hover:scale-110"
                style={{ background: "#28c840" }}
              />
            </div>
            <span className="glass-text ml-1 text-xs font-semibold">🗓 行程</span>
          </div>
          <div className="glass-text min-h-0 flex-1 bg-white/45">
            <ItineraryPanel
              tripId={bundle.trip.id}
              bundle={bundle}
              selectedPlaceId={selectedPlaceId}
              onSelectPlace={setSelectedPlaceId}
              onDataChanged={() => {}}
            />
          </div>
        </aside>
      )}
    </div>
  );
}
