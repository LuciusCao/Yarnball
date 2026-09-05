/**
 * 候选池写操作补充 —— M1 契约单点在 ../../lib/api.ts：
 * 锁定/解锁（setPlaceStatus）已切到那里；这里只保留 lib/api 尚未覆盖的删除端点。
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
  /** 删除地点（DELETE /api/places/:id；服务端级联移除日程 entry 并解除选定酒店引用） */
  deletePlace: (placeId: string) =>
    request<{ ok: true }>(`/places/${placeId}`, { method: "DELETE" }),
};
