import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  CalendarCheck,
  ChevronDown,
  Clock,
  ExternalLink,
  Globe,
  Hourglass,
  Info,
  MapPin,
  Phone,
  Sparkles,
  Wallet,
} from "lucide-react";
import {
  formatMoney,
  formatVisitDuration,
  type BudgetSummary,
  type PlaceDto,
  type SharePayload,
} from "@yarnball/shared";
import { api } from "../api/client";
import { Badge } from "../components/ui/badge";
import { MapCanvas, dayColor } from "../features/map/MapCanvas";
import { ItineraryPanel } from "../features/itinerary/ItineraryPanel";
import {
  BOOKING_STATUS_META,
  bookingStatusOf,
  openingHoursOf,
} from "../features/candidates/booking";

/** 信息卡外链展示：取 URL 的 host，解析失败退回原文（与 TripPage 同款） */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 只读分享页：全屏地图 + 毛玻璃浮层行程面板（无编辑无对话）；地点信息卡与预算条均为只读 */
export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState({ amapJsKey: "", amapJsSecret: "" });
  const [visibleDay, setVisibleDay] = useState<number | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<"expanded" | "collapsed" | "hidden">("expanded");

  useEffect(() => {
    void fetch(`/api/share/${token}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("分享链接无效");
        return res.json() as Promise<SharePayload>;
      })
      .then(setPayload)
      .catch((err) => setError((err as Error).message));
    void api.config().then(setConfig);
  }, [token]);

  if (error) {
    return <div className="flex h-full items-center justify-center text-sm text-red-500">{error}</div>;
  }
  if (!payload) {
    return <div className="flex h-full items-center justify-center bg-slate-100 text-sm text-slate-400">加载中…</div>;
  }

  const { bundle, budget } = payload;
  const days = [...bundle.days].sort((a, b) => a.dayIndex - b.dayIndex);
  const selectedPlace =
    selectedPlaceId != null
      ? bundle.places.find((p) => p.id === selectedPlaceId) ?? null
      : null;
  const scheduledPlaceIds = new Set(bundle.entries.map((e) => e.placeId));

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
                Day {d.dayIndex}
              </button>
            );
          })}
        </div>
      )}

      {/* 左下：选中地点信息卡（只读版，复刻 TripPage 信息卡详情块，无操作按钮） */}
      {selectedPlace && (
        <SharePlaceCard
          place={selectedPlace}
          scheduled={scheduledPlaceIds.has(selectedPlace.id)}
          currency={bundle.trip.currency}
          onClose={() => setSelectedPlaceId(null)}
        />
      )}

      {/* 行程浮层面板 */}
      {panelMode === "hidden" ? (
        <button
          onClick={() => setPanelMode("expanded")}
          className="glass panel-in absolute right-4 top-4 z-20 rounded-full px-3.5 py-2 text-xs font-medium text-slate-600 shadow-lg transition-transform hover:scale-105"
        >
          🗓 显示行程
        </button>
      ) : panelMode === "collapsed" ? (
        <button
          onClick={() => setPanelMode("expanded")}
          className="glass panel-in absolute right-4 top-4 z-20 rounded-full px-3.5 py-2 text-xs font-medium text-slate-600 shadow-lg transition-transform hover:scale-105"
        >
          🗓 行程
        </button>
      ) : (
        <aside className="glass-deep panel-in absolute bottom-4 right-4 top-4 z-20 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[22px]">
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
          {/* 预算条（只读）：随分享包下发的汇总，无编辑入口 */}
          <div className="px-3 pt-2.5">
            <ShareBudgetStrip summary={budget} />
          </div>
          <div className="glass-text min-h-0 flex-1 bg-white/40">
            <ItineraryPanel
              tripId={bundle.trip.id}
              bundle={bundle}
              selectedPlaceId={selectedPlaceId}
              onSelectPlace={setSelectedPlaceId}
              onDataChanged={() => {}}
              readOnly
            />
          </div>
        </aside>
      )}
    </div>
  );
}

/** 只读地点信息卡：状态徽章 + 详情块（地址/营业时间/游览时长/电话/官网/预订链接）+ 价格/预订提示 */
function SharePlaceCard({
  place,
  scheduled,
  currency,
  onClose,
}: {
  place: PlaceDto;
  scheduled: boolean;
  currency: string;
  onClose: () => void;
}) {
  const bookingStatus = bookingStatusOf(place);
  return (
    <div className="glass panel-in rounded-card absolute bottom-4 left-4 z-10 max-w-xs p-3.5 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{place.name}</p>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-900/8 hover:text-slate-600"
        >
          ✕
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {scheduled || place.status === "locked" ? (
          <Badge variant="locked">已加入</Badge>
        ) : (
          <Badge variant="candidate">候选</Badge>
        )}
        {place.createdBy === "agent" && (
          <Badge variant="blue">
            <Sparkles className="size-3" />
            agent 推荐
          </Badge>
        )}
        {bookingStatus !== "none" && (
          <Badge variant={BOOKING_STATUS_META[bookingStatus].badgeVariant}>
            <CalendarCheck className="size-3" />
            {BOOKING_STATUS_META[bookingStatus].label}
          </Badge>
        )}
      </div>
      {(place.address ||
        openingHoursOf(place) ||
        formatVisitDuration(place.visitDurationMin) ||
        place.phone ||
        place.website ||
        place.bookingUrl) && (
        <div className="mt-2 space-y-1 rounded-lg bg-slate-900/5 px-2.5 py-2 text-[11px] text-slate-600">
          {place.address && (
            <p className="flex items-start gap-1.5">
              <MapPin className="mt-0.5 size-3 shrink-0 text-slate-400" />
              <span>{place.address}</span>
            </p>
          )}
          {openingHoursOf(place) && (
            <p className="flex items-start gap-1.5">
              <Clock className="mt-0.5 size-3 shrink-0 text-slate-400" />
              <span>{openingHoursOf(place)}</span>
            </p>
          )}
          {formatVisitDuration(place.visitDurationMin) && (
            <p className="flex items-center gap-1.5">
              <Hourglass className="size-3 shrink-0 text-slate-400" />
              <span>{formatVisitDuration(place.visitDurationMin)}</span>
            </p>
          )}
          {place.phone && (
            <p className="flex items-center gap-1.5">
              <Phone className="size-3 shrink-0 text-slate-400" />
              <span>{place.phone}</span>
            </p>
          )}
          {place.website && (
            <a
              href={place.website}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-blue-600 hover:underline"
            >
              <Globe className="size-3 shrink-0 text-slate-400" />
              <span className="truncate">官网 · {urlHost(place.website)}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          )}
          {place.bookingUrl && (
            <a
              href={place.bookingUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-blue-600 hover:underline"
            >
              <CalendarCheck className="size-3 shrink-0 text-slate-400" />
              <span className="truncate">预订 · {urlHost(place.bookingUrl)}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          )}
        </div>
      )}
      {place.priceCny != null && (
        <p className="mt-1.5 text-sm font-semibold text-orange-600">
          {formatMoney(place.priceCny, currency)}
          {place.category === "restaurant" ? " /人" : place.category === "hotel" ? " /晚" : ""}
        </p>
      )}
      {place.bookingInfo && (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-blue-500/10 px-2 py-1 text-[11px] text-blue-700">
          <CalendarCheck className="mt-0.5 size-3 shrink-0" />
          {place.bookingInfo}
        </p>
      )}
    </div>
  );
}

/** 只读预算条：摘要行可展开分类明细，无编辑表单（数据随分享包下发） */
function ShareBudgetStrip({ summary }: { summary: BudgetSummary }) {
  const [open, setOpen] = useState(false);
  const cur = summary.currency;
  const overBudget = summary.remainingCny != null && summary.remainingCny < 0;
  const max = Math.max(summary.totalCny, summary.budgetCny ?? 0);

  return (
    <div className="rounded-2xl border border-slate-900/10 bg-white/60 p-2.5 shadow-sm">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <Wallet className="size-4 shrink-0 text-amber-500" />
        <span className="text-sm font-semibold text-slate-900">{formatMoney(summary.totalCny, cur)}</span>
        {summary.budgetCny != null && (
          <span className="text-xs text-slate-400">/ {formatMoney(summary.budgetCny, cur)}</span>
        )}
        {summary.remainingCny != null && (
          <Badge variant={overBudget ? "destructive" : "success"}>
            {overBudget
              ? `超支 ${formatMoney(Math.abs(summary.remainingCny), cur)}`
              : `剩 ${formatMoney(summary.remainingCny, cur)}`}
          </Badge>
        )}
        {summary.unpricedCount > 0 && (
          <span title={`${summary.unpricedCount} 个地点未定价，实际花费可能更高`}>
            <Info className="size-3.5 text-amber-500" />
          </span>
        )}
        <ChevronDown
          className={`ml-auto size-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-2.5 space-y-2 border-t border-slate-900/8 pt-2.5">
          <BudgetRow
            label="住宿"
            detail={summary.hotelSelected ? `${summary.nights} 晚 × ${summary.travelerCount} 人行程` : "未选酒店"}
            value={summary.hotelCny != null ? formatMoney(summary.hotelCny, cur) : "—"}
            amount={summary.hotelCny ?? 0}
            color="bg-red-400"
            max={max}
          />
          <BudgetRow
            label="美食"
            detail="人均 × 人数"
            value={formatMoney(summary.diningCny, cur)}
            amount={summary.diningCny}
            color="bg-orange-400"
            max={max}
          />
          <BudgetRow
            label="门票/活动"
            detail="单价 × 人数"
            value={formatMoney(summary.ticketsCny, cur)}
            amount={summary.ticketsCny}
            color="bg-blue-400"
            max={max}
          />
          {summary.unpricedCount > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-100/60 px-2 py-1 text-[11px] text-amber-700">
              <Info className="mt-0.5 size-3 shrink-0" />
              {summary.unpricedCount} 个地点未定价，交通费未计入——实际花费可能更高。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function BudgetRow({
  label,
  detail,
  value,
  amount,
  color,
  max,
}: {
  label: string;
  detail: string;
  /** 展示串（formatMoney 结果）；百分比用原始数值 amount，不从展示串反解（小数/非 CNY 格式会断） */
  value: string;
  amount: number;
  color: string;
  max: number;
}) {
  const pct = max > 0 ? Math.min(100, (amount / max) * 100) : 0;
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between text-xs">
        <span className="text-slate-600">
          {label} <span className="text-slate-400">· {detail}</span>
        </span>
        <span className="font-medium text-slate-700">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-900/8">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
