ALTER TABLE "chat_sessions" ADD COLUMN "has_mcp_call" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- 存量回填：历史消息里出现过 yarnball 工具卡片/权限注记的会话视为已有 MCP 调用
UPDATE "chat_sessions" SET "has_mcp_call" = true
WHERE "id" IN (
  SELECT DISTINCT "session_id" FROM "chat_messages"
  WHERE ("kind" = 'tool_call' AND "content"->>'title' LIKE 'yarnball%')
     OR ("kind" = 'permission_result' AND "content"->>'toolCallTitle' LIKE 'yarnball%')
);