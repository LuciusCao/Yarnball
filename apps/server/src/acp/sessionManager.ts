import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ChatMessageDto } from "@yarnball/shared";
import { asc, eq, max } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { chatChannel, type EventBus } from "../events.js";
import { env } from "../env.js";
import { MCP_SERVER_NAME, SESSION_ID_HEADER, mintSessionToken, revokeSessionTokens } from "../mcp/tools.js";
import { toChatSessionDto } from "../services/mappers.js";
import { bootstrapPrompt, buildReplayPrompt, mcpHintMessage } from "./prompts.js";
import { decidePermission, parkPermission, type ParkedPermission } from "./permissions.js";
import type { PendingPermission, PermissionOutcome } from "./types.js";

/**
 * AcpSessionManager —— 每个 chat session 拥有一个 agent 子进程（stdio NDJSON JSON-RPC）。
 * Node 单线程事件循环下不需要 agent-legion 的 daemon 线程桥接：
 * prompt 队列就是串行 async 循环，cancel 走 SDK 请求。
 *
 * 会话建立流程（与 SDK 1.4 的 API 对齐）：
 *   connectWith(stream) → initialize（声明 terminal 能力）
 *   → buildSession(cwd).withMcpServer(httpSpec).start() → ActiveSession
 *   → prompt()/nextUpdate() 消费流
 *
 * resume：若上次的 acpSessionId 存在且 agent 声明 loadSession，改为
 * ctx.request("session/load", ...)。SDK 1.4 没有 load 的 builder 封装，
 * 直接发原始请求；成功后同样用 ActiveSession 的 prompt 接口继续对话。
 *
 * 断线自愈：句柄只活在内存，server 重启后 DB 的 status 与内存脱节。
 * 构造时 sweep 校正残留状态；REST 层在句柄缺失时走 ensureSession 懒恢复
 * （session/new + 压缩转录回放），恢复成功再入队 prompt，用户无感。
 */

const PROMPT_TIMEOUT_MS = 60 * 60 * 1000;
const TERMINAL_OUTPUT_MAX = 4 * 1024 * 1024;
const MAX_ACTIVE_SESSIONS = 32;

export class AcpSessionManager {
  private handles = new Map<string, SessionHandle>();
  /** 进行中的懒恢复（chatSessionId → promise），并发 prompt 共享同一次恢复 */
  private recovering = new Map<string, Promise<SessionHandle>>();

  constructor(
    private db: Db,
    private bus: EventBus,
    private markMcpObserved: (chatSessionId: string) => void,
  ) {
    // 启动 sweep：句柄只活在内存，server 重启后 DB 里残留的 running/starting 都是僵尸状态
    void this.sweepStaleStatuses();
  }

  /**
   * server 重启后的状态校正：
   * - running → idle（回合被中断，下条 prompt 懒恢复即可继续）
   * - starting → error（启动被中断；prompt/reconnect 仍会懒恢复，标 error 让 UI 给出重连入口）
   */
  private async sweepStaleStatuses() {
    try {
      await this.db
        .update(schema.chatSessions)
        .set({ status: "idle", lastError: "server 重启，连接已断开；发送消息时会自动重连", updatedAt: new Date() })
        .where(eq(schema.chatSessions.status, "running"));
      await this.db
        .update(schema.chatSessions)
        .set({ status: "error", lastError: "server 重启，会话启动被中断；发送消息或点「重新连接」会自动重连", updatedAt: new Date() })
        .where(eq(schema.chatSessions.status, "starting"));
    } catch (err) {
      console.warn("[acp] stale status sweep failed:", err);
    }
  }

  get(chatSessionId: string): SessionHandle | undefined {
    return this.handles.get(chatSessionId);
  }

  get size(): number {
    return this.handles.size;
  }

