import { rangesOverlap, stayNights, type HotelStayRange } from "./hotelStays";

/**
 * 入离店天选择器（多酒店，M10）。
 * 入住第 N 天 / 离店第 M 天：天序号 1-based 闭开区间 [N, M)，
 * M = totalDays + 1 表示住到行程结束；与其他已选定酒店重叠的选项禁用并在 title 里提示。
 */

interface HotelStayRangePickerProps {
  /** 行程总天数 */
  totalDays: number;
  checkInDay: number;
  checkOutDay: number;
  /** 其他已选定酒店的区间（冲突检测用，不含自身）；label 用于冲突提示 */
  otherStays: (HotelStayRange & { label?: string })[];
  disabled?: boolean;
  onChange: (range: HotelStayRange) => void;
}

export function HotelStayRangePicker({
  totalDays,
  checkInDay,
  checkOutDay,
  otherStays,
  disabled = false,
  onChange,
}: HotelStayRangePickerProps) {
  /** 新区间与其他酒店冲突时返回提示文案，否则 null */
  function conflictReason(ci: number, co: number): string | null {
    const hit = otherStays.find((s) => rangesOverlap(ci, co, s.checkInDay, s.checkOutDay));
    return hit ? `与「${hit.label ?? "另一家酒店"}」的住宿区间重叠` : null;
  }

  // 入住天选项：1..totalDays；改了入住天后保证离店 > 入住（至少 1 晚）
  const checkInOptions = [];
  for (let d = 1; d <= totalDays; d++) {
    const co = Math.max(checkOutDay, d + 1);
    checkInOptions.push({ day: d, reason: conflictReason(d, co) });
  }
  // 离店天选项：checkInDay+1 .. totalDays+1（totalDays+1 = 行程结束）
  const checkOutOptions = [];
  for (let d = checkInDay + 1; d <= totalDays + 1; d++) {
    checkOutOptions.push({ day: d, reason: conflictReason(checkInDay, d) });
  }

  const selectClass =
    "rounded border border-slate-300/70 bg-white/70 px-1 py-0.5 text-[11px] text-slate-600 disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
      <label className="flex items-center gap-1">
        入住
        <select
          className={selectClass}
          value={checkInDay}
          disabled={disabled}
          onChange={(e) => {
            const d = Number(e.target.value);
            onChange({ checkInDay: d, checkOutDay: Math.max(checkOutDay, d + 1) });
          }}
        >
          {checkInOptions.map((o) => (
            <option
              key={o.day}
              value={o.day}
              disabled={o.reason != null && o.day !== checkInDay}
              title={o.reason ?? undefined}
            >
              第{o.day}天
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        离店
        <select
          className={selectClass}
          value={checkOutDay}
          disabled={disabled}
          onChange={(e) =>
            onChange({ checkInDay, checkOutDay: Number(e.target.value) })
          }
        >
          {checkOutOptions.map((o) => (
            <option
              key={o.day}
              value={o.day}
              disabled={o.reason != null && o.day !== checkOutDay}
              title={o.reason ?? undefined}
            >
              {o.day > totalDays ? "行程结束" : `第${o.day}天`}
            </option>
          ))}
        </select>
      </label>
      <span className="text-slate-400">{stayNights({ checkInDay, checkOutDay })} 晚</span>
    </div>
  );
}
