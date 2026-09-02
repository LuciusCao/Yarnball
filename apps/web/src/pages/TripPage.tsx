import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { ChatSessionDto } from "@odessey/shared";
import { api } from "../api/client";
import { useTripStore } from "../stores/tripStore";
import { MapCanvas, DAY_COLORS } from "../features/map/MapCanvas";
import { ItineraryPanel } from "../features/itinerary/ItineraryPanel";
import { ChatPanel } from "../features/chat/ChatPanel";
import { HotelPanel } from "../features/hotel/HotelPanel";
import { SearchAddPanel } from "../features/map/SearchAddPanel";

type Tab = "chat" | "itinerary" | "hotel" | "search";

export function TripPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const { bundle, error, load, subscribe } = useTripStore();
  const [amapJsKey, setAmapJsKey] = useState("");
  const [amapJsSecret, setAmapJsSecret] = useState("");
  const [tab, setTab] = useState<Tab>("chat");
  const [chatSessions, setChatSessions] = useState<ChatSessionDto[]>([]);
  const [visibleDay, setVisibleDay] = useState<number | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [hotelArea, setHotelArea] = useState<{ center: { lng: number; lat: number }; radiusM: number } | null>(null);

  useEffect(() => {
    if (!tripId) return;
    void load(tripId);
    const unsubscribe = subscribe(tripId);
    return unsubscribe;
  }, [tripId, load, subscribe]);

  // 推荐住宿区域：地点数变化时重拉
  useEffect(() => {
    if (!tripId || !bundle) return;
    void api.hotelArea(tripId).then(({ area }) => setHotelArea(area));
  }, [tripId, bundle?.places.length]);

  useEffect(() => {
    void api.config().then((c) => {
      setAmapJsKey(c.amapJsKey);
      setAmapJsSecret(c.amapJsSecret);
    });
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!tripId) return;
    const { sessions } = await api.chatSessions(tripId);
    setChatSessions(sessions);
  }, [tripId]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  if (error) {
    return <div className="flex h-full items-center justify-center text-sm text-red-500">{error}</div>;
  }
  if (!bundle) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400">加载中…</div>;
  }

  const { trip } = bundle;
  const days = [...bundle.days].sort((a, b) => a.dayIndex - b.dayIndex);

  const tabs: { key: Tab; label: string }[] = [
    { key: "chat", label: "💬 对话" },
    { key: "itinerary", label: "🗓 行程" },
    { key: "hotel", label: "🏨 酒店" },
    { key: "search", label: "🔎 添加" },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <a href="/" className="text-sm text-slate-400 hover:text-slate-600">
          ←
        </a>
        <h1 className="text-base font-semibold">{trip.title}</h1>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
          {trip.destinationCity}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={`/share/${trip.shareToken}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            只读分享
          </a>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 地图 2/3 */}
        <div className="relative min-w-0 flex-[2]">
          <MapCanvas
            bundle={bundle}
            amapJsKey={amapJsKey}
            amapJsSecret={amapJsSecret}
            visibleDayIndex={visibleDay}
            hotelArea={hotelArea}
            selectedPlaceId={selectedPlaceId}
            onSelectPlace={(id) => setSelectedPlaceId(id)}
          />
          {/* Day 筛选 chips */}
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

        {/* 右侧 1/3 面板 */}
        <div className="flex min-w-0 flex-1 flex-col border-l border-slate-200 bg-white">
          <nav className="flex border-b border-slate-100">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex-1 px-3 py-2 text-sm ${
                  tab === t.key
                    ? "border-b-2 border-blue-600 font-medium text-blue-600"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1">
            {tab === "chat" && (
              <ChatPanel
                trip={trip}
                sessions={chatSessions}
                onSessionsChanged={() => void refreshSessions()}
                selectedPlaceId={selectedPlaceId}
              />
            )}
            {tab === "itinerary" && (
              <ItineraryPanel
                tripId={trip.id}
                bundle={bundle}
                selectedPlaceId={selectedPlaceId}
                onSelectPlace={setSelectedPlaceId}
                onDataChanged={() => void load(trip.id)}
              />
            )}
            {tab === "hotel" && (
              <HotelPanel tripId={trip.id} bundle={bundle} onDataChanged={() => void load(trip.id)} />
            )}
            {tab === "search" && (
              <SearchAddPanel
                tripId={trip.id}
                bundle={bundle}
                onDataChanged={() => void load(trip.id)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
