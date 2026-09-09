import { formatDistance, formatDuration, type TransportLegDto } from "@yarnball/shared";

/**
 * 公交段详情（M78 展示层）——M77（agent-transit-detail）数据契约的本地镜像。
 * shared 包的 TransportLegDto.transitDetail 字段由 M77 落地；其合入前这里按
 * 协调结构本地定义，访问走宽松可选链，无详情（osm 估算 / 旧数据 / 非公交段）
 * 时返回 null，调用处回退原有「时长 + 距离」展示。
 */

/** 公交分段 · 步行接驳段（两端站点/地点名为自由文本，可空） */
export interface TransitWalkSegment {
  kind: "walk";
  distanceM: number | null;
  durationS: number | null;
  fromName: string | null;
  toName: string | null;
}

/** 公交分段 · 线路乘坐段 */
export interface TransitLineSegment {
  kind: "line";
  /** 线路名，如「地铁2号线」「公交25路」 */
  lineName: string;
  /** 车型文本（「地铁」/「公交」等），用于图标选型；可空 */
  vehicleType: string | null;
  fromStop: string;
  toStop: string;
  /** 途经站数（含到达站），可空 */
  stopCount: number | null;
  durationS: number | null;
  distanceM: number | null;
}

export type TransitSegment = TransitWalkSegment | TransitLineSegment;

/** 一条 transit 交通段的公交详情：有序分段数组（步行/线路交替） */
export interface TransitLegDetail {
  segments: TransitSegment[];
}

/**
 * 从交通段取公交详情。字段缺失、segments 为空（osm 估算降级、旧数据、
 * 手动覆盖成 walk/drive 后重算等）一律返回 null。
 */
export function transitDetailOf(leg: TransportLegDto): TransitLegDetail | null {
  const raw = (leg as TransportLegDto & { transitDetail?: TransitLegDetail | null }).transitDetail;
  if (!raw || !Array.isArray(raw.segments) || raw.segments.length === 0) return null;
  return raw;
}

/** 主行概要里的分段数文案：「· 2 段」 */
export function transitSegmentCountText(detail: TransitLegDetail): string {
  return `· ${detail.segments.length} 段`;
}

/** 步行接驳段明细文案：「步行 300 米 · 至 西二旗站」；讫点缺失时退起点名，皆缺只给距离/时长 */
export function walkSegmentText(seg: TransitWalkSegment): string {
  const parts = ["步行"];
  if (seg.distanceM != null) parts.push(formatDistance(seg.distanceM));
  if (seg.durationS != null) parts.push(formatDuration(seg.durationS));
  if (seg.toName) parts.push(`至 ${seg.toName}`);
  else if (seg.fromName) parts.push(`自 ${seg.fromName}`);
  return parts.join(" ");
}

/** 线路乘坐段明细文案：「地铁2号线 西二旗 → 东直门 · 4 站 · 18 分钟」 */
export function lineSegmentText(seg: TransitLineSegment): string {
  const parts = [seg.lineName];
  if (seg.fromStop && seg.toStop) parts.push(`${seg.fromStop} → ${seg.toStop}`);
  else if (seg.fromStop || seg.toStop) parts.push(seg.fromStop || seg.toStop);
  if (seg.stopCount != null) parts.push(`${seg.stopCount} 站`);
  if (seg.durationS != null) parts.push(formatDuration(seg.durationS));
  return parts.join(" ");
}

/** 线路段是否轨交（地铁/轻轨），用于图标选型 */
export function isRailSegment(seg: TransitLineSegment): boolean {
  const text = `${seg.vehicleType ?? ""}${seg.lineName}`;
  return /地铁|轻轨|subway|metro/i.test(text);
}
