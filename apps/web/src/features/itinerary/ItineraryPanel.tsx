import { useState } from "react";
import { formatDayLabel, formatDistance, formatDuration, type PlaceCategory, type TripBundle, type TransportLegDto } from "@yarnball/shared";
import { toast } from "sonner";
import { BedDouble, Bus, Car, ChevronDown, Clock, Footprints, Landmark, MapPin, Package, PlaneLanding, PlaneTakeoff, Repeat, TrainFront, UtensilsCrossed, Zap, type LucideIcon } from "lucide-react";
import { api } from "../../api/client";
import { api as libApi } from "../../lib/api";
import { DAY_COLORS } from "../map/MapCanvas";
import { buildDayTimeline, formatHHMM, type TimelineItem } from "./timeline";
import {
  TRANSIT_KIND_META,
  TRANSIT_MODE_META,
  transitFromName,
  transitKindOf,
  transitRouteText,
  transitToName,
  type TransitKind,
} from "./transit";
import { groupDaysByStop, isLoopClosed, isMultiCity } from "./stops";
import {
  isRailSegment,
  lineSegmentText,
  transitDetailOf,
  transitSegmentCountText,
  walkSegmentText,
} from "./legDetail";
import {
  conflictsWithOpeningHours,
  openingHoursOf,
  parseOpeningHoursRange,
} from "../candidates/booking";
import { getSelectedStays, stayCoveringNight, type HotelStay } from "../candidates/hotelStays";

/**
 * 行程面板：按天分组的时间轴。
 * - 每个 entry 显示时段：startTime（agent 写入）+ durationMin 推算结束；
 *   startTime 缺失时按「durationMin + 交通时长」从 09:00 起推算（~ 前缀弱化展示）
 * - 大交通 entry（M11）渲染为特殊卡片：🛬抵达 / 🛫离开 / 🚄城市间，显示 departTime–arriveTime
 *   与起讫名，可直接编辑时间（PATCH /api/entries/:id）；推算时作为硬锚点（到达日从落地时间起算）
 * - 排期时段与营业时间（openingHours，能解析出时段时）完全无交叠给弱化警告；解析不了仅展示
 * - entry 之间显示交通段（模式图标 + 时长 + 距离），可手动切换 步行/驾车（M1 leg override 端点）；
 *   点击交通段行/大交通卡在地图上只显示该段路线（M47 按需显示，再点一次取消；分享页不可点）；
 *   公交段带 M77 公交详情时主行附「· N 段」概要，可展开看步行接驳/线路分段明细（M78）
 * - 每天头部显示当晚住宿（多酒店，M10：取覆盖该天的已选定酒店）；
 *   换酒店日（M50）不再合并成一行，而是时间轴拆两条：天首「离店 · 酒店A」（时刻=离店出发，
 *   能从酒店 openingHours/notes 解析出退房时刻时附「HH:MM 前退房」提示）、天尾「入住 · 酒店B」；
 *   首=旧酒店、尾=新酒店的两条锚定段照常作为交通段行展示在离店/入住行之旁
 * - 酒店端点节点（M17）：每天首渲染「从 X 酒店出发」、尾渲染「返回 X 酒店」，
 *   数据取 legs 首/末段的 from/toPlaceId（服务端按选定酒店锚定当天首尾，M9/M11）；
 *   用酒店图标 + hotelpin 虚线卡片区别于普通 entry；出发/到店时刻随时间轴推算（~ 前缀 = 估算），
 *   首段交通时长挂在出发节点下方。大交通收口的头/尾天（机场落地/离开）服务端不锚定酒店，
 *   改渲染大交通端点节点（M20：到达日「从 机场/车站 出发」、离开日「前往 机场/车站」；
 *   M57：表达的是市内转移段，样式为轻量连接行而非航班卡；
 *   M58 去重：转移段 leg 存在时锚定行不再单独渲染，端点名与出发/到达时刻折进该段
 *   LegRow 的行内前缀，同一段路只表达一次；仅 leg 缺失（坐标不全等）时锚定行作兑底渲染）
 * - 无覆盖酒店的天（M17）：天头部显示「当晚未安排住宿」+「去候选加入」引导
 *   （onOpenCandidates 由 TripPage 传入；只读分享页只有文案没有按钮）。
 *   注意（M20 话术统一）：酒店需「加入行程」（底层 select，带 checkInDay/checkOutDay 住宿区间）才参与路线锚定
 * - Day 筛选 tabs（M15，TripPage 传入 visibleDay/onVisibleDayChange 时启用）：
 *   面板顶部「全部/Day 1/Day 2…」，选中天过滤面板并同步地图聚焦
 * - 地点节点带类别小图标（M60）：hotel=BedDouble / restaurant=UtensilsCrossed /
 *   attraction+activity=Landmark / other=Package，与候选 tab 选型一致；
 *   序号圆仍是主信息，图标为辅（序号圆后、名称前的灰色小图标）
 * - 多城市（M39，trip.stops > 1）：顶部显示途经地链「西宁 → 青海湖 → …」，末段 transit
 *   讫点回到 stops[0] 时附 🔁 环线徽标（isLoopClosed，推导不落库）；天 section 按 stop
 *   连续分组，组头「📍 途经地 · Dn-Dm」（day→stop 推导见 stops.ts）；
 *   大交通卡按 transitMode 区分图标/徽标（drive=🚗 自驾，卡片带真实里程/时长，数据取该
 *   transit 的 ride leg：legs 中 fromEntryId==toEntryId==entry.id 的那条）
 * - readOnly（分享页）：隐藏一切编辑操作
 */

