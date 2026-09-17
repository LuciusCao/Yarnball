import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CalendarDays,
  CalendarCheck,
  CalendarMinus,
  CalendarPlus,
  BedDouble,
  ChevronDown,
  ChevronUp,
  Clock,
  Crosshair,
  ExternalLink,
  Globe,
  Hourglass,
  Link2,
  MapPin,
  Maximize2,
  Minimize2,
  NotebookText,
  PanelRightClose,
  PanelRightOpen,
  Phone,
  Printer,
  Search,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { formatMoney, formatVisitDuration, isDomesticOsmTrip, type BudgetSummary, type ChatSessionDto, type PlaceDto } from "@yarnball/shared";
import { api } from "../api/client";
import { api as uxApi } from "../lib/api";
import { GUEST_KICKED_EVENT } from "../lib/http";
import {
  credentialByTripId,
  usePrincipalStore,
  type GuestCredential,
} from "../lib/principal";
import { useTripStore } from "../stores/tripStore";
import { useSyncedInput } from "../lib/useSyncedInput";
import { Badge } from "../components/ui/badge";
import { MapCanvas } from "../features/map/MapCanvas";
import { ItineraryPanel } from "../features/itinerary/ItineraryPanel";
import { ChatPanel } from "../features/chat/ChatPanel";
import { CandidatesPanel } from "../features/candidates/CandidatesPanel";
import { candidatesApi } from "../features/candidates/api";
import { HotelStayRangePicker } from "../features/candidates/HotelStayRangePicker";
import { getSelectedStays, largestFreeSpan, type HotelStayRange } from "../features/candidates/hotelStays";
import {
  BOOKING_STATUS_META,
  bookingStatusOf,
  nextBookingStatus,
  openingHoursOf,
} from "../features/candidates/booking";
import { SearchAddPanel } from "../features/map/SearchAddPanel";
import { BudgetStrip } from "../features/budget/BudgetStrip";
import { ExportPrintDialog } from "../features/export/ExportPrintDialog";
import { TripNotesPanel } from "../features/notes/TripNotesPanel";
import { ShareCollabDialog } from "../features/share/ShareCollabDialog";
// 协作实时体验（issue #19）：在线名单 + 动态流，独立组件、挂载点最小化（guest 门控属 #20，此处不碰）
import { PresenceBar } from "../features/presence/PresenceBar";
import { ActivityFeed } from "../features/activity/ActivityFeed";

/**
 * 行程页 —— macOS Tahoe（Liquid Glass）布局：地图全屏打底，一切 UI 都是玻璃浮层。
 */

type ToolPanel = "itinerary" | "candidates" | "search" | "notes";

const TOOL_PANEL_META: Record<ToolPanel, { label: string; Icon: LucideIcon }> = {
  itinerary: { label: "行程", Icon: CalendarDays },
  candidates: { label: "候选", Icon: Star },
  search: { label: "添加", Icon: Search },
  // M102（issue #11）：行程级注意事项（7 类结构化展示 + 增删改）
  notes: { label: "须知", Icon: NotebookText },
};

/** 工具面板展开状态持久化（M61）：记住用户收起的偏好；无记录时默认展开「行程」tab */
const TOOL_PANEL_STORAGE_KEY = "yarnball:trip-tool-panel";

function readStoredToolPanel(): ToolPanel | null {
  try {
    const raw = localStorage.getItem(TOOL_PANEL_STORAGE_KEY);
    if (raw === "none") return null;
    if (raw != null && raw in TOOL_PANEL_META) return raw as ToolPanel;
  } catch {
    // localStorage 不可用（隐私模式等）时退回默认
  }
  return "itinerary";
}

/** 设置抽屉由 M2（features/settings）挂载；合并前用全局事件解耦对接 */
const OPEN_SETTINGS_EVENT = "yarnball:open-settings";

/** 国内零配置降级横幅（M113）的「不再提示」标记：全局一次性，关掉后所有行程不再展示 */
const DOMESTIC_OSM_BANNER_KEY = "yarnball:domestic-osm-banner-dismissed";

/** 信息卡外链展示：取 URL 的 host，解析失败退回原文截断 */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 被主人撤销链接的整页提示（guest-kicked）：文案与 JoinPage 的「已被撤销」错误页对齐 */
function GuestKickedScreen({ displayName }: { displayName: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-slate-100">
      <div className="mx-4 flex max-w-sm flex-col items-center gap-3 rounded-3xl border border-slate-200/80 bg-white/80 px-8 py-10 text-center shadow-sm backdrop-blur">
        <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/12">
          <TriangleAlert className="size-6 text-amber-500" />
        </div>
        <h1 className="text-base font-semibold text-slate-900">链接已被主人撤销</h1>
        <p className="text-sm leading-relaxed text-slate-500">
          {displayName}，行程主人已撤销这个协作链接，你已退出该行程。需要继续协作请联系主人重新生成链接。
        </p>
        <Link to="/" className="text-sm font-medium text-blue-600 underline-offset-2 hover:underline">
          返回首页
        </Link>
      </div>
    </div>
  );
}

