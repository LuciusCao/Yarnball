import type { TripBundle } from "@yarnball/shared";

/**
 * 多酒店入住区间（M9 契约，见 HotelCandidateDto.selected/checkInDay/checkOutDay）。
 *
 * 契约要点：
 * - 天序号 1-based，闭开区间 [checkInDay, checkOutDay) 表示覆盖哪些天的「当晚」，checkOutDay
 *   最大可到 行程天数 + 1（住到行程结束）；换酒店日约定：旧酒店 checkOutDay == 新酒店 checkInDay；
 * - 同一行程内已选定酒店的区间不得重叠（服务端 422 校验，前端做选项禁用 + 提示）。
 *
 * 兼容兜底：trip.selectedHotelCandidateId 是 deprecated 兼容镜像；仅当没有任何
 * selected 候选时（旧数据未迁移）回退为「覆盖全部天」的单条住宿。
 */

/** 一条已选定的住宿区间 */
export interface HotelStay {
  candidateId: string;
  placeId: string;
  checkInDay: number;
  checkOutDay: number;
}

export interface HotelStayRange {
  checkInDay: number;
  checkOutDay: number;
}

/** 从 bundle 提取全部已选定住宿区间（含 legacy 单选定兜底），按入住天排序 */
export function getSelectedStays(bundle: TripBundle): HotelStay[] {
  const stays: HotelStay[] = [];
  for (const cand of bundle.hotelCandidates) {
    if (cand.selected && cand.checkInDay != null && cand.checkOutDay != null) {
      stays.push({
        candidateId: cand.id,
        placeId: cand.placeId,
        checkInDay: cand.checkInDay,
        checkOutDay: cand.checkOutDay,
      });
    }
  }
  if (stays.length === 0 && bundle.trip.selectedHotelCandidateId != null) {
    // legacy：deprecated 兼容镜像（旧数据未迁移时）
    const legacy = bundle.hotelCandidates.find(
      (h) => h.id === bundle.trip.selectedHotelCandidateId,
    );
    if (legacy) {
      stays.push({
        candidateId: legacy.id,
        placeId: legacy.placeId,
        checkInDay: 1,
        checkOutDay: bundle.days.length + 1,
      });
    }
  }
  return stays.sort((a, b) => a.checkInDay - b.checkInDay);
}

/** 覆盖第 dayIndex 天「当晚」的住宿（checkInDay <= day < checkOutDay） */
export function stayCoveringNight(stays: HotelStay[], dayIndex: number): HotelStay | null {
  return stays.find((s) => s.checkInDay <= dayIndex && dayIndex < s.checkOutDay) ?? null;
}

/** 闭开区间是否重叠 */
export function rangesOverlap(aIn: number, aOut: number, bIn: number, bOut: number): boolean {
  return aIn < bOut && bIn < aOut;
}

/** 晚数 */
export function stayNights(stay: HotelStayRange): number {
  return stay.checkOutDay - stay.checkInDay;
}

/** 选定新酒店时的默认区间：未被覆盖的最长连续段；全程已覆盖时返回 null */
export function largestFreeSpan(stays: HotelStay[], totalDays: number): HotelStayRange | null {
  // 可覆盖宇宙为 [1, totalDays + 1)：每晚对应一个整数天序号
  let best: HotelStayRange | null = null;
  let cursor = 1;
  for (const s of [...stays].sort((a, b) => a.checkInDay - b.checkInDay)) {
    if (s.checkInDay > cursor) {
      const span = { checkInDay: cursor, checkOutDay: Math.min(s.checkInDay, totalDays + 1) };
      if (!best || stayNights(span) > stayNights(best)) best = span;
    }
    cursor = Math.max(cursor, s.checkOutDay);
  }
  if (cursor < totalDays + 1) {
    const span = { checkInDay: cursor, checkOutDay: totalDays + 1 };
    if (!best || stayNights(span) > stayNights(best)) best = span;
  }
  return best;
}
