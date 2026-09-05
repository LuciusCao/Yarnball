import type { EntryDto, PlaceDto, TransportLegDto } from "@yarnball/shared";

/**
 * 行程时间轴推算（纯函数，方便后续单测）。
 * 规则：
 * - entry.startTime（agent 按 M1 契约写入，HH:MM）存在时直接用；
 * - 缺失时从 09:00 起，按「上一个 entry 的结束时间 + 交通段时长」顺推；
 * - 停留时长取 place.durationMin，缺省估 90 分钟。
 */

/** 每天推算的起点：09:00 */
export const DAY_START_MIN = 9 * 60;
/** 地点未填 durationMin 时的默认停留时长（分钟） */
export const DEFAULT_STAY_MIN = 90;

/** "HH:MM" → 当天分钟数；非法输入返回 null */
export function parseHHMM(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 当天分钟数 → "HH:MM"（允许跨午夜，取 24h 内） */
export function formatHHMM(minutes: number): string {
  const t = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface TimelineItem {
  entry: EntryDto;
  place: PlaceDto;
  /** 开始/结束（当天分钟数） */
  startMin: number;
  endMin: number;
  /** true = startTime 缺失，由推算得出（UI 用 ~ 前缀弱化展示） */
  estimated: boolean;
}

/**
 * 组装一天的时间轴：entries 已按 position 排序；
 * legAfter 为 entryId → 其后紧邻交通段（返回酒店段不影响次日推算，且停留累加到段尾即结束）。
 */
export function buildDayTimeline(
  entries: EntryDto[],
  placeById: Map<string, PlaceDto>,
  legAfter: Map<string, TransportLegDto>,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let cursor = DAY_START_MIN;
  for (const entry of entries) {
    const place = placeById.get(entry.placeId);
    if (!place) continue;
    const explicit = parseHHMM(entry.startTime);
    const startMin = explicit ?? cursor;
    const endMin = startMin + (place.durationMin ?? DEFAULT_STAY_MIN);
    items.push({ entry, place, startMin, endMin, estimated: explicit == null });
    // 下一站的最早开始 = 本站结束 + 交通时长（返回酒店段是当天收尾，不影响后续 entry，但当天也没后续了）
    const leg = legAfter.get(entry.id);
    cursor = endMin + Math.round((leg?.durationS ?? 0) / 60);
  }
  return items;
}
