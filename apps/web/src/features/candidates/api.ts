/**
 * 候选池写操作补充 —— 契约单点在 ../../lib/api.ts：
 * 加入/移出行程（setPlaceStatus，底层 locked 状态）、多酒店加入/移出（selectHotel/unselectHotel）、
 * M11 的 updateEntry / updatePlace（bookingStatus/openingHours）/ suggestDayClusters 都在那里；
 * 这里只保留 lib/api 尚未覆盖的删除/移出端点。
 */

import type { UnschedulePlaceResult } from "@yarnball/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const candidatesApi = {
  /** 删除地点（DELETE /api/places/:id；服务端级联移除日程 entry 并解除选定酒店引用） */
  deletePlace: (placeId: string) =>
    request<{ ok: true }>(`/places/${placeId}`, { method: "DELETE" }),
  /** 移出行程（POST /api/places/:id/unschedule，M20）：撤销全部日程 entry，地点退回候选态 */
  unschedulePlace: (placeId: string) =>
    request<UnschedulePlaceResult>(`/places/${placeId}/unschedule`, { method: "POST" }),
};
