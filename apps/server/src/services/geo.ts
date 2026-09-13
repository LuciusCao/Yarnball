import type { LngLat, PoiCandidate, TransitSegment, TransportMode } from "@yarnball/shared";
import { isTransitLikeMode } from "@yarnball/shared";
import { ProxyAgent, type Dispatcher } from "undici";
import pkg from "../../package.json" with { type: "json" };
import { getAmapServerKey } from "./settings.js";

/**
 * GeoProvider —— 地理服务抽象。
 * - amap：国内。高德 Web 服务 API（需 key），POI/路径规划/距离矩阵，坐标 GCJ-02。
 * - osm：海外。Photon 搜索 + FOSSGIS OSRM 路线/矩阵 + transitous（MOTIS 2）真实公交
 *   换乘（全部零 key），坐标 WGS84。
 * 行程创建时按目的地定死 provider，之后搜索/路线/地图渲染/矩阵全部走同一 provider，
 * 绝不混用（GCJ-02 与 WGS84 偏移约几百米，混用会把点画进海里）。
 */

export interface RouteResult {
  mode: TransportMode;
  distanceM: number | null;
  durationS: number | null;
  polyline: LngLat[] | null;
  /**
   * 公交分段详情（步行接驳 + 线路段）：amap 公共交通族（transit/bus/metro/light_rail/train）
   * 真实公交路由成功时填充；osm 侧由 transitous（MOTIS 2）真实公交换乘命中时填充。
   * walk/drive/ferry 路由、osm 未命中时的 OSRM 估算、fallbackRoute 降级均不设置（调用方按 null 处理）。
   */
  transitDetail?: TransitSegment[] | null;
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
  /**
   * 两点路线。osm 的公交族优先走 transitous（MOTIS 2）真实换乘（需传 date = 行程日
   * YYYY-MM-DD，查询时刻取当地约 09:00；不传则跳过真实路由），未命中降级 OSRM 估算。
   */
  route(from: LngLat, to: LngLat, mode: TransportMode, city?: string, date?: string): Promise<RouteResult>;
  /**
   * 驾车时长矩阵（顺路度/重排优化用）：sources × destinations 的矩形时长表（秒）。
   * 点数超上限时返回 null，由 drivingMatrixBatched 分批拼接或调用方降级直线估算。
   */
  drivingMatrixRect(sources: LngLat[], destinations: LngLat[]): Promise<number[][] | null>;
  /** 驾车方阵（points × points）：n 较小时的便捷封装，n 大请走 drivingMatrixBatched */
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

/** 结果缓存（LRU 近似：超容量丢最旧键）：agent 反复调整行程时避免打爆上游配额。按 provider 隔离（坐标系不同）。 */
class GeoCache<T> {
  private map = new Map<string, T>();
  constructor(private capacity = 2000) {}
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, value: T) {
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}
const amapRouteCache = new GeoCache<RouteResult>();
const osmRouteCache = new GeoCache<RouteResult>();
// 矩阵缓存：suggest_day_order / analyze_detour / suggest_day_clusters 会对同一批点反复求矩阵，
// 免费 OSRM 服按速率限流，不缓存会反复实打上游（矩阵条目少，容量给小一点）
const amapMatrixCache = new GeoCache<number[][]>(200);
const osmMatrixCache = new GeoCache<number[][]>(200);

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

/** 各方式估算速度（米/秒）：无 key / API 失败时按直线距离 ÷ 速度 × 非直线系数估算时长 */
const FALLBACK_SPEED_MPS: Record<TransportMode, number> = {
  walk: 1.3,
  transit: 6,
  bus: 6,
  taxi: 8.5,
  drive: 8.5,
  metro: 8,
  light_rail: 8,
  train: 10,
  ferry: 6.9, // ≈25km/h，渡轮走直线水域，不再乘非直线系数（见 ferryRouteEstimate）
};

/** 路线估算降级：无 key / API 失败时用直线距离 + 模式速度估算 */
export function fallbackRoute(from: LngLat, to: LngLat, mode: TransportMode): RouteResult {
  const distanceM = Math.round(haversineM(from, to));
  const speedMps = FALLBACK_SPEED_MPS[mode];
  return {
    mode,
    distanceM,
    durationS: Math.round((distanceM / speedMps) * 1.3), // 1.3 非直线系数
    polyline: null,
  };
}

/**
 * 渡轮段估算：免费上游均无轮渡路由（amap 公交换乘不含轮渡、OSRM 无 ferry profile），
 * 统一按「直线水域航线」估算——polyline 为起讫直线两点（前端画水上航线样式），
 * 时长 = 直线距离 ÷ 6.9m/s（≈25km/h）+ 7 分钟候船/靠泊缓冲。
 * 两个 provider 与 recalcDayLegs 的跨水启发式共用这一个口径。
 */
export function ferryRouteEstimate(from: LngLat, to: LngLat): RouteResult {
  const distanceM = Math.round(haversineM(from, to));
  return {
    mode: "ferry",
    distanceM,
    durationS: Math.round(distanceM / FALLBACK_SPEED_MPS.ferry) + 420,
    polyline: [from, to],
  };
}

// ---------- 高德（国内） ----------

const AMAP_BASE = "https://restapi.amap.com/v3";

class AmapError extends Error {}

async function amapGet<T>(path: string, params: Record<string, string>): Promise<T> {
  // key 读取走 settings（DB 覆盖 > env），PUT /api/settings 后立即生效
  const key = getAmapServerKey();
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

  async route(from, to, mode, city) {
    // 渡轮：上游无轮渡路由，直线水域航线估算（两 provider 同口径）
    if (mode === "ferry") return ferryRouteEstimate(from, to);
    const cacheKey = `${mode}|${loc(from)}|${loc(to)}|${city ?? ""}`;
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
      // 公共交通族（transit/bus/metro/light_rail/train）：公交换乘方案在 route.transits[]（方案列表，
      // 取首个最优方案），每个方案 transit.segments[] 含 walking（步行接驳）与 bus.buslines[]
      // （公交/地铁线路段）。city 是必填参数（起点城市），由调用方传入行程目的地城市。
      // 高德不区分子类型选型，统一走公交换乘，result.mode 保留请求的子类型供展示。
      const body = await amapGet<{
        route: {
          transits?: Array<{
            distance: string;
            duration: string;
            segments?: Array<{
              walking?: { distance?: string; duration?: string; steps?: Array<{ polyline: string }> };
              bus?: {
                buslines?: Array<{
                  name?: string;
                  type?: string;
                  distance?: string;
                  duration?: string;
                  via_num?: string;
                  departure_stop?: { name?: string };
                  arrival_stop?: { name?: string };
                }>;
              };
            }>;
          }>;
        } | null;
      }>("/direction/transit/integrated", { origin: loc(from), destination: loc(to), city: city ?? "", cityd: "" });
      const transit = body.route?.transits?.[0];
      const polyline: LngLat[] = [];
      const transitDetail: TransitSegment[] = [];
      const numOrNull = (v: string | undefined) => {
        const n = Number(v);
        return v != null && v !== "" && Number.isFinite(n) ? n : null;
      };
      for (const seg of transit?.segments ?? []) {
        // 步行接驳段（起点→上车站 / 下车站→终点）：距离/时长为米/秒；0 距离的空段跳过
        const walkDist = numOrNull(seg.walking?.distance);
        if (seg.walking && (walkDist ?? 0) > 0) {
          transitDetail.push({
            kind: "walk",
            distanceM: walkDist,
            durationS: numOrNull(seg.walking.duration),
            lineName: null,
            lineType: null,
            boardStop: null,
            alightStop: null,
            viaStops: null,
          });
        }
        // 公交/地铁线路段：线路名、上下车站、途经站数、分段距离（米）/时长（秒）
        for (const line of seg.bus?.buslines ?? []) {
          transitDetail.push({
            kind: "line",
            distanceM: numOrNull(line.distance),
            durationS: numOrNull(line.duration),
            lineName: line.name ?? null,
            lineType: line.type ?? null,
            boardStop: line.departure_stop?.name ?? null,
            alightStop: line.arrival_stop?.name ?? null,
            viaStops: numOrNull(line.via_num),
          });
        }
        for (const step of seg.walking?.steps ?? []) {
          polyline.push(...parsePolyline(step.polyline));
        }
      }
      result = {
        mode,
        distanceM: transit ? Number(transit.distance) : null,
        durationS: transit ? Number(transit.duration) : null,
        polyline: polyline.length > 0 ? polyline : null,
        transitDetail: transitDetail.length > 0 ? transitDetail : null,
      };
    }
    amapRouteCache.set(cacheKey, result);
    return result;
  },

