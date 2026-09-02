import { useEffect, useState } from "react";
import { formatMoney, type TripBundle } from "@odessey/shared";
import { toast } from "sonner";
import { CalendarCheck, Coins, Info, UtensilsCrossed, Users } from "lucide-react";
import { api } from "../../api/client";
import { Input, Select } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { TRIP_CURRENCIES } from "@odessey/shared";

/**
 * 美食 & 预算面板：
 * - 餐厅列表（人均/预约方式/备注，未排期的提示编排）
 * - 预算卡（总额编辑 / 人数 / 币种，分类汇总 vs 总额对比）
 */
export function DiningBudgetPanel({
  tripId,
  bundle,
  onDataChanged,
}: {
  tripId: string;
  bundle: TripBundle;
  onDataChanged: () => void;
}) {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.getBudget>>["summary"] | null>(null);
  const [budgetInput, setBudgetInput] = useState("");
  const [travelerCount, setTravelerCount] = useState(1);
  const [currency, setCurrency] = useState("AUD");
  const [saving, setSaving] = useState(false);

  async function refreshSummary() {
    try {
      const { summary } = await api.getBudget(tripId);
      setSummary(summary);
      setTravelerCount(summary.travelerCount);
      setCurrency(summary.currency);
      setBudgetInput(summary.budgetCny != null ? String(summary.budgetCny) : "");
    } catch {
      /* 静默 */
    }
  }

  useEffect(() => {
    void refreshSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, bundle.places.length, bundle.trip.selectedHotelCandidateId]);

  async function saveBudget() {
    setSaving(true);
    try {
      await api.updateBudget(tripId, {
        budgetCny: budgetInput.trim() === "" ? null : Number(budgetInput),
        travelerCount,
        currency,
      });
      toast.success("预算已更新");
      await refreshSummary();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const restaurants = bundle.places.filter((p) => p.category === "restaurant");
  const scheduledPlaceIds = new Set(bundle.entries.map((e) => e.placeId));
  const cur = summary?.currency ?? bundle.trip.currency;
  const curSymbol = { AUD: "A$", USD: "$", CNY: "¥", EUR: "€", GBP: "£", JPY: "¥" }[cur] ?? cur;

  return (
    <div className="h-full overflow-y-auto p-3">
      {/* ===== 预算卡 ===== */}
      <section className="mb-4 rounded-xl border border-slate-900/10 bg-white/60 p-3.5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <Coins className="size-4 text-amber-500" /> 预算
        </h3>

        {summary && (
          <>
            {/* 总览条 */}
            <div className="mb-3 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900">
                {curSymbol} {summary.totalCny.toLocaleString()}
              </span>
              <span className="text-xs text-slate-400">
                已计划{summary.budgetCny != null ? ` / ${curSymbol} ${summary.budgetCny.toLocaleString()}` : ""}
              </span>
              {summary.remainingCny != null && (
                <Badge variant={summary.remainingCny < 0 ? "destructive" as never : summary.remainingCny < summary.totalCny * 0.1 ? "orange" : "success"}>
                  {summary.remainingCny < 0
                    ? `超支 ${curSymbol} ${Math.abs(summary.remainingCny).toLocaleString()}`
                    : `剩 ${curSymbol} ${summary.remainingCny.toLocaleString()}`}
                </Badge>
              )}
            </div>

            {/* 分类汇总 */}
            <div className="mb-3 space-y-1.5 text-xs">
              <BudgetRow
                label="住宿"
                detail={summary.hotelSelected ? `${summary.nights} 晚` : "未选酒店"}
                value={summary.hotelCny != null ? formatMoney(summary.hotelCny, cur) : "—"}
                color="bg-red-400"
                max={summary.totalCny}
              />
              <BudgetRow
                label="餐饮"
                detail={`${restaurants.filter((r) => r.priceCny != null).length} 家已定价`}
                value={formatMoney(summary.diningCny, cur)}
                color="bg-orange-400"
                max={summary.totalCny}
              />
              <BudgetRow
                label="门票/活动"
                detail={`${bundle.places.filter((p) => (p.category === "attraction" || p.category === "activity") && p.priceCny != null).length} 项已定价`}
                value={formatMoney(summary.ticketsCny, cur)}
                color="bg-blue-400"
                max={summary.totalCny}
              />
            </div>

            {summary.unpricedCount > 0 && (
              <p className="mb-3 flex items-start gap-1.5 rounded-lg bg-amber-100/60 px-2.5 py-1.5 text-[11px] text-amber-700">
                <Info className="mt-0.5 size-3 shrink-0" />
                还有 {summary.unpricedCount} 个餐厅/景点没填价格，实际花费可能更高（交通费也未计入）。
              </p>
            )}

            {/* 编辑区 */}
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-900/8 pt-3">
              <div className="relative">
                <Coins className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
                <Input
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="总预算"
                  className="h-8 w-28 pl-8 text-xs"
                />
              </div>
              <div className="relative">
                <Users className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={travelerCount}
                  onChange={(e) => setTravelerCount(Number(e.target.value) || 1)}
                  className="h-8 w-16 pl-8 text-xs"
                />
              </div>
              <Select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="h-8 text-xs"
              >
                {TRIP_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              <Button size="sm" onClick={saveBudget} disabled={saving}>
                保存
              </Button>
            </div>
          </>
        )}
      </section>

      {/* ===== 餐厅列表 ===== */}
      <section>
        <h3 className="mb-2.5 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <UtensilsCrossed className="size-4 text-orange-500" /> 美食清单
          <span className="text-xs font-normal text-slate-400">{restaurants.length} 家</span>
        </h3>

        {restaurants.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white/40 py-8 text-center">
            <p className="text-xs text-slate-400">
              还没有餐厅。跟 agent 说「我想去 Margaret 和 Aria」，
              <br />
              它会查好位置、人均、预约方式并加到这里。
            </p>
          </div>
        )}

        <div className="space-y-2">
          {restaurants.map((r) => {
            const scheduled = scheduledPlaceIds.has(r.id);
            return (
              <div
                key={r.id}
                className={`rounded-xl border p-3 shadow-sm transition-colors ${
                  scheduled ? "border-slate-900/10 bg-white/60" : "border-orange-200/70 bg-orange-50/50"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">{r.name}</p>
                    <p className="truncate text-[11px] text-slate-400">{r.address ?? ""}</p>
                  </div>
                  {r.priceCny != null && (
                    <span className="shrink-0 text-sm font-semibold text-orange-600">
                      {formatMoney(r.priceCny, cur)}/人
                    </span>
                  )}
                </div>
                {r.bookingInfo && (
                  <p className="mt-1.5 flex items-start gap-1 rounded-lg bg-blue-50/80 px-2 py-1 text-[11px] text-blue-700">
                    <CalendarCheck className="mt-0.5 size-3 shrink-0" />
                    {r.bookingInfo}
                  </p>
                )}
                {r.notes && <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{r.notes}</p>}
                {!scheduled && (
                  <p className="mt-1.5 text-[11px] text-orange-500">未排入日程 · 可让 agent 编排到某天</p>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function BudgetRow({
  label,
  detail,
  value,
  color,
  max,
}: {
  label: string;
  detail: string;
  value: string;
  color: string;
  max: number;
}) {
  const amount = Number(value.replace(/[^\d]/g, "")) || 0;
  const pct = max > 0 ? Math.min(100, (amount / max) * 100) : 0;
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between">
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
