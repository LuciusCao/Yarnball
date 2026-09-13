import type {
  DayWeather,
  TripBundle,
  TripWeather,
  WeatherForecast,
} from "@yarnball/shared";
import { overseasFetch } from "./geo.js";

/**
 * 行程天气（Open-Meteo，免费无 key，全球覆盖）。
 * 按 trip 的真实日期（startDate + dayIndex 推导）逐天返回预报：
 * 温度区间 / 降水 / 最大风速 / 晴雨标签。预报仅未来约 16 天可信，
 * 超窗日期显式 available=false + reason，不编造。
 *
 * 坐标系说明：国内行程坐标为 GCJ-02（高德系），与 WGS84 偏移通常 ≤600m；
 * Open-Meteo 预报网格约 0.1°（≈11km），偏移远小于网格尺度，直接查询不转换。
 * Open-Meteo 是海外上游：统一走 geo.ts 的 overseasFetch（遵守 https_proxy 等代理约定）。
 */

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
/** Open-Meteo 免费预报的可信窗口：自今天起 16 天（含今天） */
const FORECAST_HORIZON_DAYS = 16;
/** 单次拉取的日期范围上限（防超长日期区间打出超大请求） */
const MAX_RANGE_DAYS = 31;
/** 内存短缓存 TTL：预报本身小时级更新，30 分钟足够新鲜 */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** WMO Weather interpretation codes → 中文标签（Open-Meteo weather_code） */
const WMO_LABELS: Record<number, string> = {
  0: "晴",
  1: "大部晴朗",
  2: "多云间晴",
  3: "阴",
  45: "雾",
  48: "冻雾",
  51: "毛毛雨",
  53: "毛毛雨",
  55: "毛毛雨",
  56: "冻毛毛雨",
  57: "冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "阵雪",
  86: "阵雪",
  95: "雷暴",
  96: "雷暴伴冰雹",
  99: "雷暴伴冰雹",
};

