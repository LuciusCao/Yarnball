import type { LngLat, PoiCandidate, TransportMode } from "@tripmapper/shared";
import { env } from "../env.js";

/**
 * GeoProvider —— 地理服务抽象。
 * - amap：国内。高德 Web 服务 API（需 key），POI/路径规划/距离矩阵，坐标 GCJ-02。
 * - osm：海外。Photon 搜索 + FOSSGIS OSRM 路线/矩阵（全部零 key），坐标 WGS84。
 * 行程创建时按目的地定死 provider，之后搜索/路线/地图渲染/矩阵全部走同一 provider，
 * 绝不混用（GCJ-02 与 WGS84 偏移约几百米，混用会把点画进海里）。
 */

export interface RouteResult {
  mode: TransportMode;
  distanceM: number | null;
  durationS: number | null;
  polyline: LngLat[] | null;
}

export interface ResolvedCity {
  adcode: string | null;
  center: LngLat;
  country: string | null;
  /** ISO 3166-1 alpha-2（Nominatim 提供，用于币种判定） */
  countryCode: string | null;
}

export interface GeoProvider {
  name: "amap" | "osm";
  /** 地点关键词搜索（agent 解析攻略文本的核心依赖）；bias 为行程城市中心，用于相关性偏置 */
  searchPoi(keyword: string, city: string, bias?: LngLat | null): Promise<PoiCandidate[]>;
  /** 城市名 → { adcode, 中心坐标, 国家 } */
  resolveCity(city: string): Promise<ResolvedCity | null>;
  /** 城市名联想（创建表单自动补全用），返回带国家的规范候选 */
  suggestCities(q: string): Promise<CitySuggestion[]>;
  /** 两点路线。osm 的 transit 返回估算值（免费公交路由不存在） */
  route(from: LngLat, to: LngLat, mode: TransportMode, city?: string): Promise<RouteResult>;
  /** 驾车时长矩阵（顺路度/重排优化用），n<=10；不可用时返回 null 由调用方降级 */
  drivingMatrix(points: LngLat[]): Promise<number[][] | null>;
}

export interface CitySuggestion {
  name: string;
  country: string | null;
  countryCode: string | null;
  center: LngLat;
}

/** 国家代码 → 行程默认币种 */
const COUNTRY_CURRENCIES: Record<string, string> = {
  cn: "CNY", au: "AUD", nz: "NZD", jp: "JPY", kr: "KRW", us: "USD",
  gb: "GBP", sg: "SGD", my: "MYR", th: "THB", id: "IDR", vn: "VND",
  ca: "CAD", de: "EUR", fr: "EUR", it: "EUR", es: "EUR", nl: "EUR",
  ch: "CHF", hk: "HKD", mo: "MOP", tw: "TWD",
};

export function currencyForCountry(countryCode: string | null | undefined): string {
  if (!countryCode) return "USD";
  return COUNTRY_CURRENCIES[countryCode.toLowerCase()] ?? "USD";
}

export function getProvider(name: string): GeoProvider {
  return name === "amap" ? amap : osm;
}

// ---------- 公共工具 ----------

const loc = (p: LngLat) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

/** 路线结果缓存：agent 反复调整行程时避免打爆上游配额。按 provider 隔离（坐标系不同）。 */
class RouteCache {
  private map = new Map<string, RouteResult>();
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, value: RouteResult) {
    if (this.map.size >= 2000) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}
const amapRouteCache = new RouteCache();
const osmRouteCache = new RouteCache();

/** 直线距离（米） */
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

/** 路线估算降级：无 key / API 失败时用直线距离 + 模式速度估算 */
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

// ---------- 高德（国内） ----------

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

