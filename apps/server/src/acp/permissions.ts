import type * as acp from "@agentclientprotocol/sdk";
import type { PermissionOutcome, PendingPermission } from "./types.js";

/**
 * Permission 四层决策序（对齐 agent-legion 验证过的策略）：
 * 1. TripMapper MCP 工具调用 → 自动批准（scoped token 已是权限边界）
 * 2. 本地只读 kind（read/search）→ 自动批准
 * 3. session 级 allow-all → 自动批准
 * 4. 停靠 UI 等人答；120s 超时自动 deny
 *
 * 自动批准只信结构化身份字段（toolCall.title / kind），
 * 绝不序列化 payload 做匹配——防止 rawInput 里伪装工具名。
 */

const READ_ONLY_KINDS = new Set(["read", "search"]);

/** 工具卡片 title 形如 "tripmapper: add_place"（MCP server 名前缀） */
export function isTripMapperMcpToolCall(toolCall: { title?: string | null }): boolean {
  const title = toolCall.title ?? "";
  return title.startsWith("tripmapper") || title.startsWith("tripmapper:");
}

export interface PermissionPolicyInput {
  params: acp.RequestPermissionRequest;
  allowAll: boolean;
}

export type PermissionDecision =
  | { action: "auto_approve"; optionId: string; reason: string }
  | { action: "park_to_user" };

export function decidePermission(input: PermissionPolicyInput): PermissionDecision {
  const { params, allowAll } = input;

  if (allowAll) {
    const first = allowOption(params);
    if (first) return { action: "auto_approve", optionId: first.optionId, reason: "allow-all 已开启" };
  }

  if (isTripMapperMcpToolCall(params.toolCall)) {
    const first = allowOption(params);
    if (first) {
      return {
        action: "auto_approve",
        optionId: first.optionId,
        reason: "TripMapper 行程工具（自动批准）",
      };
    }
  }

  const kind = params.toolCall.kind ?? "";
  if (READ_ONLY_KINDS.has(kind)) {
    const first = allowOption(params);
    if (first) return { action: "auto_approve", optionId: first.optionId, reason: `只读工具 ${kind}（自动批准）` };
  }

  return { action: "park_to_user" };
}

function allowOption(params: acp.RequestPermissionRequest): acp.PermissionOption | undefined {
  return params.options.find((o) => o.kind === "allow_once") ?? params.options.find((o) => o.kind === "allow_always") ?? params.options[0];
}

/** 停靠 UI 的 permission，120s 无人响应自动 deny（防止挂死 agent 子进程） */
export const PERMISSION_TIMEOUT_MS = 120_000;

export interface ParkedPermission {
  pending: PendingPermission;
  /** ACP 侧响应 promise：用户决策或超时后 resolve（handler 直接返回它） */
  agentResponse: Promise<acp.RequestPermissionResponse>;
  /** UI 侧决策入口（REST 路由调用） */
  userDecides: (outcome: PermissionOutcome) => void;
}

export function parkPermission(pending: PendingPermission): ParkedPermission {
  let onUserDecision: ((outcome: PermissionOutcome) => void) | null = null;
  const userDecision = new Promise<PermissionOutcome>((resolve) => {
    onUserDecision = resolve;
  });

  const agentResponse = userDecision.then((outcome) => {
    if (outcome.optionId) {
      return { outcome: { outcome: "selected", optionId: outcome.optionId } } as acp.RequestPermissionResponse;
    }
    return { outcome: { outcome: "cancelled" } } as acp.RequestPermissionResponse;
  });

  const timer = setTimeout(() => {
    onUserDecision?.({ optionId: null, optionName: "超时自动拒绝", autoApproved: false });
  }, PERMISSION_TIMEOUT_MS);
  void userDecision.then(() => clearTimeout(timer));

  return {
    pending,
    agentResponse,
    userDecides: (outcome) => onUserDecision?.(outcome),
  };
}