  /**
   * 懒恢复：句柄缺失（server 重启 / agent 进程崩溃后被清理）时按 DB 行重建 agent 子进程，
   * 走 startSession 的 session/new + 压缩转录回放路径。并发调用共享同一次恢复。
   */
  async ensureSession(row: typeof schema.chatSessions.$inferSelect): Promise<SessionHandle> {
    const existing = this.handles.get(row.id);
    if (existing) return existing;
    const inflight = this.recovering.get(row.id);
    if (inflight) return inflight;
    const promise = (async () => {
      await this.startSession(row);
      const handle = this.handles.get(row.id);
      if (!handle) throw new Error("会话句柄未建立");
      return handle;
    })();
    this.recovering.set(row.id, promise);
    try {
      return await promise;
    } finally {
      this.recovering.delete(row.id);
    }
  }

  async startSession(row: typeof schema.chatSessions.$inferSelect): Promise<void> {
    if (this.handles.has(row.id)) return;
    if (this.handles.size >= MAX_ACTIVE_SESSIONS) {
      throw new Error(`活跃会话已达上限（${MAX_ACTIVE_SESSIONS}）`);
    }
    const [agent] = await this.db
      .select()
      .from(schema.agentRegistry)
      .where(eq(schema.agentRegistry.id, row.agentRegistryId));
    if (!agent) throw new Error(`agent ${row.agentRegistryId} not found in registry`);

    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, row.tripId));

    const handle = new SessionHandle(this.db, this.bus, row, {
      command: agent.command,
      args: (agent.args as string[]) ?? [],
    }, this.markMcpObserved);
    handle.setTripInfo(
      trip?.title ?? "",
      trip?.destinationCity ?? "",
      (trip?.geoProvider as "amap" | "osm") ?? "osm",
    );
    this.handles.set(row.id, handle);
    try {
      // start() 挂起整个连接生命周期，不能 await；等 whenReady（session/new 完成即就绪）
      void handle.start();
      await handle.whenReady;
    } catch (err) {
      this.handles.delete(row.id);
      throw err;
    }
  }

  async stopSession(chatSessionId: string, reason: string) {
    const handle = this.handles.get(chatSessionId);
    this.handles.delete(chatSessionId);
    await handle?.close(reason);
  }

  /** 停掉某行程下所有 chat session 的句柄（删行程用；close 走默认 closed 终态语义） */
  async stopByTrip(tripId: string, reason: string) {
    const targets = [...this.handles.entries()].filter(([, h]) => h.tripId === tripId);
    for (const [id] of targets) this.handles.delete(id);
    await Promise.allSettled(targets.map(([, h]) => h.close(reason)));
  }

  /**
   * server 关停：进程死了但会话可恢复（acpSessionId + 转录回放都在 DB），
   * 不标 closed（closed = 用户主动断开），标 idle + 提示，重启后 prompt 懒恢复无感继续。
   */
  async stopAll() {
    await Promise.allSettled(
      [...this.handles.values()].map((h) =>
        h.close("server shutdown", {
          status: "idle",
          lastError: "server 重启，连接已断开；发送消息时会自动重连",
        }),
      ),
    );
    this.handles.clear();
  }
}

// ---------- SessionHandle ----------

export class SessionHandle {
  private process: ChildProcess | null = null;
  private cwd: string | null = null;
  private closed = false;

  private activeSession: acp.ActiveSession | null = null;
  /** 挂起的 connectWith promise；close() 时 resolve 以退出 connectWith 回调 */
  private releaseConnect: (() => void) | null = null;

  /**
   * 就绪信号：session/new 完成、状态到 idle 时 resolve；启动失败 / 提前关闭时 reject。
   * start() 本身挂起整个连接生命周期，调用方要等待「可用」必须等这个。
   */
  readonly whenReady: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;

  private promptQueue: { text: string; resolve: () => void; reject: (err: Error) => void }[] = [];
  private draining = false;

  private seq = 0;
  /** 聚合 key（turnId:kind）→ 已累计文本。turn 开始时清空。 */
  private aggregateSlots = new Map<string, string>();
  /** 聚合消息的 DB id，用于原地更新而不是无限追加 */
  private aggregateMessageIds = new Map<string, string>();

  private parkedPermissions: ParkedPermission[] = [];
  private permissionSeq = 0;

  private terminals = new Map<string, TerminalRecord>();

