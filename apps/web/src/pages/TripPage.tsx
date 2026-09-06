import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CalendarDays,
  CalendarCheck,
  BedDouble,
  Clock,
  Crosshair,
  ExternalLink,
  Globe,
  Hourglass,
  Link2,
  Lock,
  LockOpen,
  MapPin,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Phone,
  Search,
  Sparkles,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { formatMoney, formatVisitDuration, type BudgetSummary, type ChatSessionDto, type PlaceDto } from "@yarnball/shared";
import { api } from "../api/client";
import { api as uxApi } from "../lib/api";
import { useTripStore } from "../stores/tripStore";
import { Badge } from "../components/ui/badge";
import { MapCanvas } from "../features/map/MapCanvas";
import { ItineraryPanel } from "../features/itinerary/ItineraryPanel";
import { ChatPanel } from "../features/chat/ChatPanel";
import { CandidatesPanel } from "../features/candidates/CandidatesPanel";
import { candidatesApi } from "../features/candidates/api";
import { HotelStayRangePicker } from "../features/candidates/HotelStayRangePicker";
import { getSelectedStays, type HotelStayRange } from "../features/candidates/hotelStays";
import {
  BOOKING_STATUS_META,
  bookingStatusOf,
  nextBookingStatus,
  openingHoursOf,
} from "../features/candidates/booking";
import { SearchAddPanel } from "../features/map/SearchAddPanel";
import { BudgetStrip } from "../features/budget/BudgetStrip";

/**
 * 行程页 —— macOS Tahoe（Liquid Glass）布局：地图全屏打底，一切 UI 都是玻璃浮层。
 */

type LeftPanel = "itinerary" | "candidates" | "search";

const LEFT_PANEL_META: Record<LeftPanel, { label: string; Icon: LucideIcon }> = {
  itinerary: { label: "行程", Icon: CalendarDays },
  candidates: { label: "候选池", Icon: Star },
  search: { label: "添加地点", Icon: Search },
};

/** 设置抽屉由 M2（features/settings）挂载；合并前用全局事件解耦对接 */
const OPEN_SETTINGS_EVENT = "yarnball:open-settings";