interface OpenMeteoDaily {
  time: string[];
  weather_code: number[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_sum: number[];
  wind_speed_10m_max: number[];
}

interface CachedForecast {
  at: number;
  daily: OpenMeteoDaily;
}

/** 按「坐标（≈1km 网格）+ 日期范围」缓存的内存短缓存 */
const forecastCache = new Map<string, CachedForecast>();

/** YYYY-MM-DD + n 天（本地时区构造，与 formatDayLabel 同口径，避免 UTC 串天） */
function addDays(date: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function todayLocal(): string {
  return localDateString(new Date());
}

function localDateString(d: Date): string {
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 拉某个坐标点一段日期范围的逐日预报（带缓存）；失败抛错由调用方整体降级 */
async function fetchForecast(
  coord: { lng: number; lat: number },
  startDate: string,
  endDate: string,
): Promise<OpenMeteoDaily> {
  // 约 1km 网格归一化：同一城市内不同天锚点（景点质心略有差异）复用同一次上游调用
  const key = `${coord.lng.toFixed(2)},${coord.lat.toFixed(2)}|${startDate}|${endDate}`;
  const cached = forecastCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.daily;

  const url = new URL(OPEN_METEO_BASE);
  url.searchParams.set("latitude", coord.lat.toFixed(4));
  url.searchParams.set("longitude", coord.lng.toFixed(4));
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  const res = await overseasFetch(url);
  if (!res.ok) throw new Error(`open-meteo http ${res.status}`);
  const body = (await res.json()) as { daily?: OpenMeteoDaily };
  if (!body.daily?.time?.length) throw new Error("open-meteo: empty daily");
  // 简易容量控制：缓存无界增长不现实（单进程行程数有限），超 500 条清空重建
  if (forecastCache.size > 500) forecastCache.clear();
  forecastCache.set(key, { at: Date.now(), daily: body.daily });
  return body.daily;
}

/** 某天的预报锚点：有排程地点时取当日地点质心（人实际所在），否则主目的地中心 */
function dayAnchor(
  bundle: TripBundle,
  dayIndex: number | null,
): { coord: { lng: number; lat: number }; name: string | null } | null {
  const { trip, days, entries, places } = bundle;
  if (dayIndex != null) {
    const day = days.find((d) => d.dayIndex === dayIndex);
    if (day) {
      const dayEntries = entries
        .filter((e) => e.dayId === day.id && e.placeId)
        .sort((a, b) => a.position - b.position);
      const dayPlaces = dayEntries
        .map((e) => places.find((p) => p.id === e.placeId))
        .filter((p): p is NonNullable<typeof p> => p != null);
      if (dayPlaces.length > 0) {
        const coord = {
          lng: dayPlaces.reduce((s, p) => s + p.location.lng, 0) / dayPlaces.length,
          lat: dayPlaces.reduce((s, p) => s + p.location.lat, 0) / dayPlaces.length,
        };
        // 锚点名取当日地点的多数派归属城市，其次最近的途经地名
        const counts = new Map<string, number>();
        for (const p of dayPlaces) {
          if (p.cityName) counts.set(p.cityName, (counts.get(p.cityName) ?? 0) + 1);
        }
        const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        return { coord, name: majority ?? nearestStopName(bundle, coord) };
      }
    }
  }
  const first = trip.stops[0];
  if (first?.center) return { coord: first.center, name: first.name };
  return trip.location ? { coord: trip.location, name: trip.destinationCity } : null;
}

function nearestStopName(bundle: TripBundle, coord: { lng: number; lat: number }): string | null {
  let best: { name: string; d: number } | null = null;
  for (const stop of bundle.trip.stops) {
    if (!stop.center) continue;
    const d = (stop.center.lng - coord.lng) ** 2 + (stop.center.lat - coord.lat) ** 2;
    if (!best || d < best.d) best = { name: stop.name, d };
  }
  return best?.name ?? null;
}

/**
 * 行程天气预报：日期范围 = startDate .. endDate（未设 endDate 时按已建天数推算，至少覆盖已建天）。
 * 未设 startDate → 返回空 days + note（无法对齐真实日期）。
 * 上游整体故障 → 抛出由调用方转 502；单日缺数据 → 该天 available=false（不拖垮整包）。
 */
export async function getTripWeather(bundle: TripBundle): Promise<TripWeather> {
  const { trip } = bundle;
  const generatedAt = new Date().toISOString();
  if (!trip.startDate) {
    return { generatedAt, days: [], note: "行程未设置出发日期，无法按天拉取天气预报。" };
  }
  const maxDayIndex = bundle.days.reduce((m, d) => Math.max(m, d.dayIndex), 0);
  let rangeDays = maxDayIndex;
  let truncated = false;
  if (trip.endDate && trip.endDate >= trip.startDate) {
    // 日期区间长度（含两端）
    let n = 1;
    while (addDays(trip.startDate, n - 1) < trip.endDate && n < 400) n++;
    rangeDays = Math.max(rangeDays, n);
  }
  if (rangeDays === 0) rangeDays = 1;
  if (rangeDays > MAX_RANGE_DAYS) {
    rangeDays = MAX_RANGE_DAYS;
    truncated = true;
  }
  const startDate = trip.startDate;
  const endDate = addDays(startDate, rangeDays - 1);
  const today = todayLocal();
  const horizonEnd = addDays(today, FORECAST_HORIZON_DAYS - 1);

  // 按锚点坐标分组，一次调用拉全范围
  const dates: { date: string; dayIndex: number | null }[] = [];
  for (let i = 0; i < rangeDays; i++) {
    const dayIndex = i + 1 <= maxDayIndex ? i + 1 : null;
    dates.push({ date: addDays(startDate, i), dayIndex });
  }
  const byCoord = new Map<string, { coord: { lng: number; lat: number }; name: string | null }>();
  const anchors = dates.map((d) => {
    const anchor = dayAnchor(bundle, d.dayIndex);
    if (anchor) {
      const key = `${anchor.coord.lng.toFixed(2)},${anchor.coord.lat.toFixed(2)}`;
      if (!byCoord.has(key)) byCoord.set(key, anchor);
    }
    return anchor;
  });

  const forecasts = new Map<string, OpenMeteoDaily | null>();
  // 整个日期范围都在预报窗口外（全部超窗或全部已过）时直接跳过上游调用，
  // 逐天走下面 available=false + reason 的口径，不白打 Open-Meteo
  const anyInWindow = dates.some((d) => d.date >= today && d.date <= horizonEnd);
  if (anyInWindow) {
    await Promise.all(
      [...byCoord.entries()].map(async ([key, anchor]) => {
        try {
          forecasts.set(key, await fetchForecast(anchor.coord, startDate, endDate));
        } catch (err) {
          console.warn(`[weather] open-meteo 拉取失败（${key}）:`, (err as Error).message);
          forecasts.set(key, null);
        }
      }),
    );
  }

  const days: DayWeather[] = dates.map((d, i) => {
    const anchor = anchors[i];
    const base = {
      date: d.date,
      dayIndex: d.dayIndex,
      anchorName: anchor?.name ?? null,
    };
    if (!anchor) {
      return { ...base, available: false, reason: "行程目的地坐标缺失，无法查询天气", forecast: null };
    }
    if (d.date < today) {
      return { ...base, available: false, reason: "日期已过，无预报", forecast: null };
    }
    if (d.date > horizonEnd) {
      return { ...base, available: false, reason: `超出 ${FORECAST_HORIZON_DAYS} 天预报期`, forecast: null };
    }
    const key = `${anchor.coord.lng.toFixed(2)},${anchor.coord.lat.toFixed(2)}`;
    const daily = forecasts.get(key);
    if (!daily) {
      return { ...base, available: false, reason: "天气服务暂不可用", forecast: null };
    }
    const idx = daily.time.indexOf(d.date);
    if (idx < 0) {
      return { ...base, available: false, reason: "上游无该日数据", forecast: null };
    }
    const forecast: WeatherForecast = {
      tempMinC: daily.temperature_2m_min[idx],
      tempMaxC: daily.temperature_2m_max[idx],
      precipitationMm: daily.precipitation_sum[idx],
      windMaxKmh: daily.wind_speed_10m_max[idx],
      weatherCode: daily.weather_code[idx],
      weatherLabel: WMO_LABELS[daily.weather_code[idx]] ?? `未知(${daily.weather_code[idx]})`,
    };
    return { ...base, available: true, forecast };
  });

  return {
    generatedAt,
    days,
    note: truncated ? `日期范围过长，仅返回前 ${MAX_RANGE_DAYS} 天。` : undefined,
  };
}
