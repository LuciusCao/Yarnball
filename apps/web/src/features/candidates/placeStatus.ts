import type { PlaceDto } from "@yarnball/shared";

/**
 * 地点状态机 —— 与 M1（feat/agent-mcp）在 packages/shared 定义的 PLACE_STATUSES 对齐：
 * candidate（候选池，agent 推荐的默认值）→ locked（用户在界面锁定 = 确认要去）。
 * M1 合并前 shared 尚无 PlaceDto.status，这里本地定义 + 读取兜底；
 * M1 合并后本文件可整体替换为 `import { PLACE_STATUSES, type PlaceStatus } from "@yarnball/shared"`。
 */

export const PLACE_STATUSES = ["candidate", "locked"] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

/** 读取地点状态：旧服务端不下发 status 字段时按 candidate 兜底（未锁定） */
export function getPlaceStatus(place: PlaceDto): PlaceStatus {
  const status = (place as PlaceDto & { status?: unknown }).status;
  return status === "locked" ? "locked" : "candidate";
}
