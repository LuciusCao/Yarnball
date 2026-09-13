import type { TransportLegDto } from "@yarnball/shared";
import type { TimelineItem } from "./timeline";

/**
 * 每日强度标签推导（M102，issue #6）：纯前端从 bundle 时间轴/交通段推导，不落库。
 * 信号：当天时间跨度（首个 entry 开始 → 末个 entry 结束，含推算值）、地点数、
 * legs 交通总时长与步行距离、大交通移动日减负。
 * 档位：轻松 < 5h ≤ 休闲 < 7h ≤ 适中 < 9h ≤ 紧凑 < 10.5h ≤ 暴走（边界值归高一档）；
 * 修正：地点 ≥8 个升一档，含大交通 entry（城际/抵离移动日）降一档。
 * 跨度 >10h 另给超标提示（warning），与档位相互独立。
 * 单点推导风格同 stops.ts：面板（ItineraryPanel）与导出（ExportPrintSheet）共用本函数。
 */

export const INTENSITY_LEVELS = ["relaxed", "leisure", "moderate", "tight", "rush"] as const;
export type IntensityLevel = (typeof INTENSITY_LEVELS)[number];

/** 档位文案 + 天标题栏标签配色（Tailwind 类，导出打印稿不用） */
export const INTENSITY_META: Record<IntensityLevel, { label: string; chipClass: string }> = {
  relaxed: { label: "轻松", chipClass: "bg-emerald-500/12 text-emerald-700" },
  leisure: { label: "休闲", chipClass: "bg-teal-500/12 text-teal-700" },
  moderate: { label: "适中", chipClass: "bg-sky-500/12 text-sky-700" },
  tight: { label: "紧凑", chipClass: "bg-amber-500/15 text-amber-700" },
  rush: { label: "暴走", chipClass: "bg-red-500/12 text-red-700" },
};

export interface DayIntensity {
  level: IntensityLevel;
  /** 档位中文名（轻松/休闲/适中/紧凑/暴走） */
  label: string;
  /** 一句话说明，如「全天约 8 小时 · 5 个地点 · 步行 6.2km」 */
  detail: string;
  /** 超标提示（全天跨度 >10h），无则 null */
  warning: string | null;
  /** 全天跨度（分钟）；当天无 entry 时为 0 */
  spanMin: number;
  /** 步行段合计距离（米） */
  walkM: number;
}

/** 档位阈值上限（分钟）：span < 阈值即落入该档（边界值归高一档，与头注释口径一致）；超过最后一档阈值 = 暴走 */
const LEVEL_CAP_MIN: Record<Exclude<IntensityLevel, "rush">, number> = {
  relaxed: 5 * 60,
  leisure: 7 * 60,
  moderate: 9 * 60,
  tight: 10.5 * 60,
};

/** 超标提示阈值：全天跨度超过 10 小时 */
const OVERLOAD_MIN = 10 * 60;
/** 地点数升档阈值 */
const MANY_PLACES = 8;

export function deriveDayIntensity({
  timeline,
  dayLegs,
}: {
  /** buildDayTimeline 的结果（已按 position 排序，含大交通 entry） */
  timeline: TimelineItem[];
  /** 当天全部交通段（含大交通 ride leg 与酒店锚定段） */
  dayLegs: TransportLegDto[];
}): DayIntensity {
  const placeCount = timeline.filter((t) => !t.transit).length;
  const spanMin =
    timeline.length > 0 ? timeline[timeline.length - 1].endMin - timeline[0].startMin : 0;
  // 市内交通合计：排除大交通 ride leg（fromEntryId==toEntryId 的自环，其时长已含在跨度里）
  const cityLegs = dayLegs.filter((l) => l.fromEntryId !== l.toEntryId);
  const legMin = Math.round(
    cityLegs.reduce((acc, l) => acc + (l.durationS ?? 0), 0) / 60,
  );
  const walkM = cityLegs
    .filter((l) => l.mode === "walk")
    .reduce((acc, l) => acc + (l.distanceM ?? 0), 0);
  const movingDay = timeline.some((t) => t.transit);

  let idx: number;
  if (timeline.length === 0 || spanMin < LEVEL_CAP_MIN.relaxed) idx = 0;
  else if (spanMin < LEVEL_CAP_MIN.leisure) idx = 1;
  else if (spanMin < LEVEL_CAP_MIN.moderate) idx = 2;
  else if (spanMin < LEVEL_CAP_MIN.tight) idx = 3;
  else idx = 4;
  // 修正：地点特别多升一档；移动日（含大交通抵离/城际）降一档减负
  if (placeCount >= MANY_PLACES) idx = Math.min(idx + 1, INTENSITY_LEVELS.length - 1);
  if (movingDay && timeline.length > 0) idx = Math.max(idx - 1, 0);

  const level = INTENSITY_LEVELS[idx];
  const hours = Math.round(spanMin / 30) / 2;
  const parts: string[] = [];
  if (timeline.length === 0) {
    parts.push("当天暂无安排");
  } else {
    parts.push(`全天约 ${hours} 小时`);
    if (placeCount > 0) parts.push(`${placeCount} 个地点`);
    if (legMin >= 30) parts.push(`交通约 ${Math.round(legMin / 30) / 2} 小时`);
    if (walkM >= 100) parts.push(`步行 ${(walkM / 1000).toFixed(1)}km`);
    if (movingDay) parts.push("含大交通移动");
  }
  return {
    level,
    label: INTENSITY_META[level].label,
    detail: parts.join(" · "),
    warning:
      spanMin > OVERLOAD_MIN ? "超过 10 小时，行程偏满，注意体力与返程时间" : null,
    spanMin,
    walkM,
  };
}
