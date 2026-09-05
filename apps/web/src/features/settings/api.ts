/**
 * 设置中心 API 客户端。
 * 按 M1 任务书契约形状本地封装（M1 的 apps/web/src/lib/api.ts 合并前使用）；
 * lib/api.ts 落地后这里应改为转发到统一客户端，端点形状保持一致。
 */

/** 应用设置：高德三个 key（仅国内行程需要）。已配置的密钥服务端可返回掩码串，前端只判空。 */
export interface AppSettings {
  amapJsKey: string | null;
  amapServerKey: string | null;
  amapJsSecret: string | null;
}

/** 更新设置：未传字段保持不变，空串表示清除该字段。 */
export type UpdateSettingsInput = Partial<{
  [K in keyof AppSettings]: string;
}>;

/** agent CLI 注册项 */
export interface AgentCliConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

/** detect 结果附带命令可用性 */
export interface AgentCliStatus extends AgentCliConfig {
  available: boolean;
}

export interface AgentCliInput {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

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

export const settingsApi = {
  getSettings: () => request<{ settings: AppSettings }>("/settings"),
  updateSettings: (input: UpdateSettingsInput) =>
    request<{ settings: AppSettings }>("/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  listAgents: () => request<{ agents: AgentCliConfig[] }>("/agents"),
  createAgent: (input: AgentCliInput) =>
    request<{ agent: AgentCliConfig }>("/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAgent: (id: string, input: Partial<AgentCliInput>) =>
    request<{ agent: AgentCliConfig }>(`/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteAgent: (id: string) =>
    request<{ ok: true }>(`/agents/${id}`, { method: "DELETE" }),
  /** 探测每个已注册 agent 的 command 在当前机器上是否可执行 */
  detectAgents: () => request<{ agents: AgentCliStatus[] }>("/agents/detect"),
};
