import { formatMoney, type TripBundle } from "@yarnball/shared";
import { CalendarCheck, UtensilsCrossed } from "lucide-react";

/**
 * 美食清单：餐厅卡片（人均/预约方式/备注，未排期提示）。
 * 预算汇总不在这里——那是跨类别的横切信息，见 BudgetStrip。
 */
export function DiningPanel({ bundle }: { bundle: TripBundle }) {
  const restaurants = bundle.places.filter((p) => p.category === "restaurant");
  const scheduledPlaceIds = new Set(bundle.entries.map((e) => e.placeId));
  const cur = bundle.trip.currency;

  return (
    <div className="h-full overflow-y-auto p-3">
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
    </div>
  );
}
