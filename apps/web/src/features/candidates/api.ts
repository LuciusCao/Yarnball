import type { PlaceStatus } from "./placeStatus";

/**
 * 候选池写操作 —— api/client.ts 归其他任务维护，这里自带最小请求层：
 * - PATCH /api/places/:id/status：锁定/解锁（M1 契约，SetPlaceStatusInputSchema）
 * - DELETE /api/places/:id：删除地点（服务端已有，client.ts 尚未封装）
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

export const candidatesApi = {
  /** 锁定（locked）/ 解锁（candidate）地点；返回更新后的 place（M1 契约） */
  setPlaceStatus: (placeId: string, status: PlaceStatus) =>
    request<{ place: unknown }>(`/places/${placeId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  /** 删除地点（连带移除其日程 entry 与酒店候选记录，服务端负责级联） */
  deletePlace: (placeId: string) =>
    request<{ ok: true }>(`/places/${placeId}`, { method: "DELETE" }),
};
