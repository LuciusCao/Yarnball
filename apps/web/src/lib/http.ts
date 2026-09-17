import { usePrincipalStore } from "./principal";

/**
 * /api 请求的统一底层出口（issue #18）。
 *
 * - Bearer 注入集中在此：存在生效中的 guest 凭证（TripPage/JoinPage 的 guest 上下文）
 *   时给请求加 Authorization；无凭证时透传 init（本机 owner 形态逐字节与从前一致，零回归）。
 * - header 语义保持各调用方现状：默认 content-type: application/json，调用方显式传
 *   headers 时以调用方为准，Bearer 叠加在其上（调用方不传 authorization，无覆盖场景）。
 * - 401 广播：带凭证请求被拒 = 链接已被吊销/失效，广播 guest-kicked 事件，
 *   TripPage 据此显示「链接已被主人撤销」友好页并清除凭证，而不是裸报错。
 */

/** 带 code 的 API 错误：join 端点用 code（join_link_not_found / join_link_revoked）区分文案 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** 服务端错误码（有则带）；无 code 的普通错误为 undefined */
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 链接被吊销/失效的全局事件：detail.tripId 为被踢出的行程 */
export const GUEST_KICKED_EVENT = "yarnball:guest-kicked";

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const { active } = usePrincipalStore.getState();
  // 无凭证：完全透传（不新建 Headers 对象，行为与改造前逐字节一致）
  if (!active) return fetch(path, init);
  const headers = new Headers(init?.headers ?? { "content-type": "application/json" });
  headers.set("authorization", `Bearer ${active.token}`);
  const res = await fetch(path, { ...init, headers });
  // 带凭证仍 401：token 已失效（吊销/重置），广播踢出并停用凭证（存储也清掉，
  // 本机 owner 浏览器随之自动恢复 owner 形态）
  if (res.status === 401) {
    const tripId = active.tripId;
    usePrincipalStore.getState().exitTrip(tripId);
    window.dispatchEvent(new CustomEvent(GUEST_KICKED_EVENT, { detail: { tripId } }));
  }
  return res;
}