/** 信息卡外链展示：取 URL 的 host，解析失败退回原文截断 */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function TripPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const { bundle, error, load, subscribe } = useTripStore();
  const [amapJsKey, setAmapJsKey] = useState("");
  const [amapJsSecret, setAmapJsSecret] = useState("");
  const [leftPanel, setLeftPanel] = useState<LeftPanel | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSessionDto[]>([]);
  const [visibleDay, setVisibleDay] = useState<number | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [hotelArea, setHotelArea] = useState<{ center: { lng: number; lat: number }; radiusM: number } | null>(null);
  const [budgetSummary, setBudgetSummary] = useState<BudgetSummary | null>(null);
  /** 面板形态：expanded（完整）/ hidden（收起到右上角的呼出钮） */
  const [panelMode, setPanelMode] = useState<"expanded" | "hidden">("expanded");
  /** 左下 dock 面板放大态：跨面板切换保持（M15） */
  const [dockMaximized, setDockMaximized] = useState(false);

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

  // 预算汇总：bundle 被替换（load/SSE 全量快照）即意味着数据变了，跟着重拉
  useEffect(() => {
    if (!tripId || !bundle) return;
    let cancelled = false;
    api
      .getBudget(tripId)
      .then(({ summary }) => {
        if (!cancelled) setBudgetSummary(summary);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tripId, bundle]);

  /** 预算保存后：币种写进了 trip，汇总和 bundle 都要重拉（价格展示跟着换币种） */
  const refreshBudget = useCallback(async () => {
    if (!tripId) return;
    const { summary } = await api.getBudget(tripId);
    setBudgetSummary(summary);
    await load(tripId);
  }, [tripId, load]);

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

  /** 地点操作进行中（选中卡片的加入/移出/删除按钮防重入） */
  const [placeBusy, setPlaceBusy] = useState(false);

  /** 打开设置抽屉：M2 的设置入口监听该事件；M2 未合并时事件无人消费，静默降级 */
  const openSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
  }, []);

  /** 加入/移出地点（底层 locked 状态切换，M20 UI 话术统一为「加入行程」）：写后依赖 SSE bundle 全量刷新，再主动 load 兜底 */
  async function togglePlaceLock(place: PlaceDto) {
    const next = place.status === "locked" ? "candidate" : "locked";
    setPlaceBusy(true);
    try {
      await uxApi.setPlaceStatus(place.id, next);
      if (tripId) await load(tripId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPlaceBusy(false);
    }
  }

  async function deletePlace(place: PlaceDto) {
    if (!confirm(`删除「${place.name}」？已排入的日程也会一并移除。`)) return;
    setPlaceBusy(true);
    try {
      await candidatesApi.deletePlace(place.id);
      setSelectedPlaceId(null);
      toast.success(`已删除「${place.name}」`);
      if (tripId) await load(tripId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPlaceBusy(false);
    }
  }

  /** 预订状态点选流转（M11：PATCH /api/places/:id 带 bookingStatus）：所有 locked 地点可切换（含已排期）；写后靠 SSE 全量刷新 + 主动 load 兜底 */
  async function cyclePlaceBooking(place: PlaceDto) {
    setPlaceBusy(true);
    try {
      await uxApi.updatePlace(place.id, { bookingStatus: nextBookingStatus(bookingStatusOf(place)) });
      if (tripId) await load(tripId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPlaceBusy(false);
    }
  }

  /** 已选定酒店的入离店天修改（多酒店，M10）：写后靠 SSE 全量刷新 + 主动 load 兜底 */
  async function updateHotelStayRange(candidateId: string, range: HotelStayRange) {
    if (!tripId) return;
    setPlaceBusy(true);
    try {
      await uxApi.selectHotel(tripId, { candidateId, ...range });
      await load(tripId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPlaceBusy(false);
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
  const scheduledPlaceIds = new Set(bundle.entries.map((e) => e.placeId));
  const days = [...bundle.days].sort((a, b) => a.dayIndex - b.dayIndex);
  /** 多酒店（M10）：选中地点是酒店时，取其已选定住宿区间用于展示/编辑入离店天 */
  const hotelStays = getSelectedStays(bundle);
  const selectedHotelCand =
    selectedPlace != null
      ? bundle.hotelCandidates.find((h) => h.placeId === selectedPlace.id) ?? null
      : null;
  const selectedStay =
    selectedHotelCand != null
      ? hotelStays.find((s) => s.candidateId === selectedHotelCand.id) ?? null
      : null;
  const leftPanels = Object.entries(LEFT_PANEL_META) as [LeftPanel, { label: string; Icon: LucideIcon }][];
  const activeLeftMeta = leftPanel != null ? LEFT_PANEL_META[leftPanel] : null;

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
          onOpenSettings={openSettings}
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
        <Link
          to={`/share/${trip.shareToken}`}
          target="_blank"
          title="打开只读分享页"
          className="flex items-center gap-1 rounded-full bg-slate-900/8 px-2.5 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-900/15"
        >
          <Link2 className="size-3" />
          分享
        </Link>
      </header>

      {/* 左上（行程信息条下方）：选中地点信息卡（可操作：加入行程/移出行程/删除） ===== */}
      {selectedPlace && (
        <div className="glass panel-in rounded-card absolute left-4 top-[60px] z-10 max-w-xs p-3.5 shadow-card">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">
                {selectedPlace.name}
              </p>
            </div>
            <button
              onClick={() => setSelectedPlaceId(null)}
              className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-900/8 hover:text-slate-600"
            >
              ✕
            </button>
          </div>
          {/* 状态徽章：排期中（scheduled 蓝）> 已加入（locked 金）> 候选（消费 M13 令牌变体，M20 措辞统一为「已加入」）；agent 建的地点带推荐标记 */}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {scheduledPlaceIds.has(selectedPlace.id) ? (
              <Badge variant="scheduled">已加入</Badge>
            ) : selectedPlace.status === "locked" ? (
              <Badge variant="locked">已加入</Badge>
            ) : (
              <Badge variant="candidate">候选</Badge>
            )}
            {selectedPlace.createdBy === "agent" && (
              <Badge variant="blue">
                <Sparkles className="size-3" />
                agent 推荐
              </Badge>
            )}
            {/* 预订状态徽章（M11）：所有 locked 地点可点选流转（含已排期，与候选池一致） */}
            {selectedPlace.status === "locked" ? (
              <button
                title="点击切换预订状态（无需预订 → 待预订 → 已预订）"
                disabled={placeBusy}
                onClick={() => void cyclePlaceBooking(selectedPlace)}
                className="disabled:opacity-50"
              >
                <Badge
                  variant={BOOKING_STATUS_META[bookingStatusOf(selectedPlace)].badgeVariant}
                  className="cursor-pointer"
                >
                  <CalendarCheck className="size-3" />
                  {BOOKING_STATUS_META[bookingStatusOf(selectedPlace)].label}
                </Badge>
              </button>
            ) : (
              bookingStatusOf(selectedPlace) !== "none" && (
                <Badge variant={BOOKING_STATUS_META[bookingStatusOf(selectedPlace)].badgeVariant}>
                  {BOOKING_STATUS_META[bookingStatusOf(selectedPlace)].label}
                </Badge>
              )
            )}
          </div>
          {/* 详情块（M26）：地址/营业时间/预计游览时长/电话/官网/预订链接，有值才显示；外链新窗口打开 */}
          {(selectedPlace.address ||
            openingHoursOf(selectedPlace) ||
            selectedPlace.visitDurationMin != null ||
            selectedPlace.phone ||
            selectedPlace.website ||
            selectedPlace.bookingUrl) && (
            <div className="mt-2 space-y-1 rounded-lg bg-slate-900/5 px-2.5 py-2 text-[11px] text-slate-600">
              {selectedPlace.address && (
                <p className="flex items-start gap-1.5">
                  <MapPin className="mt-0.5 size-3 shrink-0 text-slate-400" />
                  <span>{selectedPlace.address}</span>
                </p>
              )}
              {openingHoursOf(selectedPlace) && (
                <p className="flex items-start gap-1.5">
                  <Clock className="mt-0.5 size-3 shrink-0 text-slate-400" />
                  <span>{openingHoursOf(selectedPlace)}</span>
                </p>
              )}
              {selectedPlace.visitDurationMin != null && (
                <p className="flex items-center gap-1.5">
                  <Hourglass className="size-3 shrink-0 text-slate-400" />
                  <span>{formatVisitDuration(selectedPlace.visitDurationMin)}</span>
                </p>
              )}
              {selectedPlace.phone && (
                <p className="flex items-center gap-1.5">
                  <Phone className="size-3 shrink-0 text-slate-400" />
                  <span>{selectedPlace.phone}</span>
                </p>
              )}
              {selectedPlace.website && (
                <a
                  href={selectedPlace.website}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-blue-600 hover:underline"
                >
                  <Globe className="size-3 shrink-0 text-slate-400" />
                  <span className="truncate">官网 · {urlHost(selectedPlace.website)}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              )}
              {selectedPlace.bookingUrl && (
                <a
                  href={selectedPlace.bookingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-blue-600 hover:underline"
                >
                  <CalendarCheck className="size-3 shrink-0 text-slate-400" />
                  <span className="truncate">预订 · {urlHost(selectedPlace.bookingUrl)}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              )}
            </div>
          )}
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
          {/* 酒店：已加入行程时显示并可编辑入离店天（多酒店，M10） */}
          {selectedHotelCand && (
            <div className="mt-1.5 rounded-lg bg-red-500/8 px-2 py-1.5 text-[11px] text-slate-600">
              <p className="flex items-center gap-1">
                <BedDouble className="size-3 shrink-0 text-slate-400" />
                {selectedStay ? "已加入行程的住宿" : "酒店候选（未加入，可在候选池加入行程）"}
              </p>
              {selectedStay && days.length > 0 && (
                <div className="mt-1">
                  <HotelStayRangePicker
                    totalDays={days.length}
                    checkInDay={selectedStay.checkInDay}
                    checkOutDay={selectedStay.checkOutDay}
                    otherStays={hotelStays
                      .filter((s) => s.candidateId !== selectedStay.candidateId)
                      .map((s) => ({
                        ...s,
                        label: bundle.places.find((p) => p.id === s.placeId)?.name,
                      }))}
                    disabled={placeBusy}
                    onChange={(range) => void updateHotelStayRange(selectedStay.candidateId, range)}
                  />
                </div>
              )}
            </div>
          )}
          {selectedPlace.notes && (
            <p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-slate-500">{selectedPlace.notes}</p>
          )}
          {/* 操作行：已排期地点不再提供加入/移出开关（排期即已确认） */}
          <div className="mt-2.5 flex items-center gap-1.5 border-t border-slate-900/8 pt-2.5">
            {!scheduledPlaceIds.has(selectedPlace.id) && (
              <button
                title={
                  selectedPlace.status === "locked"
                    ? "移出行程（退回候选池，不再必排进日程）"
                    : "加入行程（确认要去，排日程时必排）"
                }
                disabled={placeBusy}
                onClick={() => void togglePlaceLock(selectedPlace)}
                className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  selectedPlace.status === "locked"
                    ? "bg-locked/10 text-locked hover:bg-locked/20"
                    : "bg-slate-900/8 text-slate-600 hover:bg-slate-900/15"
                }`}
              >
                {selectedPlace.status === "locked" ? (
                  <>
                    <LockOpen className="size-3" /> 移出行程
                  </>
                ) : (
                  <>
                    <Lock className="size-3" /> 加入行程
                  </>
                )}
              </button>
            )}
            <button
              disabled={placeBusy}
              onClick={() => void deletePlace(selectedPlace)}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-red-100/80 hover:text-red-600 disabled:opacity-50"
            >
              <Trash2 className="size-3" /> 删除
            </button>
          </div>
        </div>
      )}

      {/* 左下：数据面板 dock（行程/候选池/添加），常驻一小条，点击展开 ===== */}
      {leftPanel != null && activeLeftMeta != null && (
        <div
          className={`glass-deep panel-in absolute bottom-[68px] left-4 z-10 flex max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[22px] transition-all duration-300 ease-out ${
            dockMaximized
              ? "h-[min(80vh,900px)] w-[min(640px,calc(100vw-2rem))]"
              : "h-[min(52vh,500px)] w-[360px]"
          }`}
        >
          <div className="flex items-center gap-2 border-b border-white/40 px-4 py-2.5">
            <activeLeftMeta.Icon className="size-3.5 text-slate-500" />
            <span className="glass-text ml-1 text-xs font-semibold">{activeLeftMeta.label}</span>
            <button
              onClick={() => setDockMaximized((v) => !v)}
              title={dockMaximized ? "恢复面板大小" : "放大面板"}
              className="ml-auto flex size-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-slate-600"
            >
              {dockMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </button>
            <button
              onClick={() => setLeftPanel(null)}
              title="收起面板"
              className="flex size-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-slate-600"
            >
              ✕
            </button>
          </div>
          {/* 预算条：跨类别（住宿/餐饮/门票）汇总，面板展开时常驻顶部 */}
          <div className="glass-text flex min-h-0 flex-1 flex-col gap-3 bg-white/40 py-3">
            {budgetSummary && (
              <div className="px-3">
                <BudgetStrip tripId={trip.id} summary={budgetSummary} onRefresh={refreshBudget} />
              </div>
            )}
            <div className="min-h-0 flex-1">
              {leftPanel === "itinerary" && (
                <ItineraryPanel
                  tripId={trip.id}
                  bundle={bundle}
                  selectedPlaceId={selectedPlaceId}
                  onSelectPlace={setSelectedPlaceId}
                  onDataChanged={() => void load(trip.id)}
                  visibleDay={visibleDay}
                  onVisibleDayChange={setVisibleDay}
                  onOpenCandidates={() => setLeftPanel("candidates")}
                />
              )}
              {leftPanel === "candidates" && (
                <CandidatesPanel
                  tripId={trip.id}
                  bundle={bundle}
                  hotelArea={hotelArea}
                  selectedPlaceId={selectedPlaceId}
                  onSelectPlace={setSelectedPlaceId}
                  onDataChanged={() => void load(trip.id)}
                />
              )}
              {leftPanel === "search" && (
                <SearchAddPanel tripId={trip.id} bundle={bundle} onDataChanged={() => void load(trip.id)} />
              )}
            </div>
          </div>
        </div>
      )}
      <div className="glass panel-in absolute bottom-4 left-4 z-10 flex items-center gap-1 rounded-full p-1.5">
        {leftPanels.map(([key, meta]) => (
          <button
            key={key}
            onClick={() => setLeftPanel(leftPanel === key ? null : key)}
            title={leftPanel === key ? `收起${meta.label}面板` : `展开${meta.label}面板`}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              leftPanel === key
                ? "bg-slate-900 text-white shadow-sm"
                : "text-slate-500 hover:bg-slate-900/5 hover:text-slate-800"
            }`}
          >
            <meta.Icon className="size-3.5" />
            {meta.label}
          </button>
        ))}
      </div>

      {/* 右侧主面板：纯 agent 对话 ===== */}
      {panelMode === "hidden" ? (
        <button
          onClick={() => setPanelMode("expanded")}
          className="glass panel-in absolute right-4 top-4 z-20 flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium text-slate-600 transition-transform hover:scale-105"
        >
          <PanelRightOpen className="size-3.5" />
          显示 Agent 面板
        </button>
      ) : (
        <aside className="glass-deep panel-in absolute bottom-4 right-4 top-4 z-20 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[22px]">
          {/* 收起把手：面板右上角内侧（会话头已用 pr-11 让位） */}
          <button
            onClick={() => setPanelMode("hidden")}
            title="收起面板"
            className="absolute right-2 top-2 z-30 flex size-7 items-center justify-center rounded-full text-slate-400 transition-all hover:bg-slate-900/8 hover:text-slate-700"
          >
            <PanelRightClose className="size-4" />
          </button>

          <div className="glass-text min-h-0 flex-1 bg-white/40">
            <ChatPanel
              trip={trip}
              sessions={chatSessions}
              onSessionsChanged={() => void refreshSessions()}
              selectedPlaceId={selectedPlaceId}
            />
          </div>
        </aside>
      )}
    </div>
  );
}