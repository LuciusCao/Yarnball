import type { LngLat, PlaceCategory, TransportMode, TripBundle } from "@yarnball/shared";
import { isRailMode } from "@yarnball/shared";
import { getSelectedStays } from "../candidates/hotelStays";

/**
 * 地图 overlay 数据层 —— 引擎无关（AMap / MapLibre 共用）。
 * MapCanvas 把 bundle 翻译成这里的 spec，各引擎只负责"怎么画"。
 */

/**
 * 类别图标（M60）：与候选 tab 的 lucide 选型一一对应（hotel=BedDouble / restaurant=UtensilsCrossed
 * / attraction+activity=Landmark / other=Package，见 CandidatesPanel GROUP_META）。
 * 地图 marker 是引擎侧 HTML 字符串，用不了 lucide 组件，退化为 emoji；other 不加图标（保持钉面干净）。
 */
export function categoryIconEmoji(category: PlaceCategory | null): string {
  switch (category) {
    case "hotel":
      return "🏨 ";
    case "restaurant":
      return "🍴 ";
    case "attraction":
    case "activity":
      return "🏛️ ";
    default:
      return "";
  }
}

export interface MarkerSpec {
  id: string; // placeId
  position: LngLat;
  /** 徽标文本，如 "D1·2 Sydney Opera House" 或 "🏨 ..." */
  label: string;
  /** 地点类别（M60）：渲染器在 label 前加对应 emoji 图标（categoryIconEmoji） */
  category: PlaceCategory;
  /** 背景色（天色/酒店色/候选灰） */
  color: string;
  /** 不透明度：候选=半透明（未排期），已选定酒店/已排期=1 */
  opacity: number;
  /** 点击回调标识 */
  placeId: string;
}

/** 交通段线样式（M98）：road=公路线（默认，天色实线/酒店段虚线）；water=渡轮水上航线（固定水蓝色点划线，
 *  与天色解耦——段线本就按需单段显示，样式优先表达交通方式）；rail=轨道类铁路样式（深灰长划线） */
export type LineStyle = "road" | "water" | "rail";

/** 水上航线（渡轮）颜色：固定水蓝，跨天一致，一眼可辨「这段走水路」 */
export const WATER_LINE_COLOR = "#0284c7"; // sky-600
/** 铁路样式（地铁/轻轨/火车）颜色：深灰中性色，区别于公路天色 */
export const RAIL_LINE_COLOR = "#334155"; // slate-700

/** 交通方式 → 段线样式：ferry=水上航线；metro/light_rail/train=铁路；其余公路 */
export function lineStyleOfMode(mode: TransportMode): LineStyle {
  if (mode === "ferry") return "water";
  if (isRailMode(mode)) return "rail";
  return "road";
}

export interface LineSpec {
  id: string; // legId
  path: LngLat[];
  color: string;
  /** 酒店往返段（虚线）vs 景点间移动（实线） */
  dashed: boolean;
  /** 交通方式样式（M98）：渡轮/轨道类区别于公路线 */
  style: LineStyle;
}

/** 途经地（stop）标记（M39 多城市）：途经地中心 + 序号；不可点击，仅作空间锚点 */
export interface StopSpec {
  name: string;
  /** 1-based 游览顺序 */
  index: number;
  position: LngLat;
}

export interface OverlaySpecs {
  markers: MarkerSpec[];
  lines: LineSpec[];
  /** 多城市行程的途经地标记层（stops ≤ 1 或筛选单天时为空） */
  stops: StopSpec[];
}

/**
 * overlay 增量更新的内容签名（M53）：渲染器按 id 比对签名，
 * 相同签名 => 复用已挂载的 overlay 不重建，不同才增删改。
 */

export function markerSignature(m: MarkerSpec, selected: boolean): string {
  return JSON.stringify([m.position.lng, m.position.lat, m.label, m.category, m.color, m.opacity, selected]);
}

export function lineSignature(l: LineSpec): string {
  return JSON.stringify([l.path, l.color, l.dashed, l.style]);
}

