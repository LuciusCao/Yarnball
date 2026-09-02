import type { LngLat, PoiCandidate, TransportMode } from "@odessey/shared";
import { env } from "../env.js";

/**
 * GeoProvider —— 地理服务抽象。v1 用高德 Web 服务 API；
 * v2 接其他 provider（出境游）时保持此接口不变。
 */

export interface RouteResult {
  mode: TransportMode;
  distanceM: number | null;
  durationS: number | null;
  polyline: LngLat[] | null;
}

export interface GeoProvider {
  /** 地点关键词搜索（agent 解析攻略文本的核心依赖） */
  searchPoi(keyword: string, city: string): Promise<PoiCandidate[]>;
  /** 城市名 → { adcode, 中心坐标 }，建行程时解析一次 */
  resolveCity(city: string): Promise<{ adcode: string; center: LngLat } | null>;
  /** 两点路线（步行/驾车/公交） */
  route(from: LngLat, to: LngLat, mode: TransportMode, city?: string): Promise<RouteResult>;
  /** 驾车距离矩阵（顺路度/重排优化用），n<=10 */
  drivingMatrix(points: LngLat[]): Promise<number[][] | null>;
}

// ---------- 高德实现 ----------

const AMAP_BASE = "https://restapi.amap.com/v3";

class AmapError extends Error {}

async function amapGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = env.amapServerKey;
  if (!key) throw new AmapError("AMAP_SERVER_KEY is not configured");
  const url = new URL(path, AMAP_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", key);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new AmapError(`amap http ${res.status}`);
  const body = (await res.json()) as { status: string; info: string } & Record<string, unknown>;
  if (body.status !== "1") throw new AmapError(`amap ${body.info}`);
  return body as T;
}

function parseLngLat(s: string): LngLat | null {
  const [lng, lat] = s.split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

/** "lng1,lat1;lng2,lat2;..." → LngLat[] */
function parsePolyline(s: string): LngLat[] {
  return s
    .split(";")
    .map(parseLngLat)
    .filter((p): p is LngLat => p !== null);
}

/** 路线结果缓存：agent 反复调整行程时避免打爆配额 */
const routeCache = new Map<string, RouteResult>();
const ROUTE_CACHE_MAX = 2000;

function cacheGet(key: string): RouteResult | undefined {
  const hit = routeCache.get(key);
  return hit;
}

function cacheSet(key: string, value: RouteResult) {
  if (routeCache.size >= ROUTE_CACHE_MAX) {
    const oldest = routeCache.keys().next().value;
    if (oldest !== undefined) routeCache.delete(oldest);
  }
  routeCache.set(key, value);
}

const loc = (p: LngLat) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

export const amap: GeoProvider = {
  async searchPoi(keyword, city) {
    const body = await amapGet<{ pois: Array<Record<string, string>> }>(
      "/place/text",
      { keywords: keyword, city, citylimit: "false", offset: "10", page: "1" },
    );
    const candidates: PoiCandidate[] = [];
    for (const poi of body.pois ?? []) {
      const location = poi.location ? parseLngLat(poi.location) : null;
      if (!location) continue;
      candidates.push({
        poiId: poi.id,
        name: poi.name,
        address: poi.address && poi.address !== "[]" ? poi.address : null,
        location,
        cityName: poi.cityname && poi.cityname !== "[]" ? poi.cityname : null,
        type: poi.type ?? null,
        tel: poi.tel && poi.tel !== "[]" ? poi.tel : null,
      });
    }
    return candidates;
  },

  async resolveCity(city) {
    const body = await amapGet<{
      geocodes: Array<{ adcode: string; location: string; city: string }>;
    }>("/geocode/geo", { address: city });
    const geo = body.geocodes?.[0];
    if (!geo) return null;
    const center = geo.location ? parseLngLat(geo.location) : null;
    if (!center) return null;
    return { adcode: geo.adcode, center };
  },

  async route(from, to, mode, city) {
    const key = `${mode}|${loc(from)}|${loc(to)}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    let result: RouteResult;
    if (mode === "walk") {
      const body = await amapGet<{
        route: { paths: Array<{ distance: string; duration: string; steps: Array<{ polyline: string }> }> };
      }>("/direction/walking", { origin: loc(from), destination: loc(to) });
      const path = body.route?.paths?.[0];
      result = {
        mode,
        distanceM: path ? Number(path.distance) : null,
        durationS: path ? Number(path.duration) : null,
        polyline: path ? path.steps.flatMap((s) => parsePolyline(s.polyline)) : null,
      };
    } else if (mode === "drive" || mode === "taxi") {
      const body = await amapGet<{
        route: { paths: Array<{ distance: string; duration: string; steps: Array<{ polyline: string }> }> };
      }>("/direction/driving", { origin: loc(from), destination: loc(to), strategy: "32" });
      const path = body.route?.paths?.[0];
      result = {
        mode: "drive",
        distanceM: path ? Number(path.distance) : null,
        durationS: path ? Number(path.duration) : null,
        polyline: path ? path.steps.flatMap((s) => parsePolyline(s.polyline)) : null,
      };
    } else {
      // transit: city 参数必填
      const body = await amapGet<{
        route: {
          transit: {
            distance: string;
            duration: string;
            segments: Array<{ walking?: { distance: string; steps: Array<{ polyline: string }> }; bus?: { buslines: Array<{ via_stops?: string; departure_stop?: { location: string } }> } }>;
          };
        } | null;
      }>("/direction/transit/integrated", {
        origin: loc(from),
        destination: loc(to),
        city: city ?? "",
        cityd: city ?? "",
      });
      const transit = body.route?.transit;
      const polyline: LngLat[] = [];
      for (const seg of transit?.segments ?? []) {
        for (const step of seg.walking?.steps ?? []) {
          polyline.push(...parsePolyline(step.polyline));
        }
      }
      result = {
        mode: "transit",
        distanceM: transit ? Number(transit.distance) : null,
        durationS: transit ? Number(transit.duration) : null,
        polyline: polyline.length > 0 ? polyline : null,
      };
    }
    cacheSet(key, result);
    return result;
  },

  async drivingMatrix(points) {
    if (points.length === 0 || points.length > 10) return null;
    const body = await amapGet<{
      rows: Array<{ elements: Array<{ distance: string; duration: string }> }>;
    }>("/distance", {
      origins: points.map(loc).join("|"),
      destination: points.map(loc).join("|"),
      type: "1",
    });
    // 高德 distance API：origins × destination（这里两者相同集合）
    const n = points.length;
    const matrix: number[][] = [];
    let i = 0;
    for (const row of body.rows ?? []) {
      const durationRow: number[] = [];
      let j = 0;
      for (const el of row.elements ?? []) {
        if (el.distance === "0" && i !== j) durationRow.push(Number.NaN);
        else durationRow.push(Number(el.duration));
        j++;
      }
      while (durationRow.length < n) durationRow.push(Number.NaN);
      matrix.push(durationRow);
      i++;
    }
    return matrix;
  },
};

/** 直线距离（米），用于未配 key 的降级和步行/驾车模式选择 */
export function haversineM(a: LngLat, b: LngLat): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 路线估算的降级实现：无 key / API 失败时用直线距离 + 模式速度估算 */
export function fallbackRoute(from: LngLat, to: LngLat, mode: TransportMode): RouteResult {
  const distanceM = Math.round(haversineM(from, to));
  const speedMps = mode === "walk" ? 1.3 : mode === "transit" ? 6 : 8.5;
  return {
    mode,
    distanceM,
    durationS: Math.round((distanceM / speedMps) * 1.3), // 1.3 非直线系数
    polyline: null,
  };
}