  async drivingMatrixRect(sources, destinations) {
    if (sources.length === 0 || destinations.length === 0) return null;
    // 高德 v3 /distance：origins 支持多点（≤100 个坐标对），destination 只支持单点
    // → 按讫点逐个请求，origins 一次带全 sources；响应为 results: [{origin_id, dest_id, distance, duration}]
    // （注意不是百度风格的 rows/elements——此前按 rows 解析恒为空，矩阵静默降级直线估算）
    if (sources.length > 100) return null;
    const byDest: number[][] = [];
    for (const dest of destinations) {
      const body = await amapGet<{
        results: Array<{ origin_id: string; distance: string; duration: string }>;
      }>("/distance", {
        origins: sources.map(loc).join("|"),
        destination: loc(dest),
        type: "1",
      });
      const col: number[] = new Array(sources.length).fill(Number.NaN);
      for (const r of body.results ?? []) {
        const i = Number(r.origin_id) - 1; // origin_id 从 1 开始，对应当次请求的 origins 顺序
        if (i >= 0 && i < sources.length) col[i] = Number(r.duration);
      }
      byDest.push(col);
    }
    // 转置成 sources × destinations
    return sources.map((_, i) => destinations.map((_, j) => byDest[j][i]));
  },

  async drivingMatrix(points) {
    return this.drivingMatrixRect(points, points);
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
const OSM_UA = "Yarnball/0.1 (self-hosted travel planner)";

// ---------- 海外上游代理 ----------
// Node 的全局 fetch（undici）默认不读代理环境变量；海外上游（Photon / Nominatim / OSRM）
// 在本地代理后直连会被重置（read ECONNRESET）。这里按生态惯例读取
// https_proxy > all_proxy > http_proxy（大小写均认），并遵守 no_proxy；
// 未设置时返回 undefined（默认 dispatcher，直连），行为零变化。
// 国内高德（amapGet）绝不走这里，保持直连。

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
  return undefined;
}

const OVERSEAS_PROXY_URL = firstEnv(
  "https_proxy", "HTTPS_PROXY",
  "all_proxy", "ALL_PROXY",
  "http_proxy", "HTTP_PROXY",
);

const NO_PROXY_RULES = (firstEnv("no_proxy", "NO_PROXY") ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** no_proxy 匹配：支持 *、域名后缀（含可选前导点与端口） */
function bypassProxy(url: string | URL): boolean {
  if (NO_PROXY_RULES.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const rule of NO_PROXY_RULES) {
    if (rule === "*") return true;
    const host = rule.replace(/:\d+$/, "").replace(/^\./, "");
    if (!host) continue;
    if (hostname === host || hostname.endsWith(`.${host}`)) return true;
  }
  return false;
}

let overseasProxyAgent: ProxyAgent | null = null;

/** 目标 URL 应走的 dispatcher：命中代理规则时返回共享 ProxyAgent，否则 undefined（直连） */
function overseasDispatcher(url: string | URL): Dispatcher | undefined {
  if (!OVERSEAS_PROXY_URL || bypassProxy(url)) return undefined;
  overseasProxyAgent ??= new ProxyAgent(OVERSEAS_PROXY_URL);
  return overseasProxyAgent;
}

/**
 * 海外上游统一入口：带识别性 UA、超时，并按需挂代理 dispatcher。
 * 供全部零 key 海外上游共用（Photon / Nominatim / OSRM / Open-Meteo 天气 / transitous）。
 * ua 可覆盖：transitous 的 usage policy 要求 UA 带 app 名/版本/联系方式，用 TRANSITOUS_UA。
 */
export function overseasFetch(url: string | URL, timeoutMs = 15_000, ua: string = OSM_UA): Promise<Response> {
  // Node fetch 的 RequestInit 类型来自 undici-types，其 Dispatcher 与 undici 包自带的
  // Dispatcher 声明不完全相容（运行时同一套实现），这里显式断言。
  const init: RequestInit = {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: overseasDispatcher(url) as unknown as RequestInit["dispatcher"],
  };
  return fetch(url, init);
}

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
  const res = await overseasFetch(url);
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
  const res = await overseasFetch(url);
  if (!res.ok) throw new Error(`osrm http ${res.status}`);
  const body = (await res.json()) as { code: string; routes?: OsrmRoute[] };
  if (body.code !== "Ok" || !body.routes?.[0]) throw new Error(`osrm ${body.code}`);
  return body.routes[0];
}

// ---------- transitous（MOTIS 2，海外真实公交换乘路由，零 key） ----------
/**
 * transitous（https://api.transitous.org，MOTIS 2 社区实例，API v6）：全球 GTFS 聚合的
 * 真实公交换乘路由。usage policy 要求 UA 带 app 名/版本/联系方式（TRANSITOUS_UA），
 * 并在 UI 可见处署名 transitous.org（设置在「设置抽屉」底部数据源说明）。
 * best-effort 无 SLA：空 itineraries（无覆盖/无解）、超时、错误一律返回 null/抛出，
 * 由调用方降级 OSRM 估算（空结果不重试）。实测单次延迟 2-4s，走 GeoCache + 全局限流收口。
 */
const TRANSITOUS_BASE = "https://api.transitous.org/api/v6";
const TRANSITOUS_UA = `Yarnball/${pkg.version} (https://github.com/lucius/yarnball; self-hosted travel planner)`;

const transitousFetch = (url: string | URL, timeoutMs = 20_000) => overseasFetch(url, timeoutMs, TRANSITOUS_UA);

/** MOTIS 交通方式 → 内部交通段方式（transitous 命中时真实首段方式定 leg mode 的映射表）。
 *  注意悉尼 T 线/机场线是 REGIONAL_RAIL 不是 SUBWAY；未列出的方式（AIRPLANE/OTHER 等）归 transit。 */
const MOTIS_MODE_MAP: Record<string, TransportMode> = {
  SUBWAY: "metro",
  METRO: "metro",
  TRAM: "light_rail",
  BUS: "bus",
  COACH: "bus",
  SUBURBAN: "train",
  REGIONAL_RAIL: "train",
  REGIONAL_FAST_RAIL: "train",
  HIGHSPEED_RAIL: "train",
  LONG_DISTANCE: "train",
  NIGHT_RAIL: "train",
  FERRY: "ferry",
};

/** MOTIS 方式中文标签：填 TransitSegment.lineType（前端明细展示 + 轨交图标选型用） */
const MOTIS_MODE_LABEL: Record<string, string> = {
  SUBWAY: "地铁",
  METRO: "地铁",
  TRAM: "有轨电车",
  BUS: "公交",
  COACH: "长途巴士",
  SUBURBAN: "市郊铁路",
  REGIONAL_RAIL: "城际铁路",
  REGIONAL_FAST_RAIL: "城际铁路",
  HIGHSPEED_RAIL: "高铁",
  LONG_DISTANCE: "长途列车",
  NIGHT_RAIL: "夜间列车",
  FERRY: "渡轮",
};

/** Google polyline 解码（MOTIS legGeometry.points，precision 由响应携带，transitous 为 6）。自带实现，不引依赖。 */
function decodeGooglePolyline(encoded: string, precision: number): LngLat[] {
  const factor = 10 ** precision;
  const points: LngLat[] = [];
  let lat = 0;
  let lng = 0;
  let i = 0;
  while (i < encoded.length) {
    for (const coord of ["lat", "lng"] as const) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && i < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (coord === "lat") lat += delta;
      else lng += delta;
    }
    points.push({ lng: lng / factor, lat: lat / factor });
  }
  return points;
}

