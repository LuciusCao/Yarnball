import { useEffect, useState } from "react";
import {
  formatMoney,
  TRIP_CURRENCIES,
  type BudgetSummary,
} from "@tripmapper/shared";
import { toast } from "sonner";
import { ChevronDown, Info, Users, Wallet } from "lucide-react";
import { api } from "../../api/client";
import { Input, Select } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";

/**
 * 预算条 —— 横切关注点：常驻左面板顶部，跨 酒店/餐饮/门票 汇总。
 * 收起时一行摘要（总花费/预算/剩余 + 未定价警示），展开显示分类条与编辑。
 */
export function BudgetStrip({
  tripId,
  summary,
  onRefresh,
}: {
  tripId: string;
  summary: BudgetSummary | null;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const [travelerCount, setTravelerCount] = useState(1);
  const [currency, setCurrency] = useState("AUD");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (summary) {
      setTravelerCount(summary.travelerCount);
      setCurrency(summary.currency);
      setBudgetInput(summary.budgetCny != null ? String(summary.budgetCny) : "");
    }
  }, [summary]);

  if (!summary) return null;
  const cur = summary.currency;
  const overBudget = summary.remainingCny != null && summary.remainingCny < 0;

  async function save() {
    setSaving(true);
    try {
      await api.updateBudget(tripId, {
        budgetCny: budgetInput.trim() === "" ? null : Number(budgetInput),
        travelerCount,
        currency,
      });
      toast.success("预算已更新");
      await onRefresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-900/10 bg-white/60 p-2.5 shadow-sm">
      {/* 摘要行（点击展开） */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <Wallet className="size-4 shrink-0 text-amber-500" />
        <span className="text-sm font-semibold text-slate-900">
          {formatMoney(summary.totalCny, cur)}
        </span>
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

      {/* 展开详情 */}
      {open && (
        <div className="mt-2.5 space-y-2 border-t border-slate-900/8 pt-2.5">
          <BudgetRow
            label="住宿"
            detail={summary.hotelSelected ? `${summary.nights} 晚 × ${summary.travelerCount} 人行程` : "未选酒店"}
            value={summary.hotelCny != null ? formatMoney(summary.hotelCny, cur) : "—"}
            color="bg-red-400"
            max={Math.max(summary.totalCny, summary.budgetCny ?? 0)}
          />
          <BudgetRow
            label="餐饮"
            detail="人均 × 人数"
            value={formatMoney(summary.diningCny, cur)}
            color="bg-orange-400"
            max={Math.max(summary.totalCny, summary.budgetCny ?? 0)}
          />
          <BudgetRow
            label="门票/活动"
            detail="单价 × 人数"
            value={formatMoney(summary.ticketsCny, cur)}
            color="bg-blue-400"
            max={Math.max(summary.totalCny, summary.budgetCny ?? 0)}
          />
          {summary.unpricedCount > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-100/60 px-2 py-1 text-[11px] text-amber-700">
              <Info className="mt-0.5 size-3 shrink-0" />
              {summary.unpricedCount} 个地点未定价，交通费未计入——实际花费可能更高。
            </p>
          )}
          {/* 编辑 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Wallet className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
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
            <Button size="sm" onClick={save} disabled={saving}>
              保存
            </Button>
          </div>
        </div>
      )}
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
