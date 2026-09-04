import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  BedDouble,
  CalendarDays,
  CalendarCheck,
  Crosshair,
  Link2,
  MessageCircle,
  Search,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { ChatSessionDto } from "@odessey/shared";
import { api } from "../api/client";
import { useTripStore } from "../stores/tripStore";
import { MapCanvas, dayColor } from "../features/map/MapCanvas";
import { ItineraryPanel } from "../features/itinerary/ItineraryPanel";
import { ChatPanel } from "../features/chat/ChatPanel";
import { HotelPanel } from "../features/hotel/HotelPanel";
import { SearchAddPanel } from "../features/map/SearchAddPanel";
import { DiningBudgetPanel } from "../features/dining/DiningBudgetPanel";
import { formatMoney } from "@odessey/shared";

/**
 * 行程页 —— macOS Tahoe（Liquid Glass）布局：地图全屏打底，一切 UI 都是玻璃浮层。
 */

type Tab = "chat" | "itinerary" | "hotel" | "dining" | "search";

const TAB_META: Record<Tab, { label: string; Icon: LucideIcon }> = {
  chat: { label: "对话", Icon: MessageCircle },
  itinerary: { label: "行程", Icon: CalendarDays },
  hotel: { label: "酒店", Icon: BedDouble },
  dining: { label: "美食·预算", Icon: UtensilsCrossed },
  search: { label: "添加", Icon: Search },
};

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
  /** 面板形态：expanded（完整）/ collapsed（收成竖条）/ hidden（隐藏，只剩呼出按钮） */
  const [panelMode, setPanelMode] = useState<"expanded" | "collapsed" | "hidden">("expanded");

  useEffect(() => {
    if (!tripId) return;
    void load(tripId);
    const unsubscribe = subscribe(tripId);
    return unsubscribe;
  }, [tripId, load, subscribe]);

  useEffect(() => {
    void api.config().then((c) => {
      setAmapJsKey(c.amapJsKey);
      setAmapJsSecret(c.amapJsSecret);
    });
  }, []);

  // 推荐住宿区域：地点数变化时重拉
  useEffect(() => {
    if (!tripId || !bundle) return;
    void api.hotelArea(tripId).then(({ area }) => setHotelArea(area));
  }, [tripId, bundle?.places.length]);

  // 城市定位自愈：行程没有中心坐标（创建时解析失败）→ 自动重解析一次
  const cityUnresolved = bundle != null && bundle.trip.location == null;
  useEffect(() => {
    if (!tripId || !cityUnresolved) return;
    let cancelled = false;
    void api
      .resolveCity(tripId)
      .then(({ trip }) => {
        if (!cancelled && trip.location == null) {
          toast.warning("城市定位失败", {
            description: `无法解析「${trip.destinationCity}」，试试英文名（如 Sydney）或点右上角定位按钮重试。`,
            duration: 6000,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tripId, cityUnresolved]);

  // 手动重定位按钮
  async function relocate() {
    if (!tripId) return;
    try {
      const { trip } = await api.resolveCity(tripId);
      if (trip.location) {
        toast.success(`已定位到 ${trip.destinationCity}`);
        await load(tripId);
      } else {
        toast.error("定位失败", {
          description: "无法解析这个城市名，试试更通用的写法（如 Sydney、Melbourne）。",
        });
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

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
    return <div className="flex h-full items-center justify-center bg-slate-100 text-sm text-slate-400">加载中…</div>;
  }

  const { trip } = bundle;
  const selectedPlace =
    selectedPlaceId != null
      ? bundle.places.find((p) => p.id === selectedPlaceId) ?? null
      : null;
  const ActiveTabIcon = TAB_META[tab].Icon;
  const days = [...bundle.days].sort((a, b) => a.dayIndex - b.dayIndex);
  const tabs = Object.entries(TAB_META) as [Tab, { label: string; Icon: LucideIcon }][];

  return (
    <div className="relative h-full overflow-hidden">
      {/* 地图全屏打底 */}
      <div className="absolute inset-0">
        <MapCanvas
          bundle={bundle}
          amapJsKey={amapJsKey}
          amapJsSecret={amapJsSecret}
          visibleDayIndex={visibleDay}
          hotelArea={hotelArea}
          selectedPlaceId={selectedPlaceId}
          onSelectPlace={(id) => setSelectedPlaceId(id)}
        />
      </div>

      {/* 左上：行程信息玻璃条 */}
      <header className="glass panel-in pointer-events-auto absolute left-4 top-4 z-10 flex items-center gap-2.5 rounded-2xl px-4 py-2">
        <Link
          to="/"
          className="flex size-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-slate-700"
          title="返回行程列表"
        >
          ‹
        </Link>
        <h1 className="glass-text text-sm font-semibold">{trip.title}</h1>
        <span className="rounded-full bg-slate-900/8 px-2 py-0.5 text-[11px] font-medium text-slate-500">
          {trip.destinationCity}
        </span>
        {trip.geoProvider === "osm" && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            海外
          </span>
        )}
        <button
          onClick={() => void relocate()}
          title="重新定位到目的城市"
          className="flex size-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-blue-600"
        >
          <Crosshair className="size-3.5" />
        </button>
      </header>

      {/* 左上第二行：Day 筛选 chips */}
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
                style={
                  active
                    ? { background: color, color: "#fff", borderColor: "transparent" }
                    : { color }
                }
              >
                D{d.dayIndex}
              </button>
            );
          })}
        </div>
      )}

      {/* 左下：选中地点信息卡 */}
      {selectedPlace && (
        <div className="glass panel-in absolute bottom-4 left-4 z-10 max-w-xs rounded-2xl p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">
                {selectedPlace.name}
              </p>
              <p className="truncate text-[11px] text-slate-400">{selectedPlace.address ?? ""}</p>
            </div>
            <button
              onClick={() => setSelectedPlaceId(null)}
              className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-900/8 hover:text-slate-600"
            >
              ✕
            </button>
          </div>
          {selectedPlace.priceCny != null && (
            <p className="mt-1.5 text-sm font-semibold text-orange-600">
              {formatMoney(selectedPlace.priceCny, trip.currency)}
              {selectedPlace.category === "restaurant" ? " /人" : selectedPlace.category === "hotel" ? " /晚" : ""}
            </p>
          )}
          {selectedPlace.bookingInfo && (
            <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-blue-500/10 px-2 py-1 text-[11px] text-blue-700">
              <CalendarCheck className="mt-0.5 size-3 shrink-0" />
              {selectedPlace.bookingInfo}
            </p>
          )}
          {selectedPlace.notes && (
            <p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-slate-500">{selectedPlace.notes}</p>
          )}
        </div>
      )}

      {/* 左下：只读分享入口（低调） */}
      <Link
        to={`/share/${trip.shareToken}`}
        target="_blank"
        className={`glass glass-text panel-in absolute z-10 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-slate-600 transition-transform hover:scale-105 ${
          selectedPlace ? "bottom-4 left-[calc(1rem+min(20rem,60vw))]" : "bottom-4 left-4"
        }`}
      >
        <Link2 className="size-3.5" />
        只读分享
      </Link>

      {/* 右侧主面板（mac 窗口） ===== */}
      {panelMode === "hidden" ? (
        <button
          onClick={() => setPanelMode("expanded")}
          className="glass panel-in absolute right-4 top-4 z-20 flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium text-slate-600 transition-transform hover:scale-105"
        >
          <ActiveTabIcon className="size-3.5" />
          <span>显示{TAB_META[tab].label}面板</span>
        </button>
      ) : panelMode === "collapsed" ? (
        <div className="glass panel-in absolute right-4 top-4 z-20 flex flex-col items-center gap-1 rounded-3xl p-2.5">
          {/* mini traffic lights */}
          <div className="flex gap-2 pb-1.5">
            <TrafficLight color="#ff5f57" title="隐藏面板" onClick={() => setPanelMode("hidden")} />
            <TrafficLight color="#febc2e" title="已收起，点击展开" onClick={() => setPanelMode("expanded")} />
            <TrafficLight color="#28c840" title="展开面板" onClick={() => setPanelMode("expanded")} />
          </div>
          <div className="flex flex-col gap-1">
            {tabs.map(([key, meta]) => (
              <button
                key={key}
                onClick={() => {
                  setTab(key);
                  setPanelMode("expanded");
                }}
                title={meta.label}
                className={`rounded-full p-2 transition-colors ${
                  tab === key ? "bg-slate-900/10 text-slate-900" : "text-slate-500 hover:bg-slate-900/5"
                }`}
              >
                <meta.Icon className="size-4" />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <aside className="glass-deep panel-in absolute bottom-4 right-4 top-4 z-20 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[22px]">
          {/* traffic lights 标题栏 */}
          <div className="flex items-center gap-2 border-b border-white/40 px-4 py-2.5">
            <div className="flex gap-2">
              <TrafficLight color="#ff5f57" title="隐藏面板" onClick={() => setPanelMode("hidden")} />
              <TrafficLight color="#febc2e" title="收成竖条" onClick={() => setPanelMode("collapsed")} />
              <TrafficLight color="#28c840" title="展开中" active onClick={() => {}} />
            </div>
            <span className="glass-text ml-1 flex items-center gap-1.5 truncate text-xs font-semibold">
              <ActiveTabIcon className="size-3.5 text-slate-500" />
              {TAB_META[tab].label}
            </span>
          </div>

          {/* 分段控件（macOS segmented control） */}
          <nav className="px-3 pt-3">
            <div className="segmented w-full">
              {tabs.map(([key, meta]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  data-active={tab === key}
                  className="segmented-item flex-1"
                >
                  <meta.Icon className="size-3.5" />
                  <span className="truncate">{meta.label}</span>
                </button>
              ))}
            </div>
          </nav>

          {/* 内容区（玻璃上再垫一层更实的底，保证长列表可读性） */}
          <div className="glass-text min-h-0 flex-1 bg-white/40 px-0 py-3">
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
            {tab === "dining" && (
              <DiningBudgetPanel tripId={trip.id} bundle={bundle} onDataChanged={() => void load(trip.id)} />
            )}
            {tab === "search" && (
              <SearchAddPanel
                tripId={trip.id}
                bundle={bundle}
                onDataChanged={() => void load(trip.id)}
              />
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/** mac traffic light 玻璃珠（CSS 材质见 .traffic-light） */
function TrafficLight({
  color,
  title,
  onClick,
  active = false,
}: {
  color: string;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="traffic-light"
      style={{
        background: color,
        boxShadow: active
          ? `0 0 0 3px ${color}33, inset 0 1px 1px rgba(255,255,255,.65), inset 0 -1px 2px rgba(0,0,0,.18)`
          : undefined,
      }}
    />
  );
}