export const amap: GeoProvider = {
  name: "amap",

  async searchPoi(keyword, city) {
    const body = await amapGet<{ pois: Array<Record<string, string>> }>("/place/text", {
      keywords: keyword,
      city,
      citylimit: "false",
      offset: "10",
      page: "1",
    });
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
      geocodes: Array<{
        adcode: string;
        location: string;
        country: string | string[];
      }>;
    }>("/geocode/geo", { address: city });
    const geo = body.geocodes?.[0];
    if (!geo) return null;
    const center = geo.location ? parseLngLat(geo.location) : null;
    if (!center) return null;
    const country = Array.isArray(geo.country) ? geo.country[0] : geo.country;
    return { adcode: geo.adcode, center, country: country ?? null, countryCode: "cn" };
  },

  async suggestCities(q) {
    const body = await amapGet<{
      geocodes: Array<{
        city: string | string[];
        province: string | string[];
        country: string | string[];
        location: string;
      }>;
    }>("/geocode/geo", { address: q });
    const seen = new Set<string>();
    const out: CitySuggestion[] = [];
    for (const g of body.geocodes ?? []) {
      const pick = (v: string | string[] | undefined) =>
        Array.isArray(v) ? v[0] : v ?? null;
      const name = pick(g.city) ?? pick(g.province) ?? q;
      if (seen.has(name)) continue;
      const center = g.location ? parseLngLat(g.location) : null;
      if (!center) continue;
      seen.add(name);
      out.push({ name, country: pick(g.country), countryCode: "cn", center });
      if (out.length >= 5) break;
    }
    return out;
  },

  async route(from, to, mode) {
    const cacheKey = `${mode}|${loc(from)}|${loc(to)}`;
    const cached = amapRouteCache.get(cacheKey);
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
      // transit
      const body = await amapGet<{
        route: {
          transit: {
            distance: string;
            duration: string;
            segments: Array<{ walking?: { steps: Array<{ polyline: string }> } }>;
          };
        } | null;
      }>("/direction/transit/integrated", { origin: loc(from), destination: loc(to), city: "", cityd: "" });
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
    amapRouteCache.set(cacheKey, result);
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

// ---------- OSM 生态（海外，零 key） ----------

/**
 * Photon（komoot，基于 OSM 数据）：地点搜索 + 地理编码，无需 key。
 * OSRM（FOSSGIS 社区实例）：路径规划 + 距离表，无需 key。
 * 两者都要求带识别性 User-Agent（OSM 服务使用政策），单机自用流量完全在礼貌范围内。
 */

const PHOTON_BASE = "https://photon.komoot.io/api";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const OSRM_CAR = "https://routing.openstreetmap.de/routed-car";
const OSRM_FOOT = "https://routing.openstreetmap.de/routed-foot";
const OSM_UA = "TripMapper/0.1 (self-hosted travel planner)";

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    country?: string;
    type?: string;
  };
}

async function photonGet(params: Record<string, string>): Promise<PhotonFeature[]> {
  const url = new URL(PHOTON_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "User-Agent": OSM_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`photon http ${res.status}`);
  const body = (await res.json()) as { features: PhotonFeature[] };
  return body.features ?? [];
}

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: { coordinates: [number, number][] };
}

