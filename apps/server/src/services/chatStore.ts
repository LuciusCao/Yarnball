import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { ChatMessageDto, ChatMessagesQuery } from "@yarnball/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";

/** 消息分页默认页大小（ChatMessagesQuerySchema 限制上限 500） */
export const CHAT_MESSAGES_PAGE_DEFAULT = 200;

function toDto(r: typeof schema.chatMessages.$inferSelect): ChatMessageDto {
  return {
    id: r.id,
    sessionId: r.sessionId,
    seq: r.seq,
    turnId: r.turnId,
    kind: r.kind as ChatMessageDto["kind"],
    content: r.content as Record<string, unknown>,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/**
 * chat 消息分页读取（REST 首屏 + 「加载更早」向上翻页共用）。
 * keyset 分页：beforeSeq 取 seq 严格小于它的更早一页；缺省取最新一页。
 * 多取一条（limit+1）判断 hasMore，避免为计数再发一条 COUNT 查询。
 */
export async function listChatMessages(
  db: Db,
  sessionId: string,
  query: ChatMessagesQuery = {},
): Promise<{ messages: ChatMessageDto[]; hasMore: boolean }> {
  const limit = query.limit ?? CHAT_MESSAGES_PAGE_DEFAULT;
  const rows = await db
    .select()
    .from(schema.chatMessages)
    .where(
      query.beforeSeq != null
        ? and(eq(schema.chatMessages.sessionId, sessionId), lt(schema.chatMessages.seq, query.beforeSeq))
        : eq(schema.chatMessages.sessionId, sessionId),
    )
    // desc + limit 取「最新的一页」，reverse 回 asc 保证消息流正序
    .orderBy(desc(schema.chatMessages.seq))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { messages: page.reverse().map(toDto), hasMore };
}

/** 全量读取（SSE 断线补拉 / 摘要回放用；分页端点不要用这个） */
export async function listAllChatMessages(db: Db, sessionId: string): Promise<ChatMessageDto[]> {
  const rows = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(asc(schema.chatMessages.seq));
  return rows.map(toDto);
}
