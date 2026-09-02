import { asc, eq } from "drizzle-orm";
import type { ChatMessageDto } from "@odessey/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";

/** chat 消息读取（REST + SSE 断线补拉共用） */
export async function listChatMessages(db: Db, sessionId: string): Promise<ChatMessageDto[]> {
  const rows = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(asc(schema.chatMessages.seq));
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    seq: r.seq,
    turnId: r.turnId,
    kind: r.kind as ChatMessageDto["kind"],
    content: r.content as Record<string, unknown>,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}