export function stopSignature(s: StopSpec): string {
  return JSON.stringify([s.position.lng, s.position.lat, s.name, s.index]);
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
/** 未排期地点统一候选灰半透明（M98/issue #3：不再按 joined 状态做金色/不透明的视觉区分——
 *  交互上已无「锁定」概念，同一状态地点的地图钉视觉必须一致） */
export const CANDIDATE_COLOR = "#94a3b8"; // slate-400
export const CANDIDATE_OPACITY = 0.55;

export function dayColor(dayIndex: number): string {
  return DAY_COLORS[(dayIndex - 1) % DAY_COLORS.length];
}

/** bundle → 引擎无关 overlay specs（含筛选逻辑）。
 *  交通段线按需显示（M47）：默认不画 lines；selectedLegId 非空时只画该段（实线/虚线语义保留） */
export function buildOverlaySpecs(
  bundle: TripBundle,
  visibleDayIndex: number | null,
  selectedLegId: string | null = null,
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
        category: place.category,
        color,
        opacity: 1,
        placeId: place.id,
      });
    });

    // 交通段（M47 按需显示）：默认不画；仅当选中该段时才生成 LineSpec。
    // 按 seq 排序（含酒店往返段），酒店端点的段画虚线
    if (selectedLegId != null) {
      const dayLegs = bundle.legs
        .filter((l) => l.dayId === day.id)
        .sort((a, b) => a.seq - b.seq);
      for (const leg of dayLegs) {
        if (leg.id !== selectedLegId) continue;
        // 先判真实 polyline（评审 R1 顺手项）：纯文本端点的 ride leg（fromName/toName，无 place）
        // 解析不出端点坐标，但服务端已算好真实路由 polyline——直接画，不丢弃
        if (leg.polyline && leg.polyline.length > 1) {
          lines.push({
            id: leg.id,
            path: leg.polyline,
            color,
            dashed: !leg.fromEntryId || !leg.toEntryId,
            style: lineStyleOfMode(leg.mode),
          });
          continue;
        }
        // 端点解析（M39）：transit entry 的 placeId 常为空——大交通段本身（from==to==同一 entry）
        // 取 entry 的 from/toPlaceId；其余以 transit 为端点的段，起点端=讫点（toPlaceId）、终点端=起点（fromPlaceId）
        const endpointPlaceId = (
          entryId: string | null,
          placeIdFallback: string | null,
          endpoint: "from" | "to",
        ): string | null => {
          if (!entryId) return placeIdFallback;
          const e = entries.find((x) => x.id === entryId);
          if (!e) return null;
          if (e.placeId) return e.placeId;
          return endpoint === "from" ? e.toPlaceId : e.fromPlaceId;
        };
        let fromPlaceId: string | null;
        let toPlaceId: string | null;
        if (leg.fromEntryId != null && leg.fromEntryId === leg.toEntryId) {
          const rideEntry = entries.find((e) => e.id === leg.fromEntryId);
          fromPlaceId = rideEntry?.fromPlaceId ?? null;
          toPlaceId = rideEntry?.toPlaceId ?? null;
        } else {
          fromPlaceId = endpointPlaceId(leg.fromEntryId, leg.fromPlaceId, "from");
          toPlaceId = endpointPlaceId(leg.toEntryId, leg.toPlaceId, "to");
        }
        const from = fromPlaceId ? placeById.get(fromPlaceId) : undefined;
        const to = toPlaceId ? placeById.get(toPlaceId) : undefined;
        if (!from || !to) continue;
        lines.push({
          id: leg.id,
          path: [from.location, to.location],
          color,
          dashed: !leg.fromEntryId || !leg.toEntryId,
          style: lineStyleOfMode(leg.mode),
        });
      }
    }
  }

  // 酒店候选只在"全部天"视图显示（与行程天色区分）
  if (visibleDayIndex == null) {
    for (const cand of bundle.hotelCandidates) {
      const place = placeById.get(cand.placeId);
      if (!place) continue;
      const isSel = selectedHotelPlaceIds.has(cand.placeId);
      markers.push({
        id: `h-${cand.id}`,
        position: place.location,
        label: `${isSel ? "✓ " : ""}${place.name}${cand.pricePerNight ? ` · ${cand.pricePerNight}/晚` : ""}`,
        category: place.category,
        color: isSel ? HOTEL_COLOR : CANDIDATE_COLOR,
        opacity: isSel ? 1 : CANDIDATE_OPACITY,
        placeId: place.id,
      });
    }
    // 未编排散点（agent 刚建的 / 用户收藏的）：统一候选灰半透明，不再区分 joined（issue #3）
    for (const place of bundle.places) {
      if (scheduledPlaceIds.has(place.id) || hotelPlaceIds.has(place.id)) continue;
      markers.push({
        id: `p-${place.id}`,
        position: place.location,
        label: place.name,
        category: place.category,
        color: CANDIDATE_COLOR,
        opacity: CANDIDATE_OPACITY,
        placeId: place.id,
      });
    }
  }

  return {
    markers,
    lines,
    // 途经地标记层（M39）：多城市行程在「全部天」视图显示 stop 中心 + 序号；center 解析失败的跳过
    stops:
      visibleDayIndex == null && bundle.trip.stops.length > 1
        ? bundle.trip.stops.flatMap((s, i) =>
            s.center ? [{ name: s.name, index: i + 1, position: s.center }] : [],
          )
        : [],
  };
}
