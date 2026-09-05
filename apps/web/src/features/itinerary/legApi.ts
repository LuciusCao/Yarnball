import type { TransportLegDto } from "@yarnball/shared";

/**
 * 交通段模式覆盖 —— M1（worker-core）契约：
 *   POST /api/legs/:legId/mode  body: { mode: "walk" | "drive" }
 *   → 返回 { leg }；服务端把该段标记为人工覆盖，后续自动重算不得冲掉。
 * 本文件独立于 api/client.ts（不在本任务改动范围内），契约对准时只需改这里。
 */
export async function overrideLegMode(
  legId: string,
  mode: "walk" | "drive",
): Promise<TransportLegDto | null> {
  const res = await fetch(`/api/legs/${legId}/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404) {
      throw new Error("服务端还不支持交通方式覆盖（等 M1 合入后可用）");
    }
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { leg?: TransportLegDto };
  return body.leg ?? null;
}
