import type { ChatMessageDto } from "@tripmapper/shared";
import type * as acp from "@agentclientprotocol/sdk";

/**
 * ACP session 运行时与 REST 路由共享的进程内接口。
 * acp/ 目录实现它；routes/ 与 mcp/ 消费它。
 */

export interface PermissionOutcome {
  optionId: string | null; // null = 拒绝/取消
  optionName: string;
  autoApproved: boolean;
}

export interface PendingPermission {
  sessionId: string;
  requestId: string;
  toolCall: acp.ToolCallUpdate;
  options: acp.PermissionOption[];
  /** UI 决策回调：resolve 后由 session manager 回给 agent */
  resolve: (outcome: PermissionOutcome) => void;
}