  private firstPromptDone = false;
  private pendingReplay: string | null = null;
  private mcpToolCallSeen = false;
  private mcpHintSent = false;
  private tripTitle = "";
  private tripCity = "";
  private tripProvider: "amap" | "osm" = "osm";

  constructor(
    private db: Db,
    private bus: EventBus,
    private sessionRow: typeof schema.chatSessions.$inferSelect,
    private agentSpec: { command: string; args: string[] },
    private markMcpObserved: (chatSessionId: string) => void,
  ) {
    this.whenReady = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // startSession 之外的旁观者不 await whenReady，拒绝时不触发 unhandledRejection
    this.whenReady.catch(() => {});
  }

  // ---------- 生命周期 ----------

  async start(): Promise<void> {
    const sessionId = this.sessionRow.id;
    await this.setStatus("starting");

    // 懒恢复重建句柄时 seq 从 DB 续号：(session_id, seq) 有唯一索引，从 0 计数会撞历史消息
    const [seqRow] = await this.db
      .select({ maxSeq: max(schema.chatMessages.seq) })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, sessionId));
    this.seq = seqRow?.maxSeq ?? 0;

    this.cwd = await mkdtemp(join(tmpdir(), `yarnball-${sessionId.slice(0, 8)}-`));
    const child = spawn(this.agentSpec.command, this.agentSpec.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    // stderr 必须排水，否则 chatty agent 会因满管道死锁
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.debug(`[acp:${sessionId}] stderr: ${text.slice(0, 500)}`);
    });
    child.on("error", (err) => {
      // spawn 失败（command 不存在等）：无 exit 事件，必须单独兜底，否则异常冒泡崩 server
      if (!this.closed) {
        void this.appendMessage({
          turnId: null,
          kind: "error",
          content: { text: `agent 进程启动失败：${err.message}。请检查设置页的 agent 命令配置。` },
        });
        void this.setStatus("error", `agent 进程启动失败：${err.message}`);
        this.readyReject(err);
      }
    });
    child.on("exit", (code, signal) => {
      if (!this.closed) {
        void this.appendMessage({
          turnId: null,
          kind: "error",
          content: {
            text: `agent 进程退出（code=${code} signal=${signal ?? ""}）。可重新发起会话继续。`,
          },
        });
        void this.setStatus("error", `agent 进程退出 code=${code}`);
        this.readyReject(new Error(`agent 进程退出 code=${code}`));
      }
    });

    const clientApp = acp
      .client({ name: "yarnball" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.onRequestPermission(ctx))
      .onRequest(acp.methods.client.terminal.create, (ctx) => this.createTerminal(ctx))
      .onRequest(acp.methods.client.terminal.output, (ctx) => this.terminalOutput(ctx))
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) => this.waitForTerminalExit(ctx))
      .onRequest(acp.methods.client.terminal.release, (ctx) => this.releaseTerminal(ctx))
      .onRequest(acp.methods.client.terminal.kill, (ctx) => this.killTerminal(ctx));

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    await clientApp
      .connectWith(stream, async (ctx) => {
        const initResult = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { terminal: true },
          clientInfo: { name: "yarnball", title: "Yarnball", version: "0.1.0" },
        });

        const { token } = await this.mintAndStoreToken();
        const mcpServer = this.buildMcpSpec(token);

        await this.openSession(ctx, initResult, mcpServer);

        // 启动/重连成功：清掉此前的 lastError（如 sweep 或自动重连失败留下的提示）
        await this.setStatus("idle", null);
        this.readyResolve();
        this.consumeUpdates();

        // 挂起直到 close()；connectWith 回调返回会关闭连接
        await new Promise<void>((resolve) => {
          this.releaseConnect = resolve;
        });
      })
      .catch(async (err) => {
        this.readyReject(err as Error);
        if (this.closed) return;
        console.error(`[acp:${sessionId}] connection error:`, err);
        await this.appendMessage({
          turnId: null,
          kind: "error",
          content: { text: `无法连接 agent：${(err as Error).message}` },
        });
        await this.setStatus("error", (err as Error).message);
      });
  }

  /** session/new → ActiveSession。resume 靠压缩转录回放（loadSession 的 ActiveSession 封装 SDK 未暴露，v2 用原始请求补） */
  private async openSession(
    ctx: acp.ClientContext,
    _initResult: acp.InitializeResponse,
    mcpServer: acp.McpServer,
  ): Promise<void> {
    if (this.sessionRow.acpSessionId) {
      this.pendingReplay = await this.buildReplay();
    }
    const builder = ctx.buildSession(this.cwd!).withMcpServer(mcpServer);
    this.activeSession = await builder.start();
    if (this.activeSession.sessionId !== this.sessionRow.acpSessionId) {
      await this.db
        .update(schema.chatSessions)
        .set({ acpSessionId: this.activeSession.sessionId, updatedAt: new Date() })
        .where(eq(schema.chatSessions.id, this.sessionRow.id));
    }
  }

  private buildMcpSpec(token: string): acp.McpServer {
    return {
      type: "http",
      name: MCP_SERVER_NAME,
      url: `${env.serverBaseUrl}/mcp`,
      headers: [
        { name: "Authorization", value: `Bearer ${token}` },
        { name: SESSION_ID_HEADER, value: this.sessionRow.id },
      ],
    };
  }

  private async mintAndStoreToken() {
    const { token, tokenHash } = mintSessionToken();
    await this.db.insert(schema.agentTokens).values({
      id: crypto.randomUUID(),
      chatSessionId: this.sessionRow.id,
      tokenHash,
    });
    return { token };
  }

  private async buildReplay(): Promise<string | null> {
    const messages = await this.listMessages();
    return buildReplayPrompt(messages);
  }

  /** final 缺省 closed（用户主动断开/行程删除）；server 关停时传 idle 保可恢复语义 */
  async close(reason: string, final: { status: string; lastError?: string | null } = { status: "closed" }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 启动途中被关：放行 whenReady 的等待方（已 resolve 时为 no-op）
    this.readyReject(new Error(`session closed: ${reason}`));

    // 停靠中的 permission 全部结算为拒绝，防止挂死 agent
    this.settleAllPermissions();

    // 唤醒 connectWith 回调，让 SDK 正常关闭连接
    this.releaseConnect?.();

    try {
      this.activeSession?.dispose();
    } catch {}

    const child = this.process;
    if (child?.pid) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }

    if (this.cwd) await rm(this.cwd, { recursive: true, force: true }).catch(() => {});
    await revokeSessionTokens(this.db, this.sessionRow.id);
    await this.setStatus(final.status, final.lastError);
  }

  // ---------- prompt ----------

  enqueuePrompt(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("session closed"));
    return new Promise((resolve, reject) => {
      this.promptQueue.push({ text, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.promptQueue.length > 0 && !this.closed) {
        const item = this.promptQueue.shift()!;
        try {
          await this.runTurn(item.text);
          item.resolve();
        } catch (err) {
          item.reject(err as Error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTurn(userText: string): Promise<void> {
    const session = this.activeSession;
    if (!session) throw new Error("session 未就绪");

    const turnId = crypto.randomUUID();
    this.currentTurnId = turnId;
    // turn 开始时清聚合槽（SDK 在 prompt resolve 后可能还有 trailing chunks）
    this.aggregateSlots.clear();
    this.aggregateMessageIds.clear();

    await this.appendMessage({ turnId, kind: "user_text", content: { text: userText } });

    let prefix = "";
    if (!this.firstPromptDone) {
      prefix = bootstrapPrompt(this.tripTitle, this.tripCity, this.tripProvider);
      if (this.pendingReplay) {
        prefix += `\n\n${this.pendingReplay}`;
        this.pendingReplay = null;
      }
      this.firstPromptDone = true;
    }
    const fullPrompt = prefix ? `${prefix}\n\n---\n\n${userText}` : userText;

    await this.setStatus("running");
    try {
      const response = await Promise.race([
        session.prompt(fullPrompt),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("prompt 超时（1 小时）")), PROMPT_TIMEOUT_MS).unref?.(),
        ),
      ]);
      await this.appendMessage({
        turnId,
        kind: "advisory",
        content: { text: `—— 回合结束（${response.stopReason}）——` },
      });
    } catch (err) {
      await this.appendMessage({
        turnId,
        kind: "error",
        content: { text: `回合失败：${(err as Error).message}` },
      });
      throw err;
    } finally {
      await this.setStatus("idle").catch(() => {});
      // MCP 冒烟：整个会话从未见过毛线团工具调用 → 一次性提示
      if (!this.mcpToolCallSeen && !this.mcpHintSent) {
        this.mcpHintSent = true;
        await this.appendMessage({ ...mcpHintMessage() });
      }
    }
  }
  private currentTurnId: string | null = null;

  cancelTurn(): void {
    // ACP 的 cancel 是 client→agent 通知；SDK 未封装到 ActiveSession，
    // 通过底层 connection 发送。ActiveSession 无此接口，退化为提示。
    // v1 实现见 fake agent 测试与 kimi 真机验证后补全。
    void this.activeSession;
  }

  // ---------- update 流 ----------

  private consumeUpdates() {
    const session = this.activeSession;
    if (!session) return;
    void (async () => {
      for (;;) {
        try {
          const message = await session.nextUpdate();
          if (message.kind === "stop") continue; // stop 已由 prompt() 的 resolve 处理
          await this.handleUpdate(message.update);
        } catch (err) {
          if (this.closed) return;
          console.error(`[acp:${this.sessionRow.id}] update stream error:`, err);
          await this.appendMessage({
            turnId: null,
            kind: "error",
            content: { text: `与 agent 的更新流中断：${(err as Error).message}` },
          });
          await this.setStatus("error", (err as Error).message).catch(() => {});
          return;
        }
      }
    })();
  }

  private async handleUpdate(update: acp.SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          await this.appendAggregated("agent_text", update.content.text);
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          await this.appendAggregated("agent_thought", update.content.text);
        }
        break;
      case "user_message_chunk":
        break; // 用户自己的话，前端已有
      case "tool_call":
        await this.appendMessage({
          turnId: this.currentTurnId,
          kind: "tool_call",
          content: {
            toolCallId: update.toolCallId,
            title: update.title,
            toolKind: update.kind ?? null,
            status: update.status,
            rawInput: update.rawInput ?? null,
          },
        });
        if (isYarnballToolCallTitle(update.title)) {
          this.mcpToolCallSeen = true;
          this.markMcpObserved(this.sessionRow.id);
        }
        break;
      case "tool_call_update":
        await this.appendMessage({
          turnId: this.currentTurnId,
          kind: "tool_call_update",
          content: {
            toolCallId: update.toolCallId,
            status: update.status,
            content: update.content ?? null,
          },
        });
        break;
      case "plan":
        await this.appendMessage({
          turnId: this.currentTurnId,
          kind: "plan",
          content: { entries: update.entries },
        });
        break;
      default:
        break;
    }
  }

  /**
   * 同 turn 同 kind 的 chunk 聚合成一条消息，原地更新（seq 不变，id 不变）。
   * 前端按 id upsert，实现平滑流式渲染。
   */
  private async appendAggregated(kind: "agent_text" | "agent_thought", text: string) {
    const key = `${this.currentTurnId}:${kind}`;
    const existing = this.aggregateSlots.get(key) ?? "";
    const updated = existing + text;
    this.aggregateSlots.set(key, updated);

    const existingId = this.aggregateMessageIds.get(key);
    if (existingId) {
      await this.db
        .update(schema.chatMessages)
        .set({ content: { text: updated } })
        .where(eq(schema.chatMessages.id, existingId));
      this.bus.publish(chatChannel(this.sessionRow.id), {
        type: "message",
        message: {
          id: existingId,
          sessionId: this.sessionRow.id,
          seq: this.seqOf(existingId) ?? 0,
          turnId: this.currentTurnId,
          kind,
          content: { text: updated },
          createdAt: new Date().toISOString(),
        },
      });
    } else {
      const dto = await this.appendMessage({ turnId: this.currentTurnId, kind, content: { text: updated } });
      this.aggregateMessageIds.set(key, dto.id);
    }
  }

  private seqCache = new Map<string, number>();
  private seqOf(messageId: string): number | undefined {
    return this.seqCache.get(messageId);
  }

  // ---------- permission ----------

  private async onRequestPermission(ctx: {
    params: acp.RequestPermissionRequest;
    requestId: acp.JsonRpcId;
  }): Promise<acp.RequestPermissionResponse> {
    const [row] = await this.db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, this.sessionRow.id));
    const decision = decidePermission({
      params: ctx.params,
      allowAll: row?.allowAllPermissions ?? false,
    });

    if (decision.action === "auto_approve") {
      await this.appendMessage({
        turnId: this.currentTurnId,
        kind: "permission_result",
        content: {
          toolCallTitle: ctx.params.toolCall.title,
          outcome: decision.reason,
          autoApproved: true,
        },
      });
      return { outcome: { outcome: "selected", optionId: decision.optionId } };
    }

    const parked = parkPermission({
      sessionId: this.sessionRow.id,
      requestId: `perm-${++this.permissionSeq}-${ctx.requestId}`,
      toolCall: ctx.params.toolCall,
      options: ctx.params.options,
      resolve: () => {},
    });
    this.parkedPermissions.push(parked);
    await this.appendMessage({
      turnId: this.currentTurnId,
      kind: "permission_request",
      content: {
        requestId: parked.pending.requestId,
        toolCall: ctx.params.toolCall,
        options: ctx.params.options,
      },
    });

    // 用户决策 / 120s 超时后 agentResponse resolve，SDK 把结果写回 agent
    return parked.agentResponse;
  }

  /** UI 决策入口（REST 路由调用）。返回 false = 该 requestId 已不存在 */
  userDecidesPermission(requestId: string, outcome: PermissionOutcome): boolean {
    const idx = this.parkedPermissions.findIndex((p) => p.pending.requestId === requestId);
    if (idx === -1) return false;
    const [parked] = this.parkedPermissions.splice(idx, 1);
    parked.userDecides(outcome);
    void this.appendMessage({
      turnId: this.currentTurnId,
      kind: "permission_result",
      content: {
        requestId,
        toolCallTitle: parked.pending.toolCall.title,
        outcome: outcome.optionId ? `已允许（${outcome.optionName}）` : "已拒绝",
        autoApproved: false,
      },
    });
    return true;
  }

  private settleAllPermissions() {
    for (const p of this.parkedPermissions) {
      p.userDecides({ optionId: null, optionName: "会话关闭", autoApproved: false });
    }
    this.parkedPermissions = [];
  }

  // ---------- terminal 协议（kimi 的 Bash/Grep 依赖，不实现则全挂） ----------

  private async createTerminal(ctx: {
    params: acp.CreateTerminalRequest;
  }): Promise<acp.CreateTerminalResponse> {
    const p = ctx.params;
    const id = `term-${crypto.randomUUID().slice(0, 8)}`;
    const envOverride: Record<string, string> = {};
    for (const v of p.env ?? []) envOverride[v.name] = v.value;
    const child = spawn(p.command, p.args ?? [], {
      cwd: p.cwd ?? this.cwd ?? undefined,
      // env 只送 override 时必须 merge 继承环境，不能替换
      env: { ...process.env, ...envOverride },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // 独立进程组，可整组 kill
    });
    const record: TerminalRecord = {
      id,
      process: child,
      output: "",
      truncated: false,
      exitStatus: null,
      exitWaiters: [],
      settled: false,
    };
    child.stdout?.on("data", (c: Buffer) => appendOutput(record, c));
    child.stderr?.on("data", (c: Buffer) => appendOutput(record, c));
    child.on("exit", (code, signal) => {
      record.exitStatus = { exitCode: code, signal: signal ?? undefined };
      record.settled = true;
      for (const w of record.exitWaiters.splice(0)) w();
    });
    this.terminals.set(id, record);
    return { terminalId: id };
  }

  private async terminalOutput(ctx: {
    params: acp.TerminalOutputRequest;
  }): Promise<acp.TerminalOutputResponse> {
    const record = this.terminals.get(ctx.params.terminalId);
    if (!record) throw new acp.RequestError(-32001, "no such terminal");
    return {
      output: record.output,
      truncated: record.truncated,
      exitStatus: record.exitStatus ?? undefined,
    };
  }

  private async waitForTerminalExit(ctx: {
    params: acp.WaitForTerminalExitRequest;
  }): Promise<acp.WaitForTerminalExitResponse> {
    const record = this.terminals.get(ctx.params.terminalId);
    if (!record) throw new acp.RequestError(-32001, "no such terminal");
    if (!record.settled) {
      await new Promise<void>((resolve) => record.exitWaiters.push(resolve));
    }
    return record.exitStatus ?? {};
  }

  private async releaseTerminal(ctx: {
    params: acp.ReleaseTerminalRequest;
  }): Promise<void> {
    const record = this.terminals.get(ctx.params.terminalId);
    if (record) {
      killProcessGroup(record);
      this.terminals.delete(ctx.params.terminalId);
    }
  }

  private async killTerminal(ctx: { params: acp.KillTerminalRequest }): Promise<void> {
    const record = this.terminals.get(ctx.params.terminalId);
    if (record) killProcessGroup(record);
  }

  // ---------- DB helpers ----------

  /** 状态落库 + SSE 推送 session 快照（前端状态灯/重连提示实时刷新，不必等轮询） */
  private async setStatus(status: string, lastError?: string | null) {
    try {
      await this.db
        .update(schema.chatSessions)
        .set({ status, ...(lastError !== undefined ? { lastError } : {}), updatedAt: new Date() })
        .where(eq(schema.chatSessions.id, this.sessionRow.id));
      const [row] = await this.db
        .select()
        .from(schema.chatSessions)
        .where(eq(schema.chatSessions.id, this.sessionRow.id));
      if (row) {
        this.bus.publish(chatChannel(this.sessionRow.id), { type: "session", session: toChatSessionDto(row) });
      }
    } catch (err) {
      console.warn(`[acp:${this.sessionRow.id}] setStatus failed:`, err);
    }
  }

  private async appendMessage(
    message: Omit<ChatMessageDto, "createdAt" | "id" | "sessionId" | "seq">,
  ): Promise<ChatMessageDto> {
    const seq = ++this.seq;
    const id = crypto.randomUUID();
    await this.db.insert(schema.chatMessages).values({
      id,
      sessionId: this.sessionRow.id,
      seq,
      turnId: message.turnId,
      kind: message.kind,
      content: message.content,
    });
    this.seqCache.set(id, seq);
    const dto: ChatMessageDto = {
      id,
      sessionId: this.sessionRow.id,
      seq,
      turnId: message.turnId,
      kind: message.kind,
      content: message.content,
      createdAt: new Date().toISOString(),
    };
    this.bus.publish(chatChannel(this.sessionRow.id), { type: "message", message: dto });
    return dto;
  }

  private async listMessages(): Promise<ChatMessageDto[]> {
    const rows = await this.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, this.sessionRow.id))
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

  setTripInfo(title: string, city: string, provider: "amap" | "osm") {
    this.tripTitle = title;
    this.tripCity = city;
    this.tripProvider = provider;
  }

  /** 所属行程（stopByTrip 按它匹配句柄） */
  get tripId(): string {
    return this.sessionRow.tripId;
  }
}

interface TerminalRecord {
  id: string;
  process: ChildProcess;
  output: string;
  truncated: boolean;
  exitStatus: { exitCode: number | null; signal?: string } | null;
  exitWaiters: (() => void)[];
  settled: boolean;
}

function appendOutput(record: TerminalRecord, chunk: Buffer) {
  record.output += chunk.toString();
  if (record.output.length > TERMINAL_OUTPUT_MAX) {
    record.output = record.output.slice(-TERMINAL_OUTPUT_MAX); // 头截断保尾部
    record.truncated = true;
  }
}

function killProcessGroup(record: TerminalRecord) {
  const pid = record.process.pid;
  if (pid && !record.settled) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        record.process.kill("SIGKILL");
      } catch {}
    }
  }
}

function isYarnballToolCallTitle(title: string | undefined): boolean {
  return !!title && (title.startsWith("yarnball") || title.startsWith("yarnball:"));
}
