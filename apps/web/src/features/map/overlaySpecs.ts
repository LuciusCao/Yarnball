import type { LngLat, TripBundle } from "@yarnball/shared";
import { getSelectedStays } from "../candidates/hotelStays";

/**
 * 地图 overlay 数据层 —— 引擎无关（AMap / MapLibre 共用）。
 * MapCanvas 把 bundle 翻译成这里的 spec，各引擎只负责"怎么画"。
 */

export interface MarkerSpec {
  id: string; // placeId
  position: LngLat;
  /** 徽标文本，如 "D1·2 Sydney Opera House" 或 "🏨 ..." */
  label: string;
  /** 背景色（天色/酒店色/锁定金/候选灰） */
  color: string;
  /** 不透明度：候选=半透明（未确认），锁定/已排期=1 */
  opacity: number;
  /** 点击回调标识 */
  placeId: string;
}

export interface LineSpec {
  id: string; // legId
  path: LngLat[];
  color: string;
  /** 酒店往返段（虚线）vs 景点间移动（实线） */
  dashed: boolean;
}

export interface CircleSpec {
  id: string;
  center: LngLat;
  radiusM: number;
}

export interface OverlaySpecs {
  markers: MarkerSpec[];
  lines: LineSpec[];
  circle: CircleSpec | null;
}

export const DAY_COLORS = [
  "#2563eb", // blue-600
  "#ea580c", // orange-600
  "#16a34a", // green-600
  "#9333ea", // purple-600
  "#db2777", // pink-600
  "#0891b2", // cyan-600
  "#ca8a04", // yellow-600
  "#4f46e5", // indigo-800
];

export const HOTEL_COLOR = "#dc2626";
/** 未排期地点按 status 分色：候选=灰（半透明），锁定=金色实心 */
export const CANDIDATE_COLOR = "#94a3b8"; // slate-400
export const LOCKED_COLOR = "#d97706"; // amber-600
export const CANDIDATE_OPACITY = 0.55;

export function dayColor(dayIndex: number): string {
  return DAY_COLORS[(dayIndex - 1) % DAY_COLORS.length];
}

/** bundle → 引擎无关 overlay specs（含筛选逻辑） */
export function buildOverlaySpecs(
  bundle: TripBundle,
  visibleDayIndex: number | null,
  hotelArea: { center: LngLat; radiusM: number } | null,
): OverlaySpecs {
  const placeById = new Map(bundle.places.map((p) => [p.id, p]));

  // 天 → entries（按 position 排序）
  const dayEntries = new Map<string, TripBundle["entries"]>();
  for (const day of bundle.days) dayEntries.set(day.id, []);
  for (const entry of [...bundle.entries].sort((a, b) => a.position - b.position)) {
    dayEntries.get(entry.dayId)?.push(entry);
  }

  const hotelPlaceIds = new Set(bundle.hotelCandidates.map((h) => h.placeId));
  // 已选定酒店（多酒店，M10）：selected=true 的候选集合，legacy 镜像字段在 getSelectedStays 内兜底
  const selectedHotelPlaceIds = new Set(getSelectedStays(bundle).map((s) => s.placeId));
  const scheduledPlaceIds = new Set(bundle.entries.map((e) => e.placeId));

  const markers: MarkerSpec[] = [];
  const lines: LineSpec[] = [];

  const legByPair = new Map(bundle.legs.map((l) => [l.id, l]));

  for (const day of bundle.days) {
    if (visibleDayIndex != null && day.dayIndex !== visibleDayIndex) continue;
    const color = dayColor(day.dayIndex);
    const entries = dayEntries.get(day.id) ?? [];

    entries.forEach((entry, i) => {
      // transit entry 可能没有关联 place（纯文本起讫点），M12 落地前不在地图渲染
      const place = entry.placeId ? placeById.get(entry.placeId) : undefined;
      if (!place) return;
      markers.push({
        id: `e-${entry.id}`,
        position: place.location,
        label: `D${day.dayIndex}·${i + 1} ${place.name}`,
        color,
        opacity: 1,
        placeId: place.id,
      });
    });

    // 交通段：按 seq 排序（含酒店往返段），酒店端点的段画虚线
    const dayLegs = bundle.legs
      .filter((l) => l.dayId === day.id)
      .sort((a, b) => a.seq - b.seq);
    for (const leg of dayLegs) {
      const fromPlaceId = leg.fromEntryId
        ? entries.find((e) => e.id === leg.fromEntryId)?.placeId
        : leg.fromPlaceId;
      const toPlaceId = leg.toEntryId
        ? entries.find((e) => e.id === leg.toEntryId)?.placeId
        : leg.toPlaceId;
      const from = fromPlaceId ? placeById.get(fromPlaceId) : undefined;
      const to = toPlaceId ? placeById.get(toPlaceId) : undefined;
      if (!from || !to) continue;
      const path =
        leg.polyline && leg.polyline.length > 1
          ? leg.polyline
          : [from.location, to.location];
      lines.push({
        id: leg.id,
        path,
        color,
        dashed: !leg.fromEntryId || !leg.toEntryId,
      });
    }
  }

  // 酒店候选只在"全部天"视图显示（与行程天色区分）
  if (visibleDayIndex == null) {
    for (const cand of bundle.hotelCandidates) {
      const place = placeById.get(cand.placeId);
      if (!place) continue;
      const isSel = selectedHotelPlaceIds.has(cand.placeId);
      const locked = place.status === "locked";
      markers.push({
        id: `h-${cand.id}`,
        position: place.location,
        label: `${isSel ? "✓ " : ""}${place.name}${cand.pricePerNight ? ` · ${cand.pricePerNight}/晚` : ""}`,
        color: isSel ? HOTEL_COLOR : locked ? LOCKED_COLOR : CANDIDATE_COLOR,
        opacity: isSel || locked ? 1 : CANDIDATE_OPACITY,
        placeId: place.id,
      });
    }
    // 未编排散点（agent 刚建的 / 用户收藏的）：候选灰半透明，锁定金色实心
    for (const place of bundle.places) {
      if (scheduledPlaceIds.has(place.id) || hotelPlaceIds.has(place.id)) continue;
      const locked = place.status === "locked";
      markers.push({
        id: `p-${place.id}`,
        position: place.location,
        label: place.name,
        color: locked ? LOCKED_COLOR : CANDIDATE_COLOR,
        opacity: locked ? 1 : CANDIDATE_OPACITY,
        placeId: place.id,
      });
    }
  }

  return {
    markers,
    lines,
    circle:
      visibleDayIndex == null && hotelArea
        ? { id: "hotel-area", ...hotelArea }
        : null,
  };
}
