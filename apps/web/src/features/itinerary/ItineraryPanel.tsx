import { useState } from "react";
import { formatDistance, formatDuration, type TripBundle, type TransportLegDto } from "@yarnball/shared";
import { toast } from "sonner";
import { BedDouble, Bus, Car, Clock, Footprints, PlaneLanding, PlaneTakeoff, TrainFront, Zap } from "lucide-react";
import { api } from "../../api/client";
import { api as libApi } from "../../lib/api";
import { DAY_COLORS } from "../map/MapCanvas";
import { buildDayTimeline, formatHHMM, type TimelineItem } from "./timeline";
import {
  TRANSIT_KIND_META,
  transitFromName,
  transitKindOf,
  transitRouteText,
  transitToName,
  type TransitKind,
} from "./transit";
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
 * - entry 之间显示交通段（模式图标 + 时长 + 距离），可手动切换 步行/驾车（M1 leg override 端点）
 * - 每天头部显示当晚住宿（多酒店，M10：取覆盖该天的已选定酒店）；
 *   换酒店日显示「离店 A → 入住 B」提示
 * - 酒店端点节点（M17）：每天首渲染「从 X 酒店出发」、尾渲染「返回 X 酒店」，
 *   数据取 legs 首/末段的 from/toPlaceId（服务端按选定酒店锚定当天首尾，M9/M11）；
 *   用酒店图标 + hotelpin 虚线卡片区别于普通 entry；出发/到店时刻随时间轴推算（~ 前缀 = 估算），
 *   首段交通时长挂在出发节点下方。大交通收口的头/尾天（机场落地/离开）服务端不锚定酒店，
 *   改渲染大交通端点节点（M20：到达日「从 机场/车站 出发」、离开日「前往 机场/车站」）
 * - 无覆盖酒店的天（M17）：天头部显示「当晚未安排住宿」+「去候选池加入」引导
 *   （onOpenCandidates 由 TripPage 传入；只读分享页只有文案没有按钮）。
 *   注意（M20 话术统一）：酒店需「加入行程」（底层 select，带 checkInDay/checkOutDay 住宿区间）才参与路线锚定
 * - Day 筛选 tabs（M15，TripPage 传入 visibleDay/onVisibleDayChange 时启用）：
 *   面板顶部「全部/D1/D2…」，选中天过滤面板并同步地图聚焦
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
  /**
   * Day 筛选 tabs（M15，仅 TripPage 传入）：面板顶部渲染「全部/D1/D2…」，
   * 选中后过滤面板只显示该天，并回传 TripPage 让地图聚焦同一天（原地图浮条的状态通道）
   */
  visibleDay?: number | null;
  onVisibleDayChange?: (dayIndex: number | null) => void;
  /** 打开候选池面板（M17：无覆盖酒店天的「去候选池加入」引导；TripPage 传入，分享页不传则只显示文案） */
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

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Day 筛选 tabs（M15）：替代原地图左上浮条；选中天 = 面板过滤 + 地图聚焦 */}
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
          还没有行程。让 agent 帮你排，或在「搜索添加」里手动加地点。
        </div>
      )}
      {shownDays.map((day) => {
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
        // 已跳过酒店锚点，面板对应渲染「从 机场/车站 出发」/「前往 机场/车站」端点节点；
        // 仅一个 entry 的纯移动天不重复渲染（transit 卡本身已足够）
        const startTransitItem =
          startLeg == null && timeline.length > 1 && timeline[0]?.transit ? timeline[0] : null;
        const endTransitItem =
          endLeg == null && timeline.length > 1 && timeline[timeline.length - 1]?.transit
            ? timeline[timeline.length - 1]
            : null;
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
                {placeCount} 个地点
                {day.date ? ` · ${day.date}` : ""}
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

            {/* 住宿行：平时「当晚住宿：X」，换酒店日「离店 A → 入住 B」；无覆盖时给「去候选池加入」引导（M17） */}
            {nightStay || switchFrom ? (
              <p className="mb-1.5 flex items-center gap-1 text-[11px] text-slate-400">
                <BedDouble className="size-3 shrink-0" />
                {switchFrom ? (
                  <span>
                    离店 {renderStayName(switchFrom)}
                    {nightStay ? <> → 入住 {renderStayName(nightStay)}</> : "，当晚未安排住宿"}
                  </span>
                ) : nightStay ? (
                  <span>当晚住宿：{renderStayName(nightStay)}</span>
                ) : null}
                {!nightStay && !readOnly && onOpenCandidates && (
                  <SelectHotelGuide onClick={onOpenCandidates} />
                )}
              </p>
            ) : (
              <p className="mb-1.5 flex items-center gap-1 text-[11px] text-slate-400">
                <BedDouble className="size-3 shrink-0" />
                <span>
                  当晚未安排住宿
                  <span className="text-slate-300">
                    （酒店需加入行程并设置入离店天，才会锚定当天首尾）
                  </span>
                </span>
                {!readOnly && onOpenCandidates && (
                  <SelectHotelGuide onClick={onOpenCandidates} />
                )}
              </p>
            )}

            <ol className="space-y-0">
              {entries.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-slate-400">
                  {nightStay
                    ? `当天暂无行程（当晚住宿：${placeName(nightStay.placeId)}）`
                    : "当天暂无行程"}
                </li>
              )}
              {/* 酒店出发节点（M17）：首段 leg（酒店→首 entry）存在时渲染，时刻 = 首站开始 - 首段时长 */}
              {startLeg?.fromPlaceId != null && (
                <li>
                  <HotelAnchorRow
                    direction="depart"
                    name={placeName(startLeg.fromPlaceId)}
                    timeMin={
                      timeline.length > 0
                        ? timeline[0].startMin - Math.round((startLeg.durationS ?? 0) / 60)
                        : null
                    }
                    estimated={timeline[0]?.estimated ?? true}
                    onSelect={() => onSelectPlace(startLeg.fromPlaceId!)}
                  />
                  <LegRow
                    leg={startLeg}
                    toHotel={false}
                    readOnly={readOnly}
                    busy={busy}
                    onOverride={overrideMode}
                  />
                </li>
              )}
              {timeline.map((item, i) => {
                const { entry, place, transit, startMin, endMin, estimated } = item;
                const leg = legAfter.get(entry.id);
                const toHotel = leg != null && leg.toPlaceId != null;
                const selected = place != null && place.id === selectedPlaceId;
                const hours = place ? openingHoursOf(place) : null;
                const hoursRange = hours ? parseOpeningHoursRange(hours) : null;
                // 排期时段与营业时段完全无交叠 = 明显冲突（解析不出时段时不告警，仅展示）
                const hoursConflict =
                  !transit && hoursRange != null && conflictsWithOpeningHours(hoursRange, startMin, endMin);
                // 序号只数 place entry（大交通卡不占地点序号）；类别按 所处天/总天数 推断（首日=抵达，末日=离开）
                const kind = transit
                  ? (transitKindOf(entry, day.dayIndex, sortedDays.length) ?? "intercity")
                  : null;
                return (
                  <li key={entry.id}>
                    {/* 离开日大交通端点（M20）：末 entry 为 transit 离开时，在卡片前渲染「前往 机场/车站」；
                        到达车站时刻 ≈ transit 的 departTime（startMin），恒按估算渲染（~ 前缀） */}
                    {kind && endTransitItem != null && i === timeline.length - 1 && (
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
                        selected={selected}
                        readOnly={readOnly}
                        busy={busy}
                        isFirst={i === 0}
                        isLast={i === timeline.length - 1}
                        onSelect={() => place && onSelectPlace(place.id)}
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
                    {/* 到达日大交通端点（M20）：首 entry 为 transit 到达时，在卡片后渲染「从 机场/车站 出发」，时刻 = 下一站开始 - 交通时长 */}
                    {kind && startTransitItem != null && i === 0 && (
                      <TransitAnchorRow
                        direction="depart"
                        kind={kind}
                        name={transitToName(entry, placeById) ?? "目的地"}
                        timeMin={
                          timeline.length > 1
                            ? timeline[1].startMin - Math.round((leg?.durationS ?? 0) / 60)
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
                      />
                    )}
                  </li>
                );
              })}
              {/* 返回酒店节点（M17）：末段 leg（末 entry→酒店）的时长在其上方 LegRow 展示，时刻 = 末站结束 + 末段时长 */}
              {endLeg?.toPlaceId != null && (
                <li>
                  <HotelAnchorRow
                    direction="return"
                    name={placeName(endLeg.toPlaceId)}
                    timeMin={
                      timeline.length > 0
                        ? timeline[timeline.length - 1].endMin +
                          Math.round((endLeg.durationS ?? 0) / 60)
                        : null
                    }
                    estimated={timeline[timeline.length - 1]?.estimated ?? true}
                    onSelect={() => onSelectPlace(endLeg.toPlaceId!)}
                  />
                </li>
              )}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/** 大交通卡（M11）：🛬抵达 / 🛫离开 / 🚄城市间，显示 departTime–arriveTime 与起讫名；非只读可直接编辑时间 */
function TransitRow({
  item,
  kind,
  route,
  selected,
  readOnly,
  busy,
  isFirst,
  isLast,
  onSelect,
  onMove,
  onRemove,
  onSaveTimes,
}: {
  item: TimelineItem;
  kind: TransitKind;
  route: string;
  selected: boolean;
  readOnly: boolean;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
  onMove: (position: number) => void;
  onRemove: () => void;
  onSaveTimes: (entryId: string, departTime: string | null, arriveTime: string | null) => Promise<void>;
}) {
  const { entry, place, startMin, endMin, estimated } = item;
  const Icon = kind === "arrival" ? PlaneLanding : kind === "departure" ? PlaneTakeoff : TrainFront;
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
        selected
          ? "border-brand/50 bg-brand/10 ring-1 ring-brand/40"
          : "border-slate-300/70 bg-slate-500/5 hover:bg-slate-500/10"
      } ${place ? "cursor-pointer" : ""}`}
      onClick={onSelect}
    >
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-700 text-white"
        title={TRANSIT_KIND_META[kind].label}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm">
          <span className="truncate font-medium text-slate-800">{route}</span>
          <span className="shrink-0 rounded bg-slate-900/8 px-1 text-[10px] text-slate-500">
            {TRANSIT_KIND_META[kind].label}
          </span>
        </span>
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
 *  返回酒店段（toHotel）的「返回 X 酒店」由 M17 的酒店端点节点承载，这里只保留交通信息且不提供覆盖切换 */
function LegRow({
  leg,
  toHotel,
  readOnly,
  busy,
  onOverride,
}: {
  leg: TransportLegDto;
  toHotel: boolean;
  readOnly: boolean;
  busy: boolean;
  onOverride: (legId: string, mode: "walk" | "drive" | null) => Promise<void>;
}) {
  // modeOverride 非空 = 人工覆盖过（M1），自动重算不会冲掉；可点击徽标恢复自动
  const overridden = leg.modeOverride != null;
  return (
    <div className="group/leg flex items-center gap-1 py-0.5 pl-9 text-[11px] text-slate-400">
      <TransportIcon mode={leg.mode} />
      <span>
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

/** 酒店端点节点（M17）：每天首「从 X 酒店出发」/ 尾「返回 X 酒店」，点击在地图上选中酒店。
 *  hotelpin 红 + 虚线卡片区别于普通 entry 与大交通卡；时刻 ~ 前缀 = 随时间轴推算的估算值 */
function HotelAnchorRow({
  direction,
  name,
  timeMin,
  estimated,
  onSelect,
}: {
  direction: "depart" | "return";
  name: string;
  timeMin: number | null;
  estimated: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-hotelpin/40 bg-hotelpin/8 px-2 py-1.5 transition-colors hover:bg-hotelpin/15"
      onClick={onSelect}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hotelpin text-white">
        <BedDouble className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline text-sm font-medium text-slate-700">
        <span className="shrink-0">{direction === "depart" ? "从 " : "返回 "}</span>
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
          {direction === "depart" ? " 出发" : " 到店"}
        </span>
      )}
    </div>
  );
}

/** 大交通端点节点（M20 追加）：到达日首「从 机场/车站 出发」、离开日尾「前往 机场/车站」，
 *  对应服务端 recalcDayLegs 对首/末 transit 天跳过酒店锚点的行为；样式对齐 TransitRow（slate 虚线卡 +
 *  类别图标），时刻 ~ 前缀 = 随时间轴推算的估算值；起讫引用行程内 place 时点击在地图上选中该地点 */
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
  const Icon = kind === "arrival" ? PlaneLanding : kind === "departure" ? PlaneTakeoff : TrainFront;
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-dashed border-slate-400/70 bg-slate-500/8 px-2 py-1.5 transition-colors ${
        onSelect ? "cursor-pointer hover:bg-slate-500/15" : ""
      }`}
      onClick={onSelect}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-700 text-white">
        <Icon className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline text-sm font-medium text-slate-700">
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

/** 「去候选池加入」引导钮（M17；M20 话术统一）：酒店「加入行程」（带入住/离店天）后才参与首尾锚定 */
function SelectHotelGuide({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="酒店「加入行程」（带入住/离店天）后才会作为当天行程的首尾锚点；仅放进候选池还不够"
      className="shrink-0 whitespace-nowrap rounded bg-slate-900/8 px-1.5 py-0.5 text-slate-500 transition-colors hover:bg-slate-900/15 hover:text-slate-700"
    >
      去候选池加入 →
    </button>
  );
}

function TransportIcon({ mode }: { mode: string }) {
  if (mode === "walk") return <Footprints className="size-3 shrink-0 text-slate-400" />;
  if (mode === "transit") return <Bus className="size-3 shrink-0 text-slate-400" />;
  return <Car className="size-3 shrink-0 text-slate-400" />;
}
