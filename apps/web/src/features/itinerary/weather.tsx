import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Cloudy,
  Sun,
  type LucideIcon,
} from "lucide-react";
import type { DayWeather } from "@yarnball/shared";
import { api as libApi } from "../../lib/api";

/**
 * 天气（M102，issue #5）：GET /api/trips/:tripId/weather 的前端消费层。
 * 数据是动态的（Open-Meteo 预报随时间变），不进 zustand bundle——react-query 按 tripId
 * 缓存，打开行程页/分享页挂载行程面板时自动拉取并定期刷新；服务端另有 30min 内存缓存兜底。
 * 行程面板（TripPage/SharePage）与导出弹层（ExportPrintDialog）共用同一 queryKey，只发一次请求。
 */

/** 行程天气查询：staleTime 10min（预报粒度是天，高频刷新无意义）；失败重试 1 次后按「不可用」降级 */
export function useTripWeather(tripId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["trip-weather", tripId],
    queryFn: () => libApi.getTripWeather(tripId!).then((r) => r.weather),
    enabled: enabled && tripId != null,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}

/** WMO weather_code → 图标（0 晴 / 1-2 多云间晴 / 3 阴 / 45,48 雾 / 5x-6x,8x 雨 / 7x,85-86 雪 / 95+ 雷暴） */
function weatherIcon(code: number): LucideIcon {
  if (code === 0) return Sun;
  if (code <= 2) return CloudSun;
  if (code === 3) return Cloudy;
  if (code === 45 || code === 48) return CloudFog;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return CloudRain;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return CloudSnow;
  if (code >= 95) return CloudLightning;
  return Cloud;
}

/**
 * 天标题栏天气徽章：icon + 温度区间；点击展开详情卡（晴雨/降水/风力/预报基准地）。
 * - dayWeather undefined（查询中/失败）或 null（该天不在天气响应里，如未设出发日期）：不渲染；
 * - available=false（超 16 天预报窗 / 日期已过）：灰色「暂无预报」hint，title 带服务端 reason。
 */
export function DayWeatherBadge({ dayWeather }: { dayWeather: DayWeather | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!dayWeather) return null;

  if (!dayWeather.available || !dayWeather.forecast) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-slate-900/6 px-1.5 py-0.5 text-[10px] text-slate-400"
        title={dayWeather.reason ?? "暂无天气预报"}
      >
        <Cloud className="size-3" />
        暂无预报
      </span>
    );
  }

  const f = dayWeather.forecast;
  const Icon = weatherIcon(f.weatherCode);
  return (
    <span className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${f.weatherLabel} ${Math.round(f.tempMinC)}–${Math.round(f.tempMaxC)}°C（点击查看详情）`}
        aria-expanded={open}
        className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
          open ? "bg-sky-500/15 text-sky-700" : "bg-slate-900/6 text-slate-500 hover:bg-slate-900/12"
        }`}
      >
        <Icon className="size-3" />
        {Math.round(f.tempMinC)}–{Math.round(f.tempMaxC)}°
      </button>
      {open && (
        <span className="absolute left-0 top-full z-20 mt-1 block w-48 rounded-lg border border-slate-900/10 bg-white/95 p-2 text-[11px] leading-relaxed text-slate-600 shadow-lg backdrop-blur">
          <span className="flex items-center gap-1 font-medium text-slate-700">
            <Icon className="size-3.5" />
            {f.weatherLabel} · {Math.round(f.tempMinC)}–{Math.round(f.tempMaxC)}°C
          </span>
          <span className="mt-0.5 block">
            降水 {f.precipitationMm}mm · 最大风速 {Math.round(f.windMaxKmh)}km/h
          </span>
          {dayWeather.anchorName && (
            <span className="mt-0.5 block text-slate-400">预报基准：{dayWeather.anchorName}</span>
          )}
          <span className="mt-0.5 block text-slate-300">Open-Meteo 预报，出行前请再确认</span>
        </span>
      )}
    </span>
  );
}
