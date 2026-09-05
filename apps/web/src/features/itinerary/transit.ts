import type { EntryDto, PlaceDto } from "@yarnball/shared";

/**
 * 大交通（transit entry）展示辅助 —— 前端推断层。
 * M11 契约里 EntryDto.entryType 只有 "place"|"transit" 二值；抵达/离开/城市间 的区分
 * 由这里按「所在天序号 / 行程总天数」推断，不落库。
 * 起讫点：fromPlaceId/toPlaceId 引用行程内地点时优先显示 place 名（走真实坐标），
 * 否则用 fromName/toName 自由文本。
 */

/** 大交通类别：arrival=抵达目的地（🛬）/ departure=离开（🛫）/ intercity=城市间移动（🚄） */
export type TransitKind = "arrival" | "departure" | "intercity";

export const TRANSIT_KIND_META: Record<TransitKind, { label: string }> = {
  arrival: { label: "抵达" },
  departure: { label: "离开" },
  intercity: { label: "城市间" },
};

export function isTransitEntry(entry: EntryDto): boolean {
  return entry.entryType === "transit";
}

/**
 * 推断大交通类别：多天行程首日=抵达、末日=离开，其余（含单日行程）=城市间。
 * dayIndex 为 1-based 天序号，totalDays 为行程总天数。
 */
export function transitKindOf(
  entry: EntryDto,
  dayIndex: number,
  totalDays: number,
): TransitKind | null {
  if (!isTransitEntry(entry)) return null;
  if (totalDays > 1) {
    if (dayIndex <= 1) return "arrival";
    if (dayIndex >= totalDays) return "departure";
  }
  return "intercity";
}

/** 起点名：fromPlaceId 引用的 place 名优先，退回 fromName 自由文本 */
export function transitFromName(
  entry: EntryDto,
  placeById: Map<string, PlaceDto>,
): string | null {
  if (entry.fromPlaceId) {
    const name = placeById.get(entry.fromPlaceId)?.name;
    if (name) return name;
  }
  return entry.fromName?.trim() || null;
}

/** 讫点名：toPlaceId 引用的 place 名优先，退回 toName 自由文本 */
export function transitToName(entry: EntryDto, placeById: Map<string, PlaceDto>): string | null {
  if (entry.toPlaceId) {
    const name = placeById.get(entry.toPlaceId)?.name;
    if (name) return name;
  }
  return entry.toName?.trim() || null;
}

/** 起讫展示文本：「上海 → 北京」；缺一侧时给单侧，全缺返回 null */
export function transitRouteText(
  entry: EntryDto,
  placeById: Map<string, PlaceDto>,
): string | null {
  const from = transitFromName(entry, placeById);
  const to = transitToName(entry, placeById);
  if (from && to) return `${from} → ${to}`;
  return from ?? to ?? null;
}
