import type { BookingStatus, PlaceDto } from "@yarnball/shared";

/**
 * 预订状态（bookingStatus）/ 营业时间（openingHours）的展示辅助。
 * 字段本身是 M11 的真实契约（PlaceDto.bookingStatus / PlaceDto.openingHours）；
 * 这里收敛徽章元信息、流转顺序与营业时段解析。
 */

export const BOOKING_STATUS_META: Record<
  BookingStatus,
  { label: string; badgeVariant: "secondary" | "orange" | "success" }
> = {
  none: { label: "无需预订", badgeVariant: "secondary" },
  pending: { label: "待预订", badgeVariant: "orange" },
  booked: { label: "已预订", badgeVariant: "success" },
};

export function bookingStatusOf(place: PlaceDto): BookingStatus {
  return place.bookingStatus;
}

/** 点选流转顺序：无需预订 → 待预订 → 已预订 → 无需预订 */
export function nextBookingStatus(s: BookingStatus): BookingStatus {
  return s === "none" ? "pending" : s === "pending" ? "booked" : "none";
}

export function openingHoursOf(place: PlaceDto): string | null {
  const t = place.openingHours?.trim();
  return t ? t : null;
}

export interface OpeningHoursRange {
  openMin: number;
  closeMin: number;
}

/**
 * 从营业时间文本解析第一个「HH:MM-HH:MM」时段。
 * 兼容 "09:00-18:00"、"9:30–17:00"、"09:00~21:00"、"9:00 至 18:00" 等写法；
 * 解析不出时段（如「全天开放」「周二闭馆」）返回 null —— v1 仅展示不告警。
 */
export function parseOpeningHoursRange(text: string): OpeningHoursRange | null {
  const m =
    /(\d{1,2})\s*[:：.]\s*(\d{2})\s*(?:[-–—~～]|至|到)\s*(\d{1,2})\s*[:：.]\s*(\d{2})/.exec(text);
  if (!m) return null;
  const oh = Number(m[1]);
  const om = Number(m[2]);
  const ch = Number(m[3]);
  const cm = Number(m[4]);
  if (oh > 23 || om > 59 || ch > 23 || cm > 59) return null;
  const openMin = oh * 60 + om;
  let closeMin = ch * 60 + cm;
  // 跨零点营业（如 18:00-02:00）：收市时间顺延到次日
  if (closeMin <= openMin) closeMin += 24 * 60;
  return { openMin, closeMin };
}

/** 排期时段 [startMin, endMin) 与营业时段完全无交叠 = 明显冲突（弱化告警用） */
export function conflictsWithOpeningHours(
  range: OpeningHoursRange,
  startMin: number,
  endMin: number,
): boolean {
  return endMin <= range.openMin || startMin >= range.closeMin;
}
