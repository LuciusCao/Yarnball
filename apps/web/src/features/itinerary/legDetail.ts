import { formatDistance, formatDuration, type TransportLegDto } from "@yarnball/shared";

/**
 * 公交段详情（M78 展示层）——M77（agent-transit-detail）定稿契约的本地镜像。
 * shared 包的 TransportLegDto.transitDetail 字段由 M77 落地（平铺数组，单 jsonb 列）；
 * 其合入前这里按定稿结构本地定义，访问走宽松可选链，无详情（osm 估算 / 路由降级 /
 * walk·drive 段 / 旧数据）时返回 null，调用处回退原有「时长 + 距离」展示。
 *
 * walk 段不带起讫点名（高德 walking 段只回坐标/距离/时长）：首段 walk 的讫点 =
 * 后邻 line 段的 boardStop，末段 walk 的起点 = 前邻 line 段的 alightStop，
 * 展示时由 segmentText 按邻接关系推导。
 */

/** 公交分段（平铺，按乘坐顺序）：kind=walk 时 line* / boardStop / alightStop / viaStops 恒 null */
export interface TransitSegment {
  kind: "walk" | "line";
  /** 该分段里程（米） */
  distanceM: number | null;
  /** 该分段时长（秒） */
  durationS: number | null;
  /** 线路名原文，如「地铁2号线(内环)」「45路(...)」（仅 line） */
  lineName: string | null;
  /** 高德类型原文，如「地铁线路」「普通公交线路」（仅 line；用于图标选型） */
  lineType: string | null;
  /** 上车站（仅 line） */
  boardStop: string | null;
  /** 下车站（仅 line） */
  alightStop: string | null;
  /** 途经站数（仅 line） */
  viaStops: number | null;
}

/**
 * 从交通段取公交详情（平铺分段数组）。字段缺失或为空数组一律返回 null。
 */
export function transitDetailOf(leg: TransportLegDto): TransitSegment[] | null {
  const raw = (leg as TransportLegDto & { transitDetail?: TransitSegment[] | null }).transitDetail;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw;
}

/** 主行概要里的分段数文案：「· 2 段」 */
export function transitSegmentCountText(segmentCount: number): string {
  return `· ${segmentCount} 段`;
}

/**
 * 步行接驳段明细文案：「步行 300 米 · 至 西二旗站」。
 * 起讫名按邻接 line 段推导：后邻 line → 「至 boardStop」；否则前邻 line → 「自 alightStop」；
 * 皆无（纯步行段，理论上 mode 不会是 transit）只给距离/时长。
 */
export function walkSegmentText(
  seg: TransitSegment,
  prev: TransitSegment | null,
  next: TransitSegment | null,
): string {
  const parts = ["步行"];
  if (seg.distanceM != null) parts.push(formatDistance(seg.distanceM));
  if (seg.durationS != null) parts.push(formatDuration(seg.durationS));
  const board = next?.kind === "line" ? next.boardStop : null;
  const alight = prev?.kind === "line" ? prev.alightStop : null;
  if (board) parts.push(`至 ${board}`);
  else if (alight) parts.push(`自 ${alight}`);
  return parts.join(" ");
}

/** 线路乘坐段明细文案：「地铁2号线 西二旗 → 东直门 · 4 站 · 18 分钟」 */
export function lineSegmentText(seg: TransitSegment): string {
  const parts = [seg.lineName ?? "公交线路"];
  if (seg.boardStop && seg.alightStop) parts.push(`${seg.boardStop} → ${seg.alightStop}`);
  else if (seg.boardStop ?? seg.alightStop) parts.push((seg.boardStop ?? seg.alightStop)!);
  if (seg.viaStops != null) parts.push(`${seg.viaStops} 站`);
  if (seg.durationS != null) parts.push(formatDuration(seg.durationS));
  return parts.join(" ");
}

/** 线路段是否轨交（地铁/轻轨），用于图标选型 */
export function isRailSegment(seg: TransitSegment): boolean {
  return /地铁|轻轨|subway|metro/i.test(`${seg.lineType ?? ""}${seg.lineName ?? ""}`);
}
