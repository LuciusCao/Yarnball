import type { DayDto, TripBundle, TripStop } from "@yarnball/shared";
import { stayCoveringNight, type HotelStay } from "../candidates/hotelStays";
import { transitToName } from "./transit";

/**
 * 多城市途经地（stop）前端推导层（M31 设计 §3/§4，M39 落地）。
 * day → stop 归属不落库，按优先级推导：当晚酒店 cityName → 当天末个 place entry 的 cityName
 * → 当天末个 transit 的讫点名。环线闭合同样不落库：最末一段 transit 的讫点 == stops[0] 即闭合。
 * 单城市行程（stops ≤ 1）所有逻辑退化为不展示，行为与之前完全一致。
 */

/** 途经地名匹配：城市名归名（place.cityName / transit 讫点）与 stop.name 不一定逐字相等，先精确后互相包含 */
function matchStop(stops: TripStop[], name: string): TripStop | null {
  const exact = stops.find((s) => s.name === name);
  if (exact) return exact;
  return stops.find((s) => name.includes(s.name) || s.name.includes(name)) ?? null;
}

/** 多城市行程判定：stops 多于 1 个节点才启用分组/标记等界面 */
export function isMultiCity(bundle: TripBundle): boolean {
  return bundle.trip.stops.length > 1;
}

/**
 * 推导某天所属途经地（M31 §3）：当晚住宿酒店的 cityName → 当天最后一个 place entry 的 cityName
 * → 当天最后一个 transit entry 的讫点名 → null（推导不出就不分组）。
 * 环线每晚一城由酒店区间天然给出正确答案；最后一天（无住宿）落到末站。
 */
export function stopOfDay(
  bundle: TripBundle,
  stays: HotelStay[],
  day: DayDto,
): TripStop | null {
  if (!isMultiCity(bundle)) return null;
  const placeById = new Map(bundle.places.map((p) => [p.id, p]));
  const entries = bundle.entries
    .filter((e) => e.dayId === day.id)
    .sort((a, b) => a.position - b.position);

  // ① 当晚酒店
  const nightStay = stayCoveringNight(stays, day.dayIndex);
  const nightCity = nightStay ? placeById.get(nightStay.placeId)?.cityName : null;
  if (nightCity) return matchStop(bundle.trip.stops, nightCity) ?? { name: nightCity, adcode: null, center: null };

  // ② 末个 place entry 的 cityName
  for (const entry of [...entries].reverse()) {
    if (entry.entryType === "place" && entry.placeId) {
      const city = placeById.get(entry.placeId)?.cityName;
      if (city) return matchStop(bundle.trip.stops, city) ?? { name: city, adcode: null, center: null };
      break;
    }
  }

  // ③ 末个 transit 的讫点名
  for (const entry of [...entries].reverse()) {
    if (entry.entryType === "transit") {
      const to = transitToName(entry, placeById);
      if (to) return matchStop(bundle.trip.stops, to);
      break;
    }
  }
  return null;
}

/** 连续同 stop 的天并成一组（分组头展示「📍 敦煌 · D4-D5」用）；单城市返回 null 表示不分组 */
export function groupDaysByStop(
  bundle: TripBundle,
  stays: HotelStay[],
  days: DayDto[],
): { stopName: string | null; days: DayDto[] }[] | null {
  if (!isMultiCity(bundle)) return null;
  const sorted = [...days].sort((a, b) => a.dayIndex - b.dayIndex);
  const groups: { stopName: string | null; days: DayDto[] }[] = [];
  for (const day of sorted) {
    const stopName = stopOfDay(bundle, stays, day)?.name ?? null;
    const last = groups[groups.length - 1];
    if (last && last.stopName === stopName) {
      last.days.push(day);
    } else {
      groups.push({ stopName, days: [day] });
    }
  }
  return groups;
}

/**
 * 环线闭合判定（M31 §4）：最末一段 transit 的讫点回到 stops[0] 即闭合。
 * 讫点取 toPlaceId 指向 place 的 cityName/名称 或 toName 自由文本。
 */
export function isLoopClosed(bundle: TripBundle): boolean {
  if (!isMultiCity(bundle)) return false;
  const firstStop = bundle.trip.stops[0];
  const placeById = new Map(bundle.places.map((p) => [p.id, p]));
  const dayOrder = new Map(bundle.days.map((d) => [d.id, d.dayIndex]));
  const transits = bundle.entries
    .filter((e) => e.entryType === "transit")
    .sort((a, b) => (dayOrder.get(a.dayId) ?? 0) - (dayOrder.get(b.dayId) ?? 0) || a.position - b.position);
  const lastTransit = transits[transits.length - 1];
  if (!lastTransit) return false;
  const to = transitToName(lastTransit, placeById);
  if (!to) return false;
  return to === firstStop.name || to.includes(firstStop.name) || firstStop.name.includes(to);
}