/** 地点类别图标（M60）：与候选 tab / GROUP_META 选型一致（CandidatesPanel.tsx） */
const PLACE_CATEGORY_META: Record<PlaceCategory, { label: string; Icon: LucideIcon }> = {
  hotel: { label: "酒店", Icon: BedDouble },
  restaurant: { label: "美食", Icon: UtensilsCrossed },
  attraction: { label: "景点", Icon: Landmark },
  activity: { label: "景点", Icon: Landmark },
  other: { label: "其他", Icon: Package },
};

interface ItineraryPanelProps {
  tripId: string;
  bundle: TripBundle;
  selectedPlaceId: string | null;
  onSelectPlace: (placeId: string) => void;
  onDataChanged: () => void;
  /** 只读模式（分享页）：不渲染编辑按钮与交通段切换 */
  readOnly?: boolean;
  /**
   * Day 筛选 tabs（M15，仅 TripPage 传入）：面板顶部渲染「全部/Day 1/Day 2…」，
   * 选中后过滤面板只显示该天，并回传 TripPage 让地图聚焦同一天（原地图浮条的状态通道）
   */
  visibleDay?: number | null;
  onVisibleDayChange?: (dayIndex: number | null) => void;
  /** 按需显示的交通段（M47）：当前选中的 legId；点击交通段行切换，地图只画该段 */
  selectedLegId?: string | null;
  onSelectLeg?: (legId: string | null) => void;
  /** 打开候选面板（M17：无覆盖酒店天的「去候选加入」引导；TripPage 传入，分享页不传则只显示文案） */
  onOpenCandidates?: () => void;
}