async function osrmRouteRequest(base: string, path: string, from: LngLat, to: LngLat): Promise<OsrmRoute> {
  const url = `${base}/route/v1/${path}/${loc(from)};${loc(to)}?overview=full&geometries=geojson`;
  const res = await fetch(url, {
    headers: { "User-Agent": OSM_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`osrm http ${res.status}`);
  const body = (await res.json()) as { code: string; routes?: OsrmRoute[] };
  if (body.code !== "Ok" || !body.routes?.[0]) throw new Error(`osrm ${body.code}`);
  return body.routes[0];
}

export const osm: GeoProvider = {
  name: "osm",

  async searchPoi(keyword, _city, bias) {
    const params: Record<string, string> = { q: keyword, limit: "10", lang: "en" };
    if (bias) {
      params.lat = String(bias.lat);
      params.lon = String(bias.lng);
    }
    const features = await photonGet(params);
    const candidates: PoiCandidate[] = [];
    for (const f of features) {
      const [lng, lat] = f.geometry.coordinates;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const p = f.properties;
      const address = [p.housenumber, p.street, p.postcode, p.city].filter(Boolean).join(" ");
      candidates.push({
        poiId: `${p.osm_type ?? "X"}${p.osm_id ?? ""}`,
        name: p.name ?? address ?? "Unnamed place",
        address: address || null,
        location: { lng, lat },
        cityName: p.city ?? p.country ?? null,
        type: p.type ?? null,
        tel: null,
      });
    }
    // bias 场景下过滤全球同名地点（如科罗拉多的 "Sydney Opera House"）：
    // 保留 150km 内候选；若不足 3 个再放宽保留全部，避免小镇 POI 被误滤光。
    if (bias) {
      const near = candidates.filter(
        (c) => haversineM(bias, c.location) <= 150_000,
      );
      if (near.length >= 3) return near;
      if (near.length > 0) return [...near, ...candidates.filter((c) => !near.includes(c))];
    }
    return candidates;
  },

  async resolveCity(city) {
    const suggestions = await this.suggestCities(city);
    const first = suggestions[0];
    return first
      ? { adcode: null, center: first.center, country: first.country, countryCode: first.countryCode }
      : null;
  },

  /**
   * 城市联想：Nominatim 优先（importance 排序 + addresstype 过滤，
   * 中文城市名如「悉尼」能正确命中澳大利亚悉尼，而不是 Photon 里的上海「悉尼园」），
   * Photon 后备（英文输入时快）。两者都只认 city/municipality/town 级别结果。
   */
  async suggestCities(q): Promise<CitySuggestion[]> {
    // --- Nominatim ---
    try {
      const url = new URL(`${NOMINATIM_BASE}/search`);
      url.searchParams.set("q", q);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "5");
      url.searchParams.set("dedupe", "1");
      url.searchParams.set("addressdetails", "1"); // 没有它 jsonv2 不返回 address 对象
      url.searchParams.set("accept-language", "zh,en");
      const res = await fetch(url, {
        headers: { "User-Agent": OSM_UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const body = (await res.json()) as Array<{
          name?: string;
          display_name?: string;
          lat: string;
          lon: string;
          addresstype?: string;
          address?: { country?: string; country_code?: string };
        }>;
        const CITY_TYPES = new Set(["city", "municipality", "town"]);
        const hits = body.filter((r) => r.name && CITY_TYPES.has(r.addresstype ?? ""));
        const out: CitySuggestion[] = hits.map((r) => ({
          name: r.name!,
          // address.country 需要 addressdetails=1；后备从 display_name 末段取
          country:
            r.address?.country ??
            r.display_name?.split(",").map((s) => s.trim()).filter(Boolean).at(-1) ??
            null,
          countryCode: r.address?.country_code ?? null,
          center: { lng: Number(r.lon), lat: Number(r.lat) },
        }));
        if (out.length > 0) return out;
      }
    } catch (err) {
      console.warn("[geo] nominatim city search failed:", (err as Error).message);
    }

    // --- Photon 后备 ---
    const features = await photonGet({ q, limit: "5", lang: "en" });
    const CITY_VALUES = new Set(["city", "town", "municipality"]);
    return features
      .filter(
        (f) =>
          f.properties.name != null &&
          f.properties.osm_key === "place" &&
          CITY_VALUES.has(f.properties.osm_value ?? f.properties.type ?? ""),
      )
      .map((f) => ({
        name: f.properties.name!,
        country: f.properties.country ?? null,
        countryCode: null,
        center: { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] },
      }));
  },

  async route(from, to, mode) {
    if (mode === "transit") {
      // 免费公交路由不存在：car 时长 × 1.25 + 6 分钟换乘惩罚，作为估算
      const est = fallbackRoute(from, to, "drive");
      return { ...est, mode: "transit", durationS: Math.round((est.durationS ?? 0) * 1.25 + 360) };
    }
    const cacheKey = `${mode}|${loc(from)}|${loc(to)}`;
    const cached = osmRouteCache.get(cacheKey);
    if (cached) return cached;

    const isWalk = mode === "walk";
    const route = await osrmRouteRequest(
      isWalk ? OSRM_FOOT : OSRM_CAR,
      isWalk ? "foot" : "driving",
      from,
      to,
    );
    const result: RouteResult = {
      mode: isWalk ? "walk" : "drive",
      distanceM: Math.round(route.distance),
      durationS: Math.round(route.duration),
      polyline: route.geometry.coordinates.map(([lng, lat]) => ({ lng, lat })),
    };
    osmRouteCache.set(cacheKey, result);
    return result;
  },

  async drivingMatrix(points) {
    if (points.length < 2 || points.length > 10) return null;
    const url = `${OSRM_CAR}/table/v1/driving/${points.map(loc).join(";")}?annotations=duration`;
    const res = await fetch(url, {
      headers: { "User-Agent": OSM_UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`osrm table http ${res.status}`);
    const body = (await res.json()) as { code: string; durations?: number[][] };
    if (body.code !== "Ok" || !body.durations) throw new Error(`osrm table ${body.code}`);
    return body.durations;
  },
};
