/**
 * 候选池写操作补充 —— M1 契约单点在 ../../lib/api.ts：
 * 锁定/解锁（setPlaceStatus）已切到那里；这里只保留 lib/api 尚未覆盖的删除端点。
 *
 * 多酒店入住区间（M9 契约已广播确认）：
 * - POST /api/trips/:tripId/select-hotel  body { candidateId, checkInDay?, checkOutDay? }
 *   → { ok, checkInDay?, checkOutDay? }（返回最终生效区间；缺省天区间时服务端建议最长未覆盖段）
 * - POST /api/trips/:tripId/unselect-hotel body { candidateId } → { ok }
 * - 区间重叠 / 超出行程天数 → 422
 * M9 合并后 lib/api.ts 会有 api.selectHotel / api.unselectHotel 正式方法
 * （当前分支里还没有，lib/api.ts 属 M9 范围），届时这里删除、调用方改走 lib/api.ts 单点。
 */

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

import type { HotelStayRange } from "./hotelStays";

export const candidatesApi = {
  /** 删除地点（DELETE /api/places/:id；服务端级联移除日程 entry 并解除选定酒店引用） */
  deletePlace: (placeId: string) =>
    request<{ ok: true }>(`/places/${placeId}`, { method: "DELETE" }),

  // ---------- 多酒店入住区间（M9 契约前瞻，见文件头注释） ----------

  /** 选定酒店并指定入离店天（POST /api/trips/:tripId/select-hotel 带天区间） */
  selectHotelStay: (tripId: string, candidateId: string, range: HotelStayRange) =>
    request<{ ok: true; checkInDay?: number; checkOutDay?: number }>(
      `/trips/${tripId}/select-hotel`,
      {
        method: "POST",
        body: JSON.stringify({ candidateId, ...range }),
      },
    ),

  /** 取消选定某家酒店（POST /api/trips/:tripId/unselect-hotel） */
  unselectHotelStay: (tripId: string, candidateId: string) =>
    request<{ ok: true }>(`/trips/${tripId}/unselect-hotel`, {
      method: "POST",
      body: JSON.stringify({ candidateId }),
    }),

  /** 修改已选定酒店的入离店天（重选即改期，同一 select-hotel 端点） */
  updateHotelStay: (tripId: string, candidateId: string, range: HotelStayRange) =>
    request<{ ok: true; checkInDay?: number; checkOutDay?: number }>(
      `/trips/${tripId}/select-hotel`,
      {
        method: "POST",
        body: JSON.stringify({ candidateId, ...range }),
      },
    ),
};