export function ItineraryPanel({
  tripId,
  bundle,
  selectedPlaceId,
  onSelectPlace,
  onDataChanged,
  readOnly = false,
  visibleDay = null,
  onVisibleDayChange,
  selectedLegId = null,
  onSelectLeg,
  onOpenCandidates,
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
  /** 已选定酒店的住宿区间（多酒店，M10；含 legacy 单选定兜底） */
  const stays = getSelectedStays(bundle);
  const placeName = (placeId: string) => placeById.get(placeId)?.name ?? "酒店";

  /** 住宿行里的酒店名：点击在地图上选中该地点 */
  function renderStayName(stay: HotelStay) {
    return (
      <button
        className="font-medium text-slate-500 underline decoration-dotted underline-offset-2 hover:text-blue-600"
        onClick={() => onSelectPlace(stay.placeId)}
      >
        {placeName(stay.placeId)}
      </button>
    );
  }

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

  /** 大交通卡时间编辑（M11：PATCH /api/entries/:id，lib/api 单点）；成功后靠 SSE 全量快照刷新 + 主动拉一次兜底 */
  async function updateTransitTimes(entryId: string, departTime: string | null, arriveTime: string | null) {
    setBusy(true);
    try {
      await libApi.updateEntry(entryId, { departTime, arriveTime });
      onDataChanged();
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

  /** Day tabs（M15）：选中某天后面板只显示该天；地图聚焦由 TripPage 经 visibleDay 同通道驱动 */
  const dayTabsEnabled = onVisibleDayChange != null;
  const shownDays =
    dayTabsEnabled && visibleDay != null
      ? sortedDays.filter((d) => d.dayIndex === visibleDay)
      : sortedDays;

  /** 交通段按需显示（M47）：点击交通段行切换选中（再点一次取消）；分享页未传 onSelectLeg 时不可点 */
  const toggleLeg = onSelectLeg
    ? (legId: string) => onSelectLeg(selectedLegId === legId ? null : legId)
    : undefined;

  /** 多城市（M39）：途经地链 + 环线徽标 + 天按 stop 连续分组；单城市全部为 null/不展示 */
  const multiCity = isMultiCity(bundle);
  const loopClosed = multiCity && isLoopClosed(bundle);
  const stopGroups = groupDaysByStop(bundle, stays, shownDays);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Day 筛选 tabs（M15）：替代原地图左上浮条；选中天 = 面板过滤 + 地图聚焦。
          胶囊只放「D1」紧凑形态（M75：撤掉 M46 加的日期/星期，避免胶囊变高占空间），
          日期+星期保留在下方每天明细区头部（formatDayLabel 徽章） */}
      {dayTabsEnabled && sortedDays.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 border-b border-slate-900/8 bg-white/80 px-3 py-2 backdrop-blur-sm">
          <button
            onClick={() => onVisibleDayChange(null)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              visibleDay == null
                ? "bg-slate-900/85 text-white"
                : "bg-slate-900/6 text-slate-500 hover:bg-slate-900/12 hover:text-slate-700"
            }`}
          >
            全部
          </button>
          {sortedDays.map((d) => {
            const color = DAY_COLORS[(d.dayIndex - 1) % DAY_COLORS.length];
            const active = visibleDay === d.dayIndex;
            return (
              <button
                key={d.id}
                onClick={() => onVisibleDayChange(active ? null : d.dayIndex)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  active ? "text-white" : "bg-slate-900/6 hover:bg-slate-900/12"
                }`}
                style={active ? { background: color } : { color }}
              >
                D{d.dayIndex}
              </button>
            );
          })}
        </div>
      )}
      {sortedDays.length === 0 && (
        <div className="p-6 text-center text-sm text-slate-400">
          还没有行程。让 agent 帮你排，或在「添加」里手动加地点。
        </div>
      )}
      {/* 多城市途经地链（M39）：「西宁 → 青海湖 → …」；末段 transit 讫点回到首站时附 🔁 环线徽标 */}
      {multiCity && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-slate-900/8 bg-white/50 px-3 py-1.5 text-[11px] text-slate-500">
          <MapPin className="size-3 shrink-0 text-slate-400" />
          {bundle.trip.stops.map((s, i) => (
            <span key={`${s.name}-${i}`} className="flex items-center gap-1">
              {i > 0 && <span className="text-slate-300">→</span>}
              <span className="font-medium text-slate-600">{s.name}</span>
            </span>
          ))}
          {loopClosed && (
            <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-emerald-500/12 px-1.5 py-0.5 font-medium text-emerald-700">
              <Repeat className="size-3" />
              环线已闭合
            </span>
          )}
        </div>
      )}
      {/* stop 分组只合并连续同 stop 的天，环线回到起点城市会产生同名分组——key 必须带 index（评审 R1 P2） */}
      {(stopGroups ?? [{ stopName: null, days: shownDays }]).map((group, groupIdx) => (
      <div key={`${group.stopName ?? "stop-unknown"}-${groupIdx}`}>
      {/* stop 分组头（M39）：连续同 stop 的天并成一组；推导不出归属的组不显示头 */}
      {group.stopName != null && (
        <header className="flex items-center gap-1.5 border-b border-slate-900/8 bg-slate-900/4 px-3 py-1.5 text-xs font-semibold text-slate-600">
          <MapPin className="size-3.5 shrink-0 text-slate-400" />
          {group.stopName}
          <span className="font-normal text-slate-400">
            · D{group.days[0].dayIndex}
            {group.days.length > 1 ? `–D${group.days[group.days.length - 1].dayIndex}` : ""}
          </span>
        </header>
      )}
      {group.days.map((day) => {
        const color = DAY_COLORS[(day.dayIndex - 1) % DAY_COLORS.length];
        const entries = dayEntries.get(day.id) ?? [];
        const timeline = buildDayTimeline(entries, placeById, legAfter);
        // 地点计数只数 place entry，大交通节点不算「地点」
        const placeCount = timeline.filter((t) => !t.transit).length;
        // 时间轴序号同理：只给 place entry 编号，大交通卡不占号
        const seqByEntryId = new Map<string, number>();
        let seq = 0;
        for (const t of timeline) if (!t.transit) seqByEntryId.set(t.entry.id, ++seq);
        // 当晚住宿（多酒店，M10）：覆盖该天的已选定酒店；与前一晚不同 = 换酒店日
        const nightStay = stayCoveringNight(stays, day.dayIndex);
        const prevNightStay = day.dayIndex > 1 ? stayCoveringNight(stays, day.dayIndex - 1) : null;
        const switchFrom =
          prevNightStay && prevNightStay.candidateId !== nightStay?.candidateId
            ? prevNightStay
            : null;
        // 酒店端点锚定段（M17）：首段 fromPlaceId 指向酒店（酒店→首 entry），末段 toPlaceId 指向酒店
        // （末 entry→酒店）；换酒店日首=旧酒店、尾=新酒店。无选定酒店覆盖的天没有这两段
        const dayLegs = bundle.legs
          .filter((l) => l.dayId === day.id)
          .sort((a, b) => a.seq - b.seq);
        const startLeg = dayLegs.find((l) => l.fromPlaceId != null) ?? null;
        const endLeg = [...dayLegs].reverse().find((l) => l.toPlaceId != null) ?? null;
        // 大交通端点锚定（M20 追加）：首/末 entry 为带坐标 transit（到达/离开）时服务端 recalcDayLegs
        // 已跳过酒店锚点，面板对应展示「从 机场/车站 出发」/「前往 机场/车站」端点信息
        // （M58：折进转移段 LegRow 的前缀，无 leg 时兑底为独立锚定行）；
        // 仅一个 entry 的纯移动天不重复渲染（transit 卡本身已足够）
        const startTransitItem =
          startLeg == null && timeline.length > 1 && timeline[0]?.transit ? timeline[0] : null;
        const endTransitItem =
          endLeg == null && timeline.length > 1 && timeline[timeline.length - 1]?.transit
            ? timeline[timeline.length - 1]
            : null;
        return (
          <section key={day.id} className="border-b border-slate-900/8 p-3">
            {/* 明细区头部：日期+星期只在这里展示（M75 从上方筛选胶囊撤下）；
                无 startDate 时徽章退化为「Day N」，日期由右侧灰字 day.date 兜底 */}
            <header className="mb-2 flex items-center gap-2">
              <span
                className="rounded px-2 py-0.5 text-xs font-semibold text-white"
                style={{ background: color }}
              >
                {formatDayLabel(bundle.trip.startDate, day.dayIndex)}
              </span>
              <span className="text-xs text-slate-400">
                {placeCount} 个地点
                {day.date && !bundle.trip.startDate ? ` · ${day.date}` : ""}
                {timeline.length > 0 &&
                  ` · ${timeline[0].estimated ? "~" : ""}${formatHHMM(timeline[0].startMin)} 起`}
              </span>
              {!readOnly && entries.length >= 3 && (
                <button
                  onClick={() => suggestOrder(day.dayIndex)}
                  disabled={busy}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-slate-300/60 bg-white/60 px-2 py-0.5 text-xs text-slate-600 hover:bg-white disabled:opacity-50"
                >
                  <Zap className="size-3 shrink-0" />
                  优化顺序
                </button>
              )}
            </header>

            {/* 住宿行（M50）：只看当晚覆盖——有则「当晚住宿：X」，无则「当晚未安排住宿」+引导；
                换酒店日的「离店 旧酒店 / 入住 新酒店」已拆进时间轴首尾的酒店节点行，不在此行合并展示。
                离店日（当晚无覆盖但前一晚有酒店）不附锚定说明——酒店在行程里，只是今晚不住 */}
            <p className="mb-1.5 flex items-center gap-1 text-[11px] text-slate-400">
              <BedDouble className="size-3 shrink-0" />
              {nightStay ? (
                <span>当晚住宿：{renderStayName(nightStay)}</span>
              ) : (
                <span>
                  当晚未安排住宿
                  {!switchFrom && (
                    <span className="text-slate-300">
                      （酒店需加入行程并设置入离店天，才会锚定当天首尾）
                    </span>
                  )}
                </span>
              )}
              {!nightStay && !readOnly && onOpenCandidates && (
                <SelectHotelGuide onClick={onOpenCandidates} />
              )}
            </p>

            <ol className="space-y-0">
              {entries.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-slate-400">
                  {nightStay
                    ? `当天暂无行程（当晚住宿：${placeName(nightStay.placeId)}）`
                    : "当天暂无行程"}
                </li>
              )}
              {/* 天首酒店节点（M17；M50 换酒店日改渲染「离店 · 旧酒店」并附退房提示）：
                  首段 leg（酒店→首 entry）存在时带时刻（= 首站开始 - 首段时长）与其交通段行；
                  换酒店日即使无锚定段（当天无 entry / 大交通收口）也渲染离店行，保证拆分信息不丢 */}
              {(startLeg?.fromPlaceId != null || switchFrom) && (
                <li>
                  <HotelAnchorRow
                    kind={switchFrom ? "checkout" : "depart"}
                    name={placeName(startLeg?.fromPlaceId ?? switchFrom!.placeId)}
                    hint={switchFrom ? checkoutTimeHint(placeById.get(switchFrom.placeId)) : null}
                    timeMin={
                      startLeg != null && timeline.length > 0
                        ? timeline[0].startMin - Math.round((startLeg.durationS ?? 0) / 60)
                        : null
                    }
                    estimated={timeline[0]?.estimated ?? true}
                    onSelect={() => onSelectPlace(startLeg?.fromPlaceId ?? switchFrom!.placeId)}
                  />
                  {startLeg && (
                    <LegRow
                      leg={startLeg}
                      toHotel={false}
                      readOnly={readOnly}
                      busy={busy}
                      onOverride={overrideMode}
                      selected={selectedLegId === startLeg.id}
                      onToggle={toggleLeg ? () => toggleLeg(startLeg.id) : undefined}
                    />
                  )}
                </li>
              )}
              {timeline.map((item, i) => {
                const { entry, place, transit, startMin, endMin, estimated } = item;
                const leg = legAfter.get(entry.id);
                const toHotel = leg != null && leg.toPlaceId != null;
                const selected = place != null && place.id === selectedPlaceId;
                // 类别小图标（M60）：hotel=BedDouble / restaurant=UtensilsCrossed / attraction+activity=Landmark / other=Package
                const categoryMeta = place ? PLACE_CATEGORY_META[place.category] : null;
                const hours = place ? openingHoursOf(place) : null;
                const hoursRange = hours ? parseOpeningHoursRange(hours) : null;
                // 排期时段与营业时段完全无交叠 = 明显冲突（解析不出时段时不告警，仅展示）
                const hoursConflict =
                  !transit && hoursRange != null && conflictsWithOpeningHours(hoursRange, startMin, endMin);
                // 序号只数 place entry（大交通卡不占地点序号）；类别按 所处天/总天数 推断（首日=抵达，末日=离开）
                const kind = transit
                  ? (transitKindOf(entry, day.dayIndex, sortedDays.length) ?? "intercity")
                  : null;
                // 大交通段本身（from→to 同一 entry 的那条 leg）：自驾卡展示真实里程/时长用；M47 点击卡片在地图上只显示该段
                const rideLeg =
                  dayLegs.find((l) => l.fromEntryId === entry.id && l.toEntryId === entry.id) ?? null;
                // 离开日驶入该 transit 的市内转移段（末站→机场/车站）：M58 后仅用于判断锚定行是否兑底渲染
                const legBefore =
                  dayLegs.find((l) => l.toEntryId === entry.id && l.fromEntryId !== entry.id) ?? null;
                // M58 去重：转移段存在时，端点锚定行（「从 X 出发」/「前往 X」）不再单独渲染，
                // 端点名 + 出发/到达时刻折成对应 LegRow 的行内前缀，同一段路只表达一次
                const startAnchorPrefix =
                  kind != null && startTransitItem != null && i === 0 && leg != null
                    ? `从 ${transitToName(entry, placeById) ?? "目的地"} 出发 ${
                        (timeline[1]?.estimated ?? true) ? "~" : ""
                      }${formatHHMM(timeline[1].startMin - Math.round((leg.durationS ?? 0) / 60))}`
                    : null;
                const endAnchorPrefix =
                  endTransitItem != null &&
                  leg != null &&
                  leg.toEntryId === endTransitItem.entry.id &&
                  leg.fromEntryId !== endTransitItem.entry.id
                    ? `前往 ${transitFromName(endTransitItem.entry, placeById) ?? "出发地"} ~${formatHHMM(endTransitItem.startMin)} 到达`
                    : null;
                return (
                  <li key={entry.id}>
                    {/* 离开日大交通端点（M20；M58 去重）：末 entry 为 transit 离开时渲染「前往 机场/车站」，
                        到达车站时刻 ≈ transit 的 departTime（startMin），恒按估算渲染（~ 前缀）；
                        驶入转移段（legBefore）存在时不渲染本行，端点名与时刻已折进前序 LegRow 前缀，
                        仅 leg 缺失（坐标不全等）时本行作兑底保住端点语义 */}
                    {kind && endTransitItem != null && i === timeline.length - 1 && legBefore == null && (
                      <TransitAnchorRow
                        direction="return"
                        kind={kind}
                        name={transitFromName(entry, placeById) ?? "出发地"}
                        timeMin={startMin}
                        estimated
                        onSelect={
                          entry.fromPlaceId ? () => onSelectPlace(entry.fromPlaceId!) : undefined
                        }
                      />
                    )}
                    {kind ? (
                      <TransitRow
                        key={`${entry.id}:${entry.departTime ?? ""}:${entry.arriveTime ?? ""}`}
                        item={item}
                        kind={kind}
                        route={transitRouteText(entry, placeById) ?? place?.name ?? "大交通"}
                        rideLeg={rideLeg}
                        selected={selected}
                        legSelected={rideLeg != null && selectedLegId === rideLeg.id}
                        readOnly={readOnly}
                        busy={busy}
                        isFirst={i === 0}
                        isLast={i === timeline.length - 1}
                        onSelect={() => place && onSelectPlace(place.id)}
                        onToggleLeg={
                          rideLeg != null && toggleLeg ? () => toggleLeg(rideLeg.id) : undefined
                        }
                        onMove={(pos) => void move(entry.id, day.dayIndex, pos)}
                        onRemove={() => void removeEntry(entry.id)}
                        onSaveTimes={updateTransitTimes}
                      />
                    ) : (
                    <div
                      className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 ${
                        selected ? "bg-brand/10 ring-1 ring-brand/40" : "hover:bg-slate-50"
                      }`}
                      onClick={() => place && onSelectPlace(place.id)}
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
                        {seqByEntryId.get(entry.id)}
                      </span>
                      {/* 类别小图标（M60）：序号圆为主信息，图标为辅 */}
                      {categoryMeta && (
                        <categoryMeta.Icon
                          className="size-3.5 shrink-0 text-slate-400"
                          aria-label={categoryMeta.label}
                        />
                      )}
                      <span className="flex-1 truncate text-sm">
                        {place?.name ?? "（地点已删除）"}
                        {place?.durationMin ? (
                          <span className="ml-1 text-xs text-slate-400">约{place.durationMin}分钟</span>
                        ) : null}
                        {hours && (
                          <span
                            className={`ml-1 inline-flex items-center gap-0.5 text-[11px] ${
                              hoursConflict ? "text-amber-600" : "text-slate-300"
                            }`}
                            title={`营业时间：${hours}`}
                          >
                            <Clock className="size-3" />
                            {hoursConflict ? "可能在营业时间外" : null}
                          </span>
                        )}
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
                    )}
                    {/* 到达日大交通端点（M20；M58 去重）：首 entry 为 transit 到达时渲染「从 机场/车站 出发」，
                        时刻 = 下一站开始 - 交通时长；其后转移段 leg 存在时不渲染本行，端点名与时刻
                        已折进该 LegRow 的前缀（startAnchorPrefix），仅 leg 缺失时本行作兑底 */}
                    {kind && startTransitItem != null && i === 0 && leg == null && (
                      <TransitAnchorRow
                        direction="depart"
                        kind={kind}
                        name={transitToName(entry, placeById) ?? "目的地"}
                        timeMin={
                          timeline.length > 1
                            ? timeline[1].startMin
                            : endMin
                        }
                        estimated={timeline[1]?.estimated ?? true}
                        onSelect={
                          entry.toPlaceId ? () => onSelectPlace(entry.toPlaceId!) : undefined
                        }
                      />
                    )}
                    {leg && (
                      <LegRow
                        leg={leg}
                        toHotel={toHotel}
                        readOnly={readOnly}
                        busy={busy}
                        onOverride={overrideMode}
                        selected={selectedLegId === leg.id}
                        onToggle={toggleLeg ? () => toggleLeg(leg.id) : undefined}
                        prefix={startAnchorPrefix ?? endAnchorPrefix}
                      />
                    )}
                  </li>
                );
              })}
              {/* 天尾酒店节点（M17；M50 换酒店日改渲染「入住 · 新酒店」）：末段 leg（末 entry→酒店）
                  的时长在其上方 LegRow 展示，时刻 = 末站结束 + 末段时长；
                  换酒店日无锚定段（当天无 entry / 大交通收口）时也渲染入住行 */}
              {(endLeg?.toPlaceId != null || (switchFrom && nightStay)) && (
                <li>
                  <HotelAnchorRow
                    kind={switchFrom && nightStay ? "checkin" : "return"}
                    name={placeName(endLeg?.toPlaceId ?? nightStay!.placeId)}
                    timeMin={
                      endLeg != null && timeline.length > 0
                        ? timeline[timeline.length - 1].endMin +
                          Math.round((endLeg.durationS ?? 0) / 60)
                        : null
                    }
                    estimated={timeline[timeline.length - 1]?.estimated ?? true}
                    onSelect={() => onSelectPlace(endLeg?.toPlaceId ?? nightStay!.placeId)}
                  />
                </li>
              )}
            </ol>
          </section>
        );
      })}
      </div>
      ))}
    </div>
  );
}

/** 大交通卡（M11）：🛬抵达 / 🛫离开 / 🚄城市间，显示 departTime–arriveTime 与起讫名；非只读可直接编辑时间。
 *  M39：transitMode 非空时图标/徽标按方式区分（🚗 自驾 / 🚄 火车 / ✈ 飞机 / 🚌 大巴）；
 *  自驾段（transitMode=drive）卡片内嵌真实里程/时长（ride leg，服务端走真实路由计算）。
 *  M47：有 rideLeg 且面板支持段选时，点击卡片切换「地图上只显示该段路线」（再点一次取消），优先于选中地点 */
function TransitRow({
  item,
  kind,
  route,
  rideLeg,
  selected,
  legSelected = false,
  readOnly,
  busy,
  isFirst,
  isLast,
  onSelect,
  onToggleLeg,
  onMove,
  onRemove,
  onSaveTimes,
}: {
  item: TimelineItem;
  kind: TransitKind;
  route: string;
  /** 大交通段本身的 leg（fromEntryId==toEntryId==entry.id）；起讫纯文本时可能不存在 */
  rideLeg: TransportLegDto | null;
  selected: boolean;
  /** 该卡对应大交通段正在地图上单独显示（M47） */
  legSelected?: boolean;
  readOnly: boolean;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
  /** 切换大交通段的地图单独显示（M47，有 rideLeg 且面板支持时传入）；传入后点击优先走它而非 onSelect */
  onToggleLeg?: () => void;
  onMove: (position: number) => void;
  onRemove: () => void;
  onSaveTimes: (entryId: string, departTime: string | null, arriveTime: string | null) => Promise<void>;
}) {
  const { entry, place, startMin, endMin, estimated } = item;
  const mode = entry.transitMode;
  const Icon =
    mode === "drive"
      ? Car
      : mode === "bus"
        ? Bus
        : mode === "train"
          ? TrainFront
          : kind === "arrival"
            ? PlaneLanding
            : kind === "departure"
              ? PlaneTakeoff
              : TrainFront;
  // 本地编辑态：失焦/回车提交；SSE 刷新后由父级按 entry.id+时间 重置 key 重挂载
  const [depart, setDepart] = useState(entry.departTime ?? "");
  const [arrive, setArrive] = useState(entry.arriveTime ?? "");

  function commit() {
    const nextDepart = depart || null;
    const nextArrive = arrive || null;
    if (nextDepart === entry.departTime && nextArrive === entry.arriveTime) {
      return;
    }
    void onSaveTimes(entry.id, nextDepart, nextArrive);
  }

  return (
    <div
      className={`group flex items-center gap-2 rounded-lg border border-dashed px-2 py-1.5 ${
        selected || legSelected
          ? "border-brand/50 bg-brand/10 ring-1 ring-brand/40"
          : "border-slate-300/70 bg-slate-500/5 hover:bg-slate-500/10"
      } ${place || onToggleLeg ? "cursor-pointer" : ""}`}
      onClick={onToggleLeg ?? onSelect}
      title={onToggleLeg ? (legSelected ? "点击取消，地图恢复不显示交通段" : "点击在地图上只显示该段路线") : undefined}
    >
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-700 text-white"
        title={`${TRANSIT_KIND_META[kind].label}${mode ? ` · ${TRANSIT_MODE_META[mode].label}` : ""}`}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm">
          <span className="truncate font-medium text-slate-800">{route}</span>
          {mode != null && (
            <span className="shrink-0 rounded bg-slate-900/8 px-1 text-[10px] text-slate-500">
              {TRANSIT_MODE_META[mode].label}
            </span>
          )}
          <span className="shrink-0 rounded bg-slate-900/8 px-1 text-[10px] text-slate-500">
            {TRANSIT_KIND_META[kind].label}
          </span>
        </span>
        {/* 自驾卡（M39）：真实里程/时长来自 ride leg（服务端 transitMode=drive 走真实路由计算） */}
        {mode === "drive" && rideLeg && (
          <span className="mt-0.5 block text-[11px] text-slate-400">
            {rideLeg.distanceM != null ? formatDistance(rideLeg.distanceM) : ""}
            {rideLeg.distanceM != null && rideLeg.durationS != null ? " · " : ""}
            {rideLeg.durationS != null ? formatDuration(rideLeg.durationS) : ""}
            {rideLeg.distanceM == null && rideLeg.durationS == null ? "里程/时长待路由计算" : ""}
          </span>
        )}
        {/* 时刻：只读展示 HH:MM – HH:MM；可编辑时两个 time 输入，失焦提交 */}
        {readOnly ? (
          <span className={`text-[11px] tabular-nums ${estimated ? "text-slate-300" : "text-slate-500"}`}>
            {estimated ? "~" : ""}
            {formatHHMM(startMin)} – {formatHHMM(endMin)}
          </span>
        ) : (
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500" onClick={(e) => e.stopPropagation()}>
            <input
              type="time"
              value={depart}
              disabled={busy}
              onChange={(e) => setDepart(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="w-[76px] rounded border border-slate-300/60 bg-white/70 px-1 py-0.5 tabular-nums disabled:opacity-50"
            />
            –
            <input
              type="time"
              value={arrive}
              disabled={busy}
              onChange={(e) => setArrive(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="w-[76px] rounded border border-slate-300/60 bg-white/70 px-1 py-0.5 tabular-nums disabled:opacity-50"
            />
          </span>
        )}
      </span>
      {!readOnly && (
        <span className="hidden shrink-0 gap-1 group-hover:flex">
          <button
            title="上移"
            disabled={busy || isFirst}
            onClick={(e) => {
              e.stopPropagation();
              onMove(entry.position - 1);
            }}
            className="rounded px-1 text-xs text-slate-400 hover:bg-white/80 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            title="下移"
            disabled={busy || isLast}
            onClick={(e) => {
              e.stopPropagation();
              onMove(entry.position + 1);
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
              onRemove();
            }}
            className="rounded px-1 text-xs text-slate-400 hover:bg-red-100/80 hover:text-red-500 disabled:opacity-30"
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

/** 交通段行：图标 + 时长 + 距离；非只读时可切换 步行/驾车（覆盖后不被自动重算冲掉）。
 *  返回酒店段（toHotel）的「返回 X 酒店」由 M17 的酒店端点节点承载，这里只保留交通信息且不提供覆盖切换。
 *  M58：大交通端点的市内转移段（transit→首站 / 末站→transit）不再单独渲染锚定行，
 *  端点名与出发/到达时刻以 prefix 折进本行行首（如「从 悉尼机场 出发 ~10:00 ·」）。
 *  M47：传入 onToggle 时整行可点击——点击后地图上只显示该段路线，再点一次取消；选中态用品牌色环提示。
 *  M78：公交段（mode=transit）带 M77 公交详情时，主行追加「· N 段」概要 + 展开把手，
 *  展开后按序列出步行接驳/线路乘坐分段明细；无详情（osm 估算、旧数据）回退原有展示 */
function LegRow({
  leg,
  toHotel,
  readOnly,
  busy,
  onOverride,
  selected = false,
  onToggle,
  prefix = null,
}: {
  leg: TransportLegDto;
  toHotel: boolean;
  readOnly: boolean;
  busy: boolean;
  onOverride: (legId: string, mode: "walk" | "drive" | null) => Promise<void>;
  /** 该段正在地图上单独显示（M47） */
  selected?: boolean;
  /** 点击切换该段的地图单独显示（M47；分享页不传则不可点） */
  onToggle?: () => void;
  /** 行内前缀（M58）：大交通端点锚定信息折入，如「从 X 出发 ~HH:MM」/「前往 X ~HH:MM 到达」 */
  prefix?: string | null;
}) {
  // modeOverride 非空 = 人工覆盖过（M1），自动重算不会冲掉；可点击徽标恢复自动
  const overridden = leg.modeOverride != null;
  // M78：公交详情仅对 transit 段生效；无详情（osm 估算/旧数据）时 detail=null，整行维持原样
  const detail = leg.mode === "transit" ? transitDetailOf(leg) : null;
  const [detailExpanded, setDetailExpanded] = useState(false);
  return (
    <div>
      <div
        className={`group/leg flex items-center gap-1 rounded py-0.5 pl-9 text-[11px] ${
          selected
            ? "bg-brand/10 text-brand ring-1 ring-brand/40"
            : onToggle
              ? "cursor-pointer text-slate-400 hover:bg-slate-900/6 hover:text-slate-600"
              : "text-slate-400"
        }`}
        onClick={onToggle}
        title={onToggle ? (selected ? "点击取消，地图恢复不显示交通段" : "点击在地图上只显示该段路线") : undefined}
      >
        <TransportIcon mode={leg.mode} />
        {prefix != null && <span className="min-w-0 truncate">{prefix}</span>}
        <span className="shrink-0">
          {prefix != null ? "· " : ""}
          {formatDuration(leg.durationS)}
          {leg.distanceM != null ? ` · ${formatDistance(leg.distanceM)}` : ""}
          {detail != null ? ` ${transitSegmentCountText(detail)}` : ""}
        </span>
        {detail != null && (
          <button
            title={detailExpanded ? "收起公交分段明细" : "展开公交分段明细"}
            aria-expanded={detailExpanded}
            onClick={(e) => {
              e.stopPropagation();
              setDetailExpanded((v) => !v);
            }}
            className="rounded p-0.5 text-slate-300 hover:bg-white/80 hover:text-slate-500"
          >
            <ChevronDown
              className={`size-3 transition-transform ${detailExpanded ? "rotate-180" : ""}`}
            />
          </button>
        )}
        {overridden &&
          (readOnly || toHotel ? (
            <span className="rounded bg-slate-900/8 px-1 text-[10px] text-slate-500">手动</span>
          ) : (
            <button
              title="恢复自动计算"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void onOverride(leg.id, null);
              }}
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
                onClick={(e) => {
                  e.stopPropagation();
                  void onOverride(leg.id, mode);
                }}
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
      {detail != null && detailExpanded && (
        <ol className="ml-9 space-y-0.5 border-l border-slate-900/10 py-1 pl-3 text-[11px] text-slate-400">
          {detail.segments.map((seg, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {seg.kind === "walk" ? (
                <>
                  <Footprints className="size-3 shrink-0 text-slate-300" />
                  <span className="min-w-0 truncate">{walkSegmentText(seg)}</span>
                </>
              ) : (
                <>
                  {isRailSegment(seg) ? (
                    <TrainFront className="size-3 shrink-0 text-slate-300" />
                  ) : (
                    <Bus className="size-3 shrink-0 text-slate-300" />
                  )}
                  <span className="min-w-0 truncate">
                    <span className="text-slate-500">{lineSegmentText(seg)}</span>
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 酒店端点节点（M17）：每天首「从 X 酒店出发」/ 尾「返回 X 酒店」，点击在地图上选中酒店；
 *  M50 换酒店日拆分为天首「离店 · 旧酒店」（hint 附「HH:MM 前退房」，数据来自酒店
 *  openingHours/notes 的退房时刻文本）与天尾「入住 · 新酒店」。
 *  hotelpin 红 + 虚线卡片区别于普通 entry 与大交通卡；时刻 ~ 前缀 = 随时间轴推算的估算值 */
function HotelAnchorRow({
  kind,
  name,
  hint = null,
  timeMin,
  estimated,
  onSelect,
}: {
  kind: "depart" | "return" | "checkout" | "checkin";
  name: string;
  /** 辅助提示（M50 离店行的「HH:MM 前退房」），无数据时不传 */
  hint?: string | null;
  timeMin: number | null;
  estimated: boolean;
  onSelect: () => void;
}) {
  const isDepart = kind === "depart" || kind === "checkout";
  const label =
    kind === "depart"
      ? "从 "
      : kind === "return"
        ? "返回 "
        : kind === "checkout"
          ? "离店 · "
          : "入住 · ";
  return (
    <div
      className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-hotelpin/40 bg-hotelpin/8 px-2 py-1.5 transition-colors hover:bg-hotelpin/15"
      onClick={onSelect}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hotelpin text-white">
        <BedDouble className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline text-sm font-medium text-slate-700">
        <span className="shrink-0">{label}</span>
        <span className="truncate">{name}</span>
        {kind === "depart" ? <span className="shrink-0"> 出发</span> : null}
        {hint && (
          <span className="ml-1.5 shrink-0 text-[11px] font-normal text-slate-400">{hint}</span>
        )}
      </span>
      {timeMin != null && (
        <span
          className={`shrink-0 text-[11px] tabular-nums ${estimated ? "text-slate-300" : "text-slate-500"}`}
          title={estimated ? "按停留时长与交通时间推算" : undefined}
        >
          {estimated ? "~" : ""}
          {formatHHMM(timeMin)}
          {isDepart ? " 出发" : " 到店"}
        </span>
      )}
    </div>
  );
}

/** 换酒店日离店行的退房提示（M50）：从酒店 openingHours/notes 自由文本解析退房时刻
 *  （如「12:00 前退房」「退房时间：14:00」「14:00退房」），解析不出就不显示 */
function checkoutTimeHint(place: TripBundle["places"][number] | undefined): string | null {
  if (!place) return null;
  const text = `${place.openingHours ?? ""} ${place.notes ?? ""}`;
  const m =
    /(\d{1,2}[:：]\d{2})\s*前?退房/.exec(text) ??
    /退房(?:时间)?\s*(?:为|是|在|[:：])?\s*(\d{1,2}[:：]\d{2})/.exec(text);
  return m ? `${m[1].replace("：", ":")} 前退房` : null;
}

/** 大交通端点节点（M20 追加；M58 起仅作无 leg 兑底）：到达日首「从 机场/车站 出发」、
 *  离开日尾「前往 机场/车站」，对应服务端 recalcDayLegs 对首/末 transit 天跳过酒店锚点的行为；
 *  时刻 ~ 前缀 = 随时间轴推算的估算值；起讫引用行程内 place 时点击在地图上选中该地点。
 *  M58：对应的市内转移段 leg 存在时不再渲染本行——端点名与出发/到达时刻折进该段 LegRow 的
 *  行内前缀，同一段路只表达一次；仅在 leg 缺失（坐标不全等）时渲染本行保住端点语义。
 *  M57 的轻量连接行样式保留（无深色实心圆、无虚线卡片），图标退回按大交通类别 */
function TransitAnchorRow({
  direction,
  kind,
  name,
  timeMin,
  estimated,
  onSelect,
}: {
  direction: "depart" | "return";
  kind: TransitKind;
  name: string;
  timeMin: number | null;
  estimated: boolean;
  onSelect?: () => void;
}) {
  const Icon =
    kind === "arrival" ? PlaneLanding : kind === "departure" ? PlaneTakeoff : TrainFront;
  return (
    <div
      className={`flex items-center gap-2 py-1 pl-2 transition-colors ${
        onSelect ? "cursor-pointer hover:bg-slate-900/4 rounded" : ""
      }`}
      onClick={onSelect}
    >
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900/6 text-slate-400"
        title={TRANSIT_KIND_META[kind].label}
      >
        <Icon className="size-3" />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline text-xs text-slate-500">
        <span className="shrink-0">{direction === "depart" ? "从 " : "前往 "}</span>
        <span className="truncate">{name}</span>
        {direction === "depart" ? <span className="shrink-0"> 出发</span> : null}
      </span>
      {timeMin != null && (
        <span
          className={`shrink-0 text-[11px] tabular-nums ${estimated ? "text-slate-300" : "text-slate-500"}`}
          title={estimated ? "按停留时长与交通时间推算" : undefined}
        >
          {estimated ? "~" : ""}
          {formatHHMM(timeMin)}
          {direction === "depart" ? " 出发" : " 到达"}
        </span>
      )}
    </div>
  );
}

/** 「去候选加入」引导钮（M17；M20 话术统一）：酒店「加入行程」（带入住/离店天）后才参与首尾锚定 */
function SelectHotelGuide({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="酒店「加入行程」（带入住/离店天）后才会作为当天行程的首尾锚点；仅放进候选还不够"
      className="shrink-0 whitespace-nowrap rounded bg-slate-900/8 px-1.5 py-0.5 text-slate-500 transition-colors hover:bg-slate-900/15 hover:text-slate-700"
    >
      去候选加入 →
    </button>
  );
}

function TransportIcon({ mode }: { mode: string }) {
  if (mode === "walk") return <Footprints className="size-3 shrink-0 text-slate-400" />;
  if (mode === "transit") return <Bus className="size-3 shrink-0 text-slate-400" />;
  return <Car className="size-3 shrink-0 text-slate-400" />;
}
