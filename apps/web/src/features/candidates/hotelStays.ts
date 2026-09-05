import type { TripBundle } from "@yarnball/shared";

/**
 * 多酒店入住区间 —— M9（multi-hotel-model）契约的适配层（契约已随 M9 广播确认）。
 *
 * 契约要点：
 * - HotelCandidateDto 增加 selected / checkInDay / checkOutDay 三个字段（仅 selected 时非空）；
 * - 天序号 1-based，闭开区间 [checkInDay, checkOutDay) 表示覆盖哪些天的「当晚」，checkOutDay
 *   最大可到 行程天数 + 1（住到行程结束）；换酒店日约定：旧酒店 checkOutDay == 新酒店 checkInDay；
 * - 同一行程内已选定酒店的区间不得重叠（服务端 422 校验，前端做选项禁用 + 提示）。
 *
 * 过渡期兼容：M9 合并前服务端还没下发这些字段，运行期回退到旧的
 * trip.selectedHotelCandidateId 单选定语义（视为覆盖全部天；该字段在 M9 后保留为 deprecated
 * 兼容镜像，故此兜底对新旧服务端都安全）。
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

/** 前瞻字段：M9 合并前 HotelCandidateDto 上还不存在，结构式宽松读取 */
type HotelCandidateWithStay = {
  id: string;
  placeId: string;
  selected?: boolean;
  checkInDay?: number | null;
  checkOutDay?: number | null;
};

/** 从 bundle 提取全部已选定住宿区间（含 legacy 单选定兜底），按入住天排序 */
export function getSelectedStays(bundle: TripBundle): HotelStay[] {
  const stays: HotelStay[] = [];
  for (const cand of bundle.hotelCandidates as HotelCandidateWithStay[]) {
    if (cand.selected && cand.checkInDay != null && cand.checkOutDay != null) {
      stays.push({
        candidateId: cand.id,
        placeId: cand.placeId,
        checkInDay: cand.checkInDay,
        checkOutDay: cand.checkOutDay,
      });
    }
  }
  if (stays.length === 0) {
    // legacy 单选定（M9 迁移后该字段可能消失，结构式宽松读取避免编译期依赖）
    const legacyId = (bundle.trip as { selectedHotelCandidateId?: string | null })
      .selectedHotelCandidateId;
    const legacy = legacyId
      ? bundle.hotelCandidates.find((h) => h.id === legacyId)
      : undefined;
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