/** 折线总长（米）：MOTIS transit 段 distance 常为 null，从 legGeometry 折线长估算 */
function polylineLengthM(pts: LngLat[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
  return d;
}

/**
 * GTFS 数据瑕疵过滤：displayName/routeShortName 为纯数字内部 ID（≥5 位，如东京 GTFS
 * 的 7869271）时视为无线路名；真实线路号 ≤4 位（悉尼 333/100 这类保留）。
 * 按优先级取第一个通过过滤的名字。
 */
function saneLineName(...names: Array<string | null | undefined>): string | null {
  for (const n of names) {
    const t = n?.trim();
    if (!t || /^\d{5,}$/.test(t)) continue;
    return t;
  }
  return null;
}

/**
 * 行程日「当地 09:00」的 ISO 时间：MOTIS time 参数必须带时区偏移（naive 直接 400），
 * 无实时时区库，按经度 ÷ 15 四舍五入近似当地时区——只用于让查询落在白天班次形态
 * （早晚高峰/末班车差异），不承担精确时刻表职责。
 */
function transitQueryTime(date: string, lng: number): string {
  const offsetH = Math.max(-12, Math.min(12, Math.round(lng / 15)));
  const sign = offsetH < 0 ? "-" : "+";
  return `${date}T09:00:00${sign}${String(Math.abs(offsetH)).padStart(2, "0")}:00`;
}

interface MotisLeg {
  mode: string;
  distance: number | null;
  duration: number;
  routeShortName?: string | null;
  displayName?: string | null;
  headsign?: string | null;
  agencyName?: string | null;
  routeColor?: string | null;
  from?: { name?: string | null };
  to?: { name?: string | null };
  intermediateStops?: unknown[] | null;
  legGeometry?: { points?: string; precision?: number } | null;
}

/**
 * transitous 真实公交换乘：命中返回 RouteResult（mode = 首段真实 transit 方式映射，
 * transitDetail 为 walk/line 分段，polyline 为全段拼接）；无覆盖/无解/纯步行方案返回
 * null（调用方降级 OSRM 估算，空结果不重试）。date 为行程日（YYYY-MM-DD）。
 */
async function transitousPlan(from: LngLat, to: LngLat, date: string): Promise<RouteResult | null> {
  const url = new URL(`${TRANSITOUS_BASE}/plan`);
  url.searchParams.set("fromPlace", `${from.lat},${from.lng}`);
  url.searchParams.set("toPlace", `${to.lat},${to.lng}`);
  url.searchParams.set("time", transitQueryTime(date, (from.lng + to.lng) / 2));
  url.searchParams.set("numItineraries", "3");
  const res = await transitousFetch(url);
  if (!res.ok) throw new Error(`transitous http ${res.status}`);
  const body = (await res.json()) as { itineraries?: Array<{ duration: number; legs: MotisLeg[] }> };
  const itinerary = body.itineraries?.[0];
  if (!itinerary || itinerary.legs.length === 0) return null;

  const polyline: LngLat[] = [];
  const transitDetail: TransitSegment[] = [];
  let distanceM = 0;
  let firstTransitMode: TransportMode | null = null;
  for (const leg of itinerary.legs) {
    const pts = leg.legGeometry?.points
      ? decodeGooglePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6)
      : [];
    // transit 段 distance 常为 null：从 polyline 折线长估算
    const legDist = leg.distance ?? (pts.length > 1 ? Math.round(polylineLengthM(pts)) : null);
    if (leg.mode === "WALK") {
      // 步行接驳段：0 距离空段跳过（与 amap 侧口径一致）
      if ((legDist ?? 0) > 0) {
        transitDetail.push({
          kind: "walk",
          distanceM: legDist,
          durationS: leg.duration,
          lineName: null,
          lineType: null,
          boardStop: null,
          alightStop: null,
          viaStops: null,
        });
      }
    } else {
      const mapped = MOTIS_MODE_MAP[leg.mode] ?? "transit";
      firstTransitMode ??= mapped;
      transitDetail.push({
        kind: "line",
        distanceM: legDist,
        durationS: leg.duration,
        // GTFS 瑕疵过滤后无线路名时，退用运营商名（如「東京メトロ」）兜底展示
        lineName: saneLineName(leg.displayName, leg.routeShortName) ?? leg.agencyName?.trim() ?? null,
        lineType: MOTIS_MODE_LABEL[leg.mode] ?? leg.mode,
        boardStop: leg.from?.name?.trim() ?? null,
        alightStop: leg.to?.name?.trim() ?? null,
        viaStops: leg.intermediateStops?.length ?? null,
      });
    }
    polyline.push(...pts);
    distanceM += legDist ?? 0;
  }
  // 纯步行方案（两点太近）不算公交命中：让调用方走原方式分档
  if (!firstTransitMode) return null;
  return {
    mode: firstTransitMode,
    distanceM: distanceM > 0 ? distanceM : null,
    durationS: itinerary.duration,
    polyline: polyline.length > 0 ? polyline : null,
    transitDetail: transitDetail.length > 0 ? transitDetail : null,
  };
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
      const res = await overseasFetch(url);
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
      // 打出 cause（如 read ECONNRESET），便于诊断代理/网络问题
      console.warn("[geo] nominatim city search failed:", (err as Error).message, { cause: (err as Error).cause });
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

  async route(from, to, mode, _city, date) {
    // 渡轮：上游无轮渡路由，直线水域航线估算（两 provider 同口径）
    if (mode === "ferry") return ferryRouteEstimate(from, to);
    // 公交族走 transitous 时按行程日查班次，cache key 须含日期（跨天不同时刻方案可能不同）
    const dateKey = isTransitLikeMode(mode) && date ? `|${date}` : "";
    const cacheKey = `${mode}|${loc(from)}|${loc(to)}${dateKey}`;
    const cached = osmRouteCache.get(cacheKey);
    if (cached) return cached;

    if (isTransitLikeMode(mode)) {
      // 先试 transitous（MOTIS 2）真实公交换乘：命中返回真实方式（首段 transit leg 映射）/
      // 线路名/分段详情/真实里程；无覆盖（空 itineraries）、超时、错误一律降级到下面的
      // OSRM 估算（空结果不重试——无覆盖/无解的区域每次都返回空 itineraries，重试纯浪费 2-4s）
      if (date) {
        try {
          const real = await transitousPlan(from, to, date);
          if (real) {
            osmRouteCache.set(cacheKey, real);
            return real;
          }
        } catch (err) {
          console.warn("[geo] transitous 失败，降级 OSRM 公交估算:", (err as Error).message);
        }
      }
      // transitous 未命中/未传日期：真实 car 路线（OSRM）时长 × 1.25 + 6 分钟换乘惩罚作为估算；
      // 里程/路径也取 car 真实路由（近似公交走向），result.mode 保留请求的子类型供展示。
      // 用真实 car 里程而非直线：跨水场景绕行比（路由 ÷ 直线）是 recalcDayLegs 判渡轮的输入
      const route = await osrmRouteRequest(OSRM_CAR, "driving", from, to);
      const result: RouteResult = {
        mode,
        distanceM: Math.round(route.distance),
        durationS: Math.round(route.duration * 1.25 + 360),
        polyline: route.geometry.coordinates.map(([lng, lat]) => ({ lng, lat })),
      };
      osmRouteCache.set(cacheKey, result);
      return result;
    }

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

  async drivingMatrixRect(sources, destinations) {
    if (sources.length === 0 || destinations.length === 0) return null;
    // OSRM table 支持 sources/destinations 下标参数做矩形表：URL 里放 sources+destinations 全部坐标，
    // 只算 sources × destinations 子块（分批拼接的基础，避免方阵点数翻倍）
    const all = [...sources, ...destinations];
    if (all.length > 100) return null; // demo 服表大小上限，分批由 drivingMatrixBatched 负责
    const srcIdx = sources.map((_, i) => i).join(";");
    const dstIdx = destinations.map((_, j) => sources.length + j).join(";");
    const url =
      `${OSRM_CAR}/table/v1/driving/${all.map(loc).join(";")}` +
      `?annotations=duration&sources=${srcIdx}&destinations=${dstIdx}`;
    const res = await overseasFetch(url, 20_000);
    if (!res.ok) throw new Error(`osrm table http ${res.status}`);
    const body = (await res.json()) as { code: string; durations?: (number | null)[][] };
    if (body.code !== "Ok" || !body.durations) throw new Error(`osrm table ${body.code}`);
    // 不可达对为 null，转 NaN 与调用方（routing.ts 的 isFinite 判洞）口径一致
    return body.durations.map((row) => row.map((v) => (v == null ? Number.NaN : v)));
  },

  async drivingMatrix(points) {
    if (points.length === 0) return null;
    if (points.length === 1) return [[0]]; // 单点方阵恒 0（与 amap 侧同构，避免单点块被当失败）
    return this.drivingMatrixRect(points, points);
  },
};

// ---------- 矩阵分批拼接 ----------

/** 单次上游矩阵调用的最大点数（分批粒度）：与 OSRM demo 服稳定区间/原 n≤10 上限对齐 */
const MATRIX_BATCH = 10;

/**
 * 驾车时长矩阵（任意点数）：n ≤ MATRIX_BATCH 时单次调用；更大时把点切成 ≤MATRIX_BATCH 的块，
 * 按（源块 × 讫块）分批调 drivingMatrixRect 再拼回完整方阵——替代旧的「n>10 静默降级直线估算」。
 * 结果按点集缓存（跟随 RouteCache 模式）：重排/聚类反复求同一批点时不重复打上游。
 * 任一批失败 → 返回 null，由调用方整体降级直线估算并在结果里标注 estimated（不再静默）。
 */
export async function drivingMatrixBatched(
  provider: GeoProvider,
  points: LngLat[],
  limit: <T>(task: () => Promise<T>) => Promise<T> = (task) => task(),
): Promise<number[][] | null> {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [[0]];
  const cache = provider.name === "amap" ? amapMatrixCache : osmMatrixCache;
  const cacheKey = points.map(loc).join(";");
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // 切分块
  const chunks: LngLat[][] = [];
  for (let i = 0; i < n; i += MATRIX_BATCH) chunks.push(points.slice(i, i + MATRIX_BATCH));

  // 逐（源块 × 讫块）请求；对角块走方阵 drivingMatrix（两 provider 的现有入口），其余走矩形接口。
  // 单点对角块（n ≡ 1 (mod MATRIX_BATCH) 时的末块）短路为 [[0]]：自身到自身恒 0，且 osm.drivingMatrix
  // 对 <2 点返回 null——不短路会让整块矩阵静默降级为直线估算
  const blocks: (number[][] | null)[][] = await Promise.all(
    chunks.map((src) =>
      Promise.all(
        chunks.map((dst) => {
          if (src === dst && src.length === 1) return Promise.resolve([[0]]);
          return limit(() =>
            src === dst ? provider.drivingMatrix(src) : provider.drivingMatrixRect(src, dst),
          );
        }),
      ),
    ),
  );
  if (blocks.some((row) => row.some((b) => b == null))) return null;

  // 拼接回 n×n
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(Number.NaN));
  let rowBase = 0;
  for (let bi = 0; bi < chunks.length; bi++) {
    let colBase = 0;
    for (let bj = 0; bj < chunks.length; bj++) {
      const block = blocks[bi][bj]!;
      for (let i = 0; i < chunks[bi].length; i++) {
        for (let j = 0; j < chunks[bj].length; j++) {
          matrix[rowBase + i][colBase + j] = block[i][j];
        }
      }
      colBase += chunks[bj].length;
    }
    rowBase += chunks[bi].length;
  }
  for (let i = 0; i < n; i++) matrix[i][i] = 0; // 对角线恒 0（上游对自身对有时给 NaN）
  cache.set(cacheKey, matrix);
  return matrix;
}