/** 信息卡描述文本（M82）：默认 line-clamp-3 截断；用 scrollHeight vs clientHeight 检测截断是否真实发生，
    只在被截断时显示「展开/收起」按钮（短描述不出钮）；展开后完整文本随卡片既有 overflow-y-auto 滚动区可读，再点收起还原 */
function InfoCardNotes({ notes }: { notes: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // 展开态下 skip 测量（展开后 scrollHeight == clientHeight，会把已测得的 clamped 冲掉导致按钮消失）
    if (expanded) return;
    const el = textRef.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [notes, expanded]);

  return (
    <div className="mt-1.5">
      <p
        ref={textRef}
        className={`text-[11px] leading-relaxed text-slate-500 ${expanded ? "" : "line-clamp-3"}`}
      >
        {notes}
      </p>
      {clamped && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 flex items-center gap-0.5 text-[11px] font-medium text-blue-600 hover:underline"
        >
          {expanded ? "收起" : "展开"}
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
      )}
    </div>
  );
}

export function TripPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const { bundle, error, load, subscribe } = useTripStore();
  const [amapJsKey, setAmapJsKey] = useState("");
  const [amapJsSecret, setAmapJsSecret] = useState("");
  /** 顶部工具面板（M61；M62 分段条右对齐，M63 普通态浮层固定 400px 右对齐挂在分段条下方、放大态才 left-4 对齐 + 铺满自由区）：当前展开的 tab；null = 收起。初始值读 localStorage（默认展开行程 tab） */
  const [toolPanel, setToolPanel] = useState<ToolPanel | null>(readStoredToolPanel);
  const [chatSessions, setChatSessions] = useState<ChatSessionDto[]>([]);
  const [visibleDay, setVisibleDay] = useState<number | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  /** 按需显示的交通段（M47）：点击行程面板交通段行/大交通卡选中，地图只画该段；换天/选地点/切面板标签时清除 */
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null);
  /** 地点聚焦请求（M83）：仅行程面板地点行点击触发；nonce 递增保证重复点同一地点也重新 flyTo，
      与 selectedPlaceId 解耦——候选池/搜索面板/地图 marker 的选中不移动相机 */
  const [placeFocus, setPlaceFocus] = useState<{ placeId: string; nonce: number } | null>(null);
  const [budgetSummary, setBudgetSummary] = useState<BudgetSummary | null>(null);
  /** 面板形态：expanded（完整）/ hidden（收起到右上角的呼出钮） */
  const [panelMode, setPanelMode] = useState<"expanded" | "hidden">("expanded");
  /** 工具浮层放大态：跨面板切换保持（M15） */
  const [panelMaximized, setPanelMaximized] = useState(false);
  /** 导出打印预览弹层（M97，issue #7） */
  const [exportOpen, setExportOpen] = useState(false);
  /** 分享与协作面板（issue #17）：原「一个只读分享链接」升级为多链接管理（创建/复制/吊销） */
  const [shareOpen, setShareOpen] = useState(false);
  /** 国内零配置降级横幅（M113）：osm 引擎国内行程的一次性提示，关闭后全局不再展示 */
  const [osmBannerDismissed, setOsmBannerDismissed] = useState(
    () => localStorage.getItem(DOMESTIC_OSM_BANNER_KEY) === "1",
  );
  /** 标题编辑态（issue #12）：点击信息条标题进入行内编辑；editingTitle 开关 + titleDraft 草稿 */
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  /** 标题 input 的 IME 组合输入标志位（r1 修复）：WebKit 下中文输入法确认候选的 Enter 会被误判为保存，
      模式复刻 ChatPanel（issue #4 同款修复）——compositionstart 置位、compositionend 延迟一宏任务复位 */
  const titleImeComposingRef = useRef(false);
  const titleImeResetTimerRef = useRef<number | null>(null);

  // ---------- guest 模式（issue #18）：同伴经 /join/:token 进入时的身份落地 ----------
  // 凭证激活：JoinPage 激活后 store.active 已就位（SSE 订阅在下方 effect 用得上）；
  // 直接刷新 /trip/:id 时 active 为空——挂载时按 tripId 从 localStorage 恢复。
  const guest = usePrincipalStore((s) => s.active);
  const activateCredential = usePrincipalStore((s) => s.activate);
  const deactivateCredential = usePrincipalStore((s) => s.deactivate);
  useEffect(() => {
    if (!tripId) return;
    const saved = credentialByTripId(tripId);
    // 本机 owner（无该行程的 guest 凭证）什么都不做——store.active 恒为 null，所有请求零变化
    if (saved) activateCredential(saved);
    // 卸载时取消生效：离开 guest 上下文即停止 Bearer 注入（凭证留在 localStorage，刷新可恢复）
    return () => deactivateCredential();
  }, [tripId, activateCredential, deactivateCredential]);

  // 链接被吊销/失效（apiFetch 收到 401 广播）：整页切「已被撤销」提示（凭证已清，不再注入）。
  // kicked 是 latch 态：踢出后 active 已被清空（guest 变 null），昵称用 ref 记住供提示页展示
  const [guestKicked, setGuestKicked] = useState(false);
  const kickedNameRef = useRef<string | null>(null);
  if (guest) kickedNameRef.current = guest.displayName;
  useEffect(() => {
    if (!guest) return;
    const onKicked = () => setGuestKicked(true);
    window.addEventListener(GUEST_KICKED_EVENT, onKicked);
    return () => window.removeEventListener(GUEST_KICKED_EVENT, onKicked);
  }, [guest]);

  useEffect(() => {
    if (!tripId) return;
    void load(tripId);
    const unsubscribe = subscribe(tripId);
    return unsubscribe;
  }, [tripId, load, subscribe]);

  // 出发日期输入草稿（issue #19 防冲突）：聚焦期间 SSE 全量刷新不冲掉挑选中的日期；
  // change 即提交（保持原行为），外部值在失焦后照常对齐
  const startDateInput = useSyncedInput(bundle?.trip.startDate ?? "");

  useEffect(() => {
    void api.config().then((c) => {
      setAmapJsKey(c.amapJsKey);
      setAmapJsSecret(c.amapJsSecret);
    });
  }, []);

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

  /** 出发日期修改（信息条 date input）：null = 清除，天标签退化为「Day N」；写后靠 SSE 全量刷新 + 主动 load 兜底 */
  async function updateStartDate(startDate: string | null) {
    if (!tripId) return;
    try {
      await uxApi.updateTrip(tripId, { startDate });
      await load(tripId);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  /** 标题修改进行中（防重入） */
  const [titleBusy, setTitleBusy] = useState(false);

  /** 保存标题（issue #12）：空标题或与原标题一致直接退出编辑态不发请求；写后靠 SSE 全量刷新 + 主动 load 兜底 */
  async function saveTitle() {
    if (!tripId) return;
    const title = titleDraft.trim();
    setEditingTitle(false);
    if (!title || title === bundle?.trip.title) return;
    setTitleBusy(true);
    try {
      await uxApi.renameTrip(tripId, title);
      await load(tripId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setTitleBusy(false);
    }
  }

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

  // M47 清除段选中的三个出口：选中其他地点 / 切换天 / 切换面板标签
  const selectPlace = useCallback((placeId: string | null) => {
    setSelectedLegId(null);
    setSelectedPlaceId(placeId);
  }, []);
  const changeVisibleDay = useCallback((dayIndex: number | null) => {
    setSelectedLegId(null);
    setVisibleDay(dayIndex);
  }, []);
  /** 行程面板地点行点击的地图聚焦（M83）：只记录聚焦意图，相机移动在 MapCanvas 消费 */
  const focusPlace = useCallback((placeId: string) => {
    setPlaceFocus((prev) => ({ placeId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const switchToolPanel = useCallback((panel: ToolPanel | null) => {
    setSelectedLegId(null);
    setToolPanel(panel);
    // M61：展开/收起偏好写 localStorage，下次打开记住收起状态
    try {
      localStorage.setItem(TOOL_PANEL_STORAGE_KEY, panel ?? "none");
    } catch {
      // 持久化失败不影响交互
    }
  }, []);

  // 段被服务端删掉（entry 移除/重算）时清掉悬空的段选中
  useEffect(() => {
    if (!selectedLegId || !bundle) return;
    if (!bundle.legs.some((l) => l.id === selectedLegId)) setSelectedLegId(null);
  }, [selectedLegId, bundle]);

  /** 加入/移出地点（底层 joined 状态切换，M20 UI 话术统一为「加入行程」）：写后依赖 SSE bundle 全量刷新，再主动 load 兜底 */
  async function togglePlaceJoined(place: PlaceDto) {
    const next = place.status === "joined" ? "candidate" : "joined";
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

  /** 预订状态点选流转（M11：PATCH /api/places/:id 带 bookingStatus）：所有 joined 地点可切换（含已排期）；写后靠 SSE 全量刷新 + 主动 load 兜底 */
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

  /** 加入酒店（信息卡主操作，口径对齐候选 selectHotel）：默认占未覆盖的最长连续段；全程已覆盖则提示先调整已有酒店 */
  async function selectHotelStay(candidateId: string) {
    if (!tripId) return;
    if (days.length === 0) {
      toast.warning("还没有行程天数，先让 agent 规划行程再加入酒店");
      return;
    }
    const span = largestFreeSpan(hotelStays, days.length);
    if (!span) {
      toast.warning("全程已被其他已加入的酒店覆盖，请先调整它们的入离店天");
      return;
    }
    setPlaceBusy(true);
    try {
      await uxApi.selectHotel(tripId, { candidateId, ...span });
      await load(tripId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPlaceBusy(false);
    }
  }

  /** 移出酒店（口径对齐候选 unselectHotel）：取消住宿区间，不再锚定每天首尾 */
  async function unselectHotelStay(candidateId: string) {
    if (!tripId) return;
    setPlaceBusy(true);
    try {
      await uxApi.unselectHotel(tripId, candidateId);
      await load(tripId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPlaceBusy(false);
    }
  }

  /** 移出行程（M20，对齐候选出口）：已排期地点撤销全部日程 entry，退回候选态不删除 */
  async function unschedulePlace(place: PlaceDto) {
    setPlaceBusy(true);
    try {
      await candidatesApi.unschedulePlace(place.id);
      if (tripId) await load(tripId);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPlaceBusy(false);
    }
  }

  // guest 模式（issue #18）：agent 面板对同伴不可见（服务端 chat-sessions 全家 403，#16 已挡），
  // 前端不发无谓请求，chatSessions 恒为空 → 下方 agent 面板整块不渲染（右侧让位给地图）
  const refreshSessions = useCallback(async () => {
    if (!tripId || guest) return;
    const { sessions } = await api.chatSessions(tripId);
    setChatSessions(sessions);
  }, [tripId, guest]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // 链接被吊销：优先于一切错误态展示（此时凭证已清，后续请求都会 401，裸报错没有意义）
  if (guestKicked) {
    return <GuestKickedScreen displayName={kickedNameRef.current ?? "同伴"} />;
  }
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
  const toolPanels = Object.entries(TOOL_PANEL_META) as [ToolPanel, { label: string; Icon: LucideIcon }][];
  const activeToolMeta = toolPanel != null ? TOOL_PANEL_META[toolPanel] : null;
  /** guest 模式（issue #18）：agent 面板/标题编辑/分享导出/设置入口等 owner 专属 UI 不渲染。
   *  bundle/SSE 已按 Bearer 凭证拿到真实 id，行程编辑能力（加地点/排天/预算/须知等）全量可用——
   *  本 issue 只收敛「进得来且一切正常工作」，更细的功能边界收敛在 #20。 */
  const isGuest = guest != null;

  return (
    <div className="relative h-full overflow-hidden">
      {/* 地图全屏打底 */}
      <div className="absolute inset-0">
        <MapCanvas
          bundle={bundle}
          amapJsKey={amapJsKey}
          amapJsSecret={amapJsSecret}
          visibleDayIndex={visibleDay}
          selectedPlaceId={selectedPlaceId}
          selectedLegId={selectedLegId}
          placeFocus={placeFocus}
          onSelectPlace={selectPlace}
          onOpenSettings={isGuest ? undefined : openSettings}
        />
      </div>

      {/* 顶行（M61）：左上行程信息玻璃条 + 顶部工具分段切换条；分段条在信息条与右侧 agent
          面板之间的空闲区右对齐（M62：右缘与自由区右边界对齐，容器 pointer-events-none 让出地图交互）。
          M67：容器右缘恒定 right-[404px]，不随 agent 面板收起变化——分段条（justify-end）锚在面板
          左缘位置，收起面板时不再右移 */}
      <div className="pointer-events-none absolute left-4 right-[404px] top-4 z-10 flex items-start gap-3">
      {/* shrink-0：信息条不被 flex 挤压（分段条区域 min-w-0 flex-1 先让）；标题 max-w+truncate 兜底长标题把分段条挤出可视区 */}
      <header className="glass panel-in pointer-events-auto flex shrink-0 items-center gap-2.5 rounded-2xl px-4 py-2">
        {/* 返回：guest 的去向是公开首页（行程列表是 owner-only 端点，guest 进不去也看不到） */}
        <Link
          to="/"
          className="flex size-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-slate-700"
          title={isGuest ? "返回首页" : "返回行程列表"}
        >
          ‹
        </Link>
        {/* guest 身份徽章：同伴填的昵称 + 角色，替代 owner 的标题编辑入口 */}
        {isGuest && (
          <span
            className="flex items-center gap-1 rounded-full bg-blue-500/12 px-2.5 py-0.5 text-[11px] font-medium text-blue-700"
            title={`${guest!.displayName}（${guest!.role === "editor" ? "可编辑" : "只读"}同伴）——链接即身份，凭证保存在本浏览器`}
          >
            <UsersRound className="size-3" />
            {guest!.displayName}
          </span>
        )}
        {/* 标题（issue #12）：点击进入行内编辑；Enter/✓ 保存，Esc/✕ 取消；空标题或与原标题一致不发请求 */}
        {editingTitle ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onCompositionStart={() => {
                // 新一轮组合开始时取消尚未执行的复位，避免误清标志位
                if (titleImeResetTimerRef.current !== null) {
                  clearTimeout(titleImeResetTimerRef.current);
                  titleImeResetTimerRef.current = null;
                }
                titleImeComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                // WebKit（Tauri 桌面壳 / Safari）下按 Enter 确认候选时，compositionend 先于
                // 那次 Enter 的 keydown 派发，且 keydown 的 isComposing 已为 false，
                // 单靠 nativeEvent.isComposing 拦不住，半成品标题会被误保存（issue #4 同根因）。
                // 故延迟一个宏任务复位标志位：紧随的「确认候选」Enter 仍视为组合输入被忽略；
                // 用户真正想保存的 Enter 是后续独立输入事件，届时标志位已复位，不受影响。
                titleImeResetTimerRef.current = window.setTimeout(() => {
                  titleImeComposingRef.current = false;
                  titleImeResetTimerRef.current = null;
                }, 0);
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229 &&
                  !titleImeComposingRef.current
                ) {
                  void saveTitle();
                }
                if (e.key === "Escape") setEditingTitle(false);
              }}
              disabled={titleBusy}
              maxLength={120}
              className="w-52 rounded-lg bg-white/70 px-2 py-0.5 text-sm font-semibold outline-none ring-1 ring-slate-900/15 focus:ring-blue-500 disabled:opacity-50"
            />
            <button
              onClick={() => void saveTitle()}
              disabled={titleBusy}
              title="保存"
              className="flex size-6 items-center justify-center rounded-full text-blue-600 transition-colors hover:bg-slate-900/8 disabled:opacity-50"
            >
              ✓
            </button>
            <button
              onClick={() => setEditingTitle(false)}
              disabled={titleBusy}
              title="取消"
              className="flex size-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-slate-700 disabled:opacity-50"
            >
              ✕
            </button>
          </span>
        ) : (
          <h1
            className="glass-text max-w-64 truncate rounded-lg px-1 text-sm font-semibold transition-colors"
            title={trip.title}
            {...(isGuest
              ? {}
              : {
                  onClick: () => {
                    setTitleDraft(trip.title);
                    setEditingTitle(true);
                  },
                })}
          >
            {trip.title}
          </h1>
        )}
        <span
          className="rounded-full bg-slate-900/8 px-2 py-0.5 text-[11px] font-medium text-slate-500"
          title={trip.stops.length > 1 ? `途经地（按游览顺序）：${trip.stops.map((s) => s.name).join(" → ")}` : undefined}
        >
          {/* 多城市（M39）：信息条直接展示途经地链；单城市仍是目的地名 */}
          {trip.stops.length > 1 ? trip.stops.map((s) => s.name).join(" → ") : trip.destinationCity}
        </span>
        {/* 在线名单（issue #19）：owner/guest 共用，SSE presence 事件驱动 */}
        <PresenceBar tripId={trip.id} />
        {trip.geoProvider === "osm" && !isDomesticOsmTrip(trip) && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            海外
          </span>
        )}
        {/* 国内 + 开源引擎（M113 零配置回退）：amber 区别于海外的 emerald，提示数据质量口径不同 */}
        {isDomesticOsmTrip(trip) && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            开源引擎
          </span>
        )}
        {/* 出发日期（可选）：设置后每天标签显示真实日期（D1 · 9/23 周三）；清空退回 Day N。
            防冲突（issue #19）：date input 的 value 直接绑 bundle 快照，同伴的任何写操作都会推
            新 bundle 重渲染——正在挑日期时会被外部值冲掉；useSyncedInput 在聚焦期间跳过同化 */}
        <label
          title="出发日期（可选）：设置后行程每天显示真实日期"
          className="flex items-center gap-1 rounded-full bg-slate-900/8 px-2.5 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-900/15"
        >
          <CalendarDays className="size-3" />
          <input
            type="date"
            value={startDateInput.value}
            onChange={(e) => {
              startDateInput.onChange(e);
              void updateStartDate(e.target.value || null);
            }}
            onFocus={startDateInput.onFocus}
            onBlur={startDateInput.onBlur}
            className="w-[7.2rem] cursor-pointer bg-transparent outline-none"
          />
        </label>
        <button
          onClick={() => void relocate()}
          title="重新定位到目的城市"
          className="flex size-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-blue-600"
        >
          <Crosshair className="size-3.5" />
        </button>
        {/* 分享与协作（issue #17）+ guest 边界（issue #18）：按钮打开管理面板——老只读 /share 直链
            保留在面板「只读分享」区，协作链接（/join/:token）可创建/复制/吊销；
            分享与导出是 owner 侧入口（面板含 token 明文、导出走 owner 的 Tauri 壳/打印），guest 一律不渲染 */}
        {!isGuest && (
          <>
            <button
              onClick={() => setShareOpen(true)}
              title="分享与协作：只读链接 / 协作链接管理"
              className="flex items-center gap-1 rounded-full bg-slate-900/8 px-2.5 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-900/15"
            >
              <Link2 className="size-3" />
              分享
            </button>
            {/* 导出入口（M97，issue #7）：预览弹层 → 保存为 PDF（Tauri 壳内走原生直存，浏览器回退 window.print） */}
            <button
              onClick={() => setExportOpen(true)}
              title="导出行程为 PDF（便于打印/离线查看）"
              className="flex items-center gap-1 rounded-full bg-slate-900/8 px-2.5 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-900/15"
            >
              <Printer className="size-3" />
              导出
            </button>
          </>
        )}
      </header>

      {/* 工具面板分段切换条（行程/候选/添加，M61 从原左下 dock 标签条迁来）：点击 tab 向下展开浮层，再点当前 tab 收起。
          M62：条在自由区内右对齐（justify-end），右缘与 agent 面板左缘（right-[404px]）对齐；min-w-0 flex-1 保留窄屏让位 */}
      <div className="flex min-w-0 flex-1 justify-end">
        <div className="glass panel-in pointer-events-auto flex items-center gap-1 rounded-full p-1.5">
          {toolPanels.map(([key, meta]) => (
            <button
              key={key}
              onClick={() => switchToolPanel(toolPanel === key ? null : key)}
              title={toolPanel === key ? `收起${meta.label}面板` : `展开${meta.label}面板`}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                toolPanel === key
                  ? "bg-slate-900 text-white shadow-sm"
                  : "text-slate-500 hover:bg-slate-900/5 hover:text-slate-800"
              }`}
            >
              <meta.Icon className="size-3.5" />
              {meta.label}
            </button>
          ))}
        </div>
      </div>
      </div>

      {/* 国内零配置降级横幅（M113）：osm 引擎的国内行程顶部一次性提示——数据质量低于高德，
          可关闭并全局记住；去设置页配 key 只影响之后新建的行程（引擎建行程时定死） */}
      {isDomesticOsmTrip(trip) && !osmBannerDismissed && (
        <div className="glass panel-in absolute left-4 top-16 z-10 flex max-w-md items-start gap-2 rounded-2xl px-4 py-2.5 text-xs leading-relaxed text-slate-600">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <p className="min-w-0 flex-1">
            本行程使用开源地图引擎（创建时未配置高德 Key）：POI 搜索覆盖率与公交数据质量低于高德，市内公交为估算。
            <button
              onClick={openSettings}
              className="mx-0.5 font-medium text-blue-600 underline-offset-2 hover:underline"
            >
              去设置页配置 Key
            </button>
            后，新建的国内行程会自动走高德（本行程引擎不变）。
          </p>
          <button
            aria-label="不再提示"
            title="不再提示"
            onClick={() => {
              localStorage.setItem(DOMESTIC_OSM_BANNER_KEY, "1");
              setOsmBannerDismissed(true);
            }}
            className="shrink-0 rounded-full p-0.5 text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-slate-600"
          >
            ✕
          </button>
        </div>
      )}

      {/* 左下：选中地点信息卡（M61 从左上信息条下方迁来；z-30 全页最高层级，可盖在顶部工具浮层之上）。可操作：加入行程/加入住宿/移出/删除。
          窄屏（<md ≈ 可用宽度 750px 以下）工具浮层与卡片必然交叠，卡片降到 z-10 让位给浮层（浮层 z-20 盖住卡片，不再被卡片拦截点击）；收起浮层后卡片照常可用 */}
      {selectedPlace && (
        <div className="glass panel-in rounded-card absolute bottom-4 left-4 z-30 max-h-[calc(100vh-7rem)] max-w-xs overflow-y-auto p-3.5 shadow-card max-md:z-10">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">
                {selectedPlace.name}
              </p>
            </div>
            <button
              onClick={() => selectPlace(null)}
              className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-900/8 hover:text-slate-600"
            >
              ✕
            </button>
          </div>
          {/* 状态徽章：已排期（scheduled 蓝）> 已加入（joined 金）> 候选；酒店 joined 降级不展示 joined 徽章（!isHotel 守卫，口径对齐候选），已选定住宿的酒店凭住宿块说明「已加入」；agent 建的地点带推荐标记 */}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {scheduledPlaceIds.has(selectedPlace.id) ? (
              <Badge variant="scheduled">已排期</Badge>
            ) : selectedPlace.status === "joined" && selectedHotelCand == null ? (
              <Badge variant="joined">已加入</Badge>
            ) : selectedStay ? (
              <Badge variant="joined">已加入</Badge>
            ) : (
              <Badge variant="candidate">候选</Badge>
            )}
            {selectedPlace.createdBy === "agent" && (
              <Badge variant="blue">
                <Sparkles className="size-3" />
                agent 推荐
              </Badge>
            )}
            {/* 预订状态徽章（M11）：所有 joined 地点可点选流转（含已排期，与候选一致） */}
            {selectedPlace.status === "joined" ? (
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
            formatVisitDuration(selectedPlace.visitDurationMin) ||
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
              {formatVisitDuration(selectedPlace.visitDurationMin) && (
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
          {/* 酒店住宿块：住宿区间展示/编辑 + 住宿维度的「加入住宿/移出住宿」操作（M59 从底部操作行拆上来，与日程维度的「移出日程」区分） */}
          {selectedHotelCand && (
            <div className="mt-1.5 rounded-lg bg-red-500/8 px-2 py-1.5 text-[11px] text-slate-600">
              <p className="flex items-center gap-1">
                <BedDouble className="size-3 shrink-0 text-slate-400" />
                {selectedStay ? "已加入行程的住宿" : "酒店候选（未加入住宿）"}
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
              <button
                title={
                  selectedStay
                    ? "移出住宿：取消该酒店的住宿区间，不再锚定每天首尾"
                    : "加入住宿：自动分配未覆盖的最长连续住宿段，可再调整入离店天"
                }
                disabled={placeBusy}
                onClick={() =>
                  void (selectedStay
                    ? unselectHotelStay(selectedHotelCand.id)
                    : selectHotelStay(selectedHotelCand.id))
                }
                className={`mt-1 flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  selectedStay
                    ? "bg-hotelpin/10 text-hotelpin hover:bg-hotelpin/20"
                    : "bg-slate-900/8 text-slate-600 hover:bg-slate-900/15"
                }`}
              >
                <BedDouble className="size-3" />
                {selectedStay ? "移出住宿" : "加入住宿"}
              </button>
            </div>
          )}
          {selectedPlace.notes && (
            // key 钉在 place id 上：换选中地点时展开/截断状态随之重置
            <InfoCardNotes key={selectedPlace.id} notes={selectedPlace.notes} />
          )}
          {/* 操作行（口径对齐候选）：酒店的住宿维度加入/移出已拆到上方住宿块（M59：「加入住宿/移出住宿」）；
              已排期地点给「移出」出口（unschedule 撤销日程）——酒店信息卡上为与住宿按钮区分改名「移出日程」，非酒店仍叫「移出行程」；
              未排期非酒店 POI 走 joined 开关。
              图标与候选一致：joined 态显示 CalendarMinus（点击移出），候选态显示 CalendarPlus（点击加入） */}
          <div className="mt-2.5 flex items-center gap-1.5 border-t border-slate-900/8 pt-2.5">
            {scheduledPlaceIds.has(selectedPlace.id) ? (
              <button
                title={
                  selectedHotelCand
                    ? "移出日程（撤销排入的日程，退回候选）"
                    : "移出行程（撤销排入的日程，退回候选）"
                }
                disabled={placeBusy}
                onClick={() => void unschedulePlace(selectedPlace)}
                className="flex items-center gap-1 rounded-lg bg-scheduled/10 px-2.5 py-1 text-xs font-medium text-scheduled transition-colors hover:bg-scheduled/20 disabled:opacity-50"
              >
                <CalendarMinus className="size-3" /> {selectedHotelCand ? "移出日程" : "移出行程"}
              </button>
            ) : (
              !selectedHotelCand && (
                <button
                  title={
                    selectedPlace.status === "joined"
                      ? "移出行程（退回候选，不再必排进日程）"
                      : "加入行程（确认要去，排日程时必排）"
                  }
                  disabled={placeBusy}
                  onClick={() => void togglePlaceJoined(selectedPlace)}
                  className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                    selectedPlace.status === "joined"
                      ? "bg-joined/10 text-joined hover:bg-joined/20"
                      : "bg-slate-900/8 text-slate-600 hover:bg-slate-900/15"
                  }`}
                >
                  {selectedPlace.status === "joined" ? (
                    <>
                      <CalendarMinus className="size-3" /> 移出行程
                    </>
                  ) : (
                    <>
                      <CalendarPlus className="size-3" /> 加入行程
                    </>
                  )}
                </button>
              )
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

      {/* 顶部：工具浮层（行程/候选/添加，M61 从原左下 dock 迁来）。overlay 盖在地图上、不挤占布局，
          点击分段条 tab 或浮层 ✕ 收起。容器恒为 left-4 → right-[404px]（M67：右缘不随 agent 面板收起
          变化，浮层 ml-auto 锚定的右缘保持恒定），
          两态布局在内部宽度/对齐上分流（M63 修正 M62 的误读——铺满只属于放大态）：
          两态都保持 ml-auto 右缘锚定（M66 修复：margin-left:auto 不可过渡，放大态丢失 ml-auto 会导致
          margin 瞬变、面板先跳到左缘再播宽度动画）；
          高度上两态一致（M76，取代 M62 的 52vh→80vh 拉高）：容器 items-stretch + 面板不设高度上限，
          面板纵向铺满 top-[68px] → bottom-4 自由区、底边与 agent 面板底边对齐（短视口下面板自然变矮，
          内部 min-h-0 滚动区兜底，无需 max-h），放大动画因此只发生在宽度上：
          - 普通态：固定 400px 宽、右对齐，作为下拉面板挂在分段条下方（右缘与分段条右缘/agent 面板左缘对齐）；
            shrink-0 保证自由区不足时 400px 不被挤压，max-w 100vw-2rem 兜底极窄视口不溢出
          - 放大态（panelMaximized）：w-full 铺满自由区，右缘不动、左缘扩到与左上信息条左缘（left-4）对齐；
            宽度随自由区自适应，切换标签无宽度跳动 ===== */}
      {toolPanel != null && activeToolMeta != null && (
        <div className="pointer-events-none absolute bottom-4 left-4 right-[404px] top-[68px] z-20 flex items-stretch">
        <div
          className={`glass-deep panel-in pointer-events-auto ml-auto flex flex-col overflow-hidden rounded-[22px] transition-all duration-300 ease-out ${
            panelMaximized
              ? "w-full"
              : "w-[400px] shrink-0 max-w-[calc(100vw-2rem)]"
          }`}
        >
          <div className="flex items-center gap-2 border-b border-white/40 px-4 py-2.5">
            <activeToolMeta.Icon className="size-3.5 text-slate-500" />
            <span className="glass-text ml-1 text-xs font-semibold">{activeToolMeta.label}</span>
            <button
              onClick={() => setPanelMaximized((v) => !v)}
              title={panelMaximized ? "恢复面板大小" : "放大面板"}
              className="ml-auto flex size-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-slate-600"
            >
              {panelMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </button>
            <button
              onClick={() => switchToolPanel(null)}
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
              {toolPanel === "itinerary" && (
                <ItineraryPanel
                  tripId={trip.id}
                  bundle={bundle}
                  selectedPlaceId={selectedPlaceId}
                  onSelectPlace={selectPlace}
                  onDataChanged={() => void load(trip.id)}
                  visibleDay={visibleDay}
                  onVisibleDayChange={changeVisibleDay}
                  selectedLegId={selectedLegId}
                  onSelectLeg={setSelectedLegId}
                  onFocusPlace={focusPlace}
                  onOpenCandidates={() => switchToolPanel("candidates")}
                />
              )}
              {toolPanel === "candidates" && (
                <CandidatesPanel
                  tripId={trip.id}
                  bundle={bundle}
                  selectedPlaceId={selectedPlaceId}
                  onSelectPlace={selectPlace}
                  onDataChanged={() => void load(trip.id)}
                />
              )}
              {toolPanel === "search" && (
                <SearchAddPanel tripId={trip.id} bundle={bundle} onDataChanged={() => void load(trip.id)} />
              )}
              {toolPanel === "notes" && (
                <TripNotesPanel tripId={trip.id} bundle={bundle} onDataChanged={() => void load(trip.id)} />
              )}
            </div>
          </div>
        </div>
        </div>
      )}

      {/* 右侧主面板：纯 agent 对话 ===== */}
      {/* guest 模式（issue #18）：agent 面板是 owner 专属（对话与 agent 子进程均 owner-only），
          整块不渲染——右侧空间还给地图；agent 面板的完整功能边界收敛在 #20 */}
      {!isGuest &&
        (panelMode === "hidden" ? (
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
        ))}

      {/* 动态流（issue #19）：左下角轻量动态条「谁改了什么」；地点信息卡（z-30）打开时让位隐藏 */}
      {!selectedPlace && <ActivityFeed tripId={trip.id} />}

      {/* 导出打印预览弹层（M97，portal 挂 body，打印时只留该浮层参与分页） */}
      <ExportPrintDialog bundle={bundle} open={exportOpen} onClose={() => setExportOpen(false)} />

      {/* 分享与协作面板（issue #17，portal 挂 body）：只读分享 + 协作链接多链接管理 */}
      <ShareCollabDialog
        tripId={trip.id}
        shareToken={trip.shareToken}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </div>
  );
}