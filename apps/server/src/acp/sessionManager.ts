import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ChatMessageDto } from "@yarnball/shared";
import { and, asc, desc, eq, gt, max, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { chatChannel, type EventBus } from "../events.js";
import { env } from "../env.js";
import { MCP_SERVER_NAME, SESSION_ID_HEADER, mintSessionToken, revokeSessionTokens } from "../mcp/tools.js";
import { toChatSessionDto } from "../services/mappers.js";
import { getEnhancedEnv } from "../services/processEnv.js";
import { listAllChatMessages } from "../services/chatStore.js";
import { bootstrapPrompt, buildReplayPrompt, CONTEXT_SUMMARY_PROMPT, mcpHintMessage } from "./prompts.js";
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
/**
 * 上下文滚动阈值：本连接累计转录（user_text + agent_text 的 content 字符数）达到
 * 15 万字符（≈5 万 token）触发。留足余量——agent 自身还有压缩策略，过早滚动
 * 反而丢原文。每次回合边界动态读 YARNBALL_CONTEXT_ROLL_CHARS（调试用）。
 */
const contextRollThresholdChars = () =>
  Number(process.env.YARNBALL_CONTEXT_ROLL_CHARS ?? 150_000);

export class AcpSessionManager {
  private handles = new Map<string, SessionHandle>();
  /** 进行中的懒恢复（chatSessionId → promise），并发 prompt 共享同一次恢复 */
  private recovering = new Map<string, Promise<SessionHandle>>();

  constructor(
    private db: Db,
    private bus: EventBus,
  ) {
    // 启动 sweep：句柄只活在内存，server 重启后 DB 里残留的 running/starting 都是僵尸状态
    void this.sweepStaleStatuses();
  }

  /**
   * MCP 调用置位（/mcp 真实命中与 agent 通知里的 yarnball 工具卡片共用入口）：
   * 路由到内存句柄 + 持久化 has_mcp_call——持久化值是重启/换实例不丢的 ground truth。
   * main.ts 的 /mcp 端点回调必须直接调这里（此前经 mcpObservers Map 中转，
   * 但该 Map 从未被填充，/mcp 命中根本到不了句柄——M45 提示误报的根因）。
   */
  noteMcpCall(chatSessionId: string) {
    this.handles.get(chatSessionId)?.noteMcpObserved();
    void this.db
      .update(schema.chatSessions)
      .set({ hasMcpCall: true })
      .where(and(eq(schema.chatSessions.id, chatSessionId), eq(schema.chatSessions.hasMcpCall, false)))
      .catch((err) => console.warn(`[acp] persist has_mcp_call failed:`, err));
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
    }, (id) => this.noteMcpCall(id));
    // 句柄自判不可自愈时（上下文滚动换进程失败）把自己从 map 摘除，
    // 后续 prompt 走 REST 层懒恢复重建，而不是复用死句柄反复报「session 未就绪」
    handle.setUnregisterSelf(() => this.handles.delete(row.id));
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
      // 启动失败必须回收子进程/临时目录/MCP token，只删 map 会全部泄漏。
      // final 传 error：close 默认的 closed 终态会盖住失败原因，UI 需要 error 态给重连入口
      await handle
        .close("start failed", { status: "error", lastError: (err as Error).message })
        .catch(() => {});
      throw err;
    }
  }

  /** final 缺省 closed（用户主动断开）；recoverSession 停崩溃残留句柄时传 error 过渡态 */
  async stopSession(
    chatSessionId: string,
    reason: string,
    final?: { status: string; lastError?: string | null },
  ) {
    const handle = this.handles.get(chatSessionId);
    this.handles.delete(chatSessionId);
    await handle?.close(reason, final);
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
   * 每次 start()（含上下文滚动的原地重启）都会重建——等待方在调用 start 后读取，
   * 拿到的就是本次连接的就绪 promise。
   */
  whenReady!: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private resetReady(): void {
    this.whenReady = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // 不 await 的旁观者不应把拒绝变成 unhandledRejection
    this.whenReady.catch(() => {});
  }

  private promptQueue: { text: string; resolve: () => void; reject: (err: Error) => void }[] = [];
  private draining = false;

  private seq = 0;
  /** 聚合 key（turnId:kind:segment）→ 已累计文本。turn 开始时清空。 */
  private aggregateSlots = new Map<string, string>();
  /** 聚合消息的 DB id，用于原地更新而不是无限追加 */
  private aggregateMessageIds = new Map<string, string>();
  /** kind → 当前段号：tool_call/plan/permission 等事件介入后封闭当前段，后续 chunk 开新段 */
  private aggregateSegments = new Map<string, number>();
  /** 当前开放聚合段的 key；真实事件落库会封闭它（置 null 并记入 aggregateClosed） */
  private openAggregateKey: string | null = null;
  /** 被真实事件封闭的聚合段 key：迟到 chunk 不得并回这些段。turn 开始时清空 */
  private aggregateClosed = new Set<string>();

  private parkedPermissions: ParkedPermission[] = [];
  private permissionSeq = 0;

  private terminals = new Map<string, TerminalRecord>();

  private firstPromptDone = false;
  private pendingReplay: string | null = null;
  /** 上下文滚动：失败一次就不再尝试（rollFailed），直到换句柄（懒恢复/重连）重置 */
  private rollFailed = false;
  /** 原地重启进行中：旧进程 exit / 更新流断开是预期噪声，不得落错误消息 */
  private restarting = false;
  /** 内部回合（摘要 turn）：agent_message_chunk 只进聚合槽不落库——摘要文本由 context_summary 行承载 */
  private internalTurn = false;
  /** 内存快照，初值取自 DB 持久化的 hasMcpCall（重启/换实例后提示不误报） */
  private mcpToolCallSeen = false;
  private mcpHintSent = false;
  private tripTitle = "";
  private tripCity = "";
  private tripProvider: "amap" | "osm" = "osm";
  /** 句柄自判不可自愈（滚动换进程失败）时把自己从 manager 摘除；startSession 注入 */
  private unregisterSelf: (() => void) | null = null;

  setUnregisterSelf(fn: () => void): void {
    this.unregisterSelf = fn;
  }

  constructor(
    private db: Db,
    private bus: EventBus,
    private sessionRow: typeof schema.chatSessions.$inferSelect,
    private agentSpec: { command: string; args: string[] },
    private markMcpObserved: (chatSessionId: string) => void,
  ) {
    this.resetReady();
    // 持久化 ground truth 作初值：本句柄建起来之前（含 server 重启前）命中过 MCP 就不再提示
    this.mcpToolCallSeen = sessionRow.hasMcpCall;
  }

  // ---------- 生命周期 ----------

  async start(): Promise<void> {
    const sessionId = this.sessionRow.id;
    // 每次连接一个就绪信号（上下文滚动的原地重启会再次进入 start）
    this.resetReady();
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
      // 增强 PATH：GUI/sidecar 极简 PATH 下也要找得到 npm/brew/nvm 装的 agent CLI（与 /agents/detect 同一套）
      env: await getEnhancedEnv(),
      // 独立进程组（pid 即 pgid）：node shim 型 agent（npm bin 脚本 spawnSync 原生二进制，
      // 如 codex-acp）的孙进程留在同组，close 时 terminateProcessTree 可整组收走，不会孤儿化
      detached: true,
    });
    this.process = child;

    // stderr 必须排水，否则 chatty agent 会因满管道死锁
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.debug(`[acp:${sessionId}] stderr: ${text.slice(0, 500)}`);
    });
    child.on("error", (err) => {
      // spawn 失败（command 不存在等）：无 exit 事件，必须单独兜底，否则异常冒泡崩 server
      if (!this.closed && !this.restarting) {
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
      // restarting 下的 exit 是滚动换进程的主动收尾，不是故障
      if (!this.closed && !this.restarting) {
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
        // restarting 下的连接错误是旧连接的预期拆除
        if (this.closed || this.restarting) return;
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
      // 行内快照同步：上下文滚动的原地重启再入 openSession 时，据此判定「有历史要回放」
      this.sessionRow.acpSessionId = this.activeSession.sessionId;
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

  /**
   * 整组终止 agent 进程树：spawn 时 detached 使 pid 即 pgid，kill 负 pid 覆盖组内全部进程
   * （node shim 型 agent 的原生孙进程、agent 自行 spawn 的子进程一并收走）。
   * 组已不存在（ESRCH，直接型 agent 正常退出后）时回退只 kill 直接子进程，双双失败静默。
   */
  private async terminateProcessTree(child: ChildProcess): Promise<void> {
    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };
    // 已退出的进程（崩溃残留句柄的 close）：无 exit 事件可等，直接清尾返回，
    // 否则会白等 5s 超时
    if (child.exitCode !== null || child.signalCode !== null) {
      killTree("SIGKILL");
      return;
    }
    killTree("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
    // 无条件清尾：leader 先退但组内孙进程可能还在持管道；组已空时 ESRCH 静默
    killTree("SIGKILL");
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
    if (child) await this.terminateProcessTree(child);

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
          // 回合边界检查上下文滚动：串行队列保证滚动与用户回合互不交错，
          // 滚动期间入队的新 prompt 自然排在换好的新进程上执行
          if (!this.closed && !this.rollFailed && (await this.shouldRoll())) {
            await this.rollContext();
          }
        } catch (err) {
          item.reject(err as Error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 执行一个回合。普通回合：user_text 落库 → prompt → 回合结束 advisory。
   * 内部回合（opts.internal，上下文滚动的摘要 turn）：不落 user_text（用户没说过这话，
   * 落一条 advisory 作「正在压缩」的可见标记）、不落回合结束 advisory、不触发 MCP 冒烟提示；
   * agent_message_chunk 只进聚合槽不落库（见 appendAggregated），回合结束后把聚合到的
   * 全部 agent_text 段作为摘要文本返回给调用方（rollContext）。
   */
  private async runTurn(userText: string, opts: { internal?: boolean } = {}): Promise<string | null> {
    const session = this.activeSession;
    if (!session) throw new Error("session 未就绪");

    const turnId = crypto.randomUUID();
    this.currentTurnId = turnId;
    // turn 开始时清聚合槽与段号（SDK 在 prompt resolve 后可能还有 trailing chunks）
    this.aggregateSlots.clear();
    this.aggregateMessageIds.clear();
    this.aggregateSegments.clear();
    this.aggregateClosed.clear();
    this.openAggregateKey = null;
    this.internalTurn = opts.internal === true;

    if (opts.internal) {
      await this.appendMessage(
        { turnId, kind: "advisory", content: { text: "正在压缩对话上下文，稍候…" } },
        { closesAggregate: false },
      );
    } else {
      await this.appendMessage({ turnId, kind: "user_text", content: { text: userText } });
    }

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
      // 等 trailing chunks 落库，保证 advisory 的 seq 排在回合所有消息之后
      await this.drainUpdates();
      if (opts.internal) {
        // 摘要文本只活在聚合槽里，由 rollContext 落成 context_summary 行
        return this.captureTurnText(turnId);
      }
      // 回合终端消息不封闭聚合段：prompt resolve 后才到达的 trailing chunk
      // 要并回本回合最后一个同 kind 聚合段（原地更新），而不是开孤儿新段
      const advisory = await this.appendMessage(
        {
          turnId,
          kind: "advisory",
          content: { text: `—— 回合结束（${response.stopReason}）——` },
        },
        { closesAggregate: false },
      );
      this.lastTurnTerminal = { turnId, dto: advisory };
      return null;
    } catch (err) {
      await this.drainUpdates();
      // 内部回合的失败由 rollContext 统一落提示，这里不再叠加 error 消息
      if (!opts.internal) {
        const failure = await this.appendMessage(
          {
            turnId,
            kind: "error",
            content: { text: `回合失败：${(err as Error).message}` },
          },
          { closesAggregate: false },
        );
        this.lastTurnTerminal = { turnId, dto: failure };
      }
      throw err;
    } finally {
      this.internalTurn = false;
      await this.setStatus("idle").catch(() => {});
      // MCP 冒烟：会话从未见过毛线团工具调用 → 一次性提示。
      // mcpToolCallSeen 初值来自 DB 持久化的 hasMcpCall（重启/换实例不丢），
      // 回合内的 /mcp 真实命中经 manager.noteMcpCall 路由进来置位
      if (!opts.internal && !this.mcpToolCallSeen && !this.mcpHintSent) {
        this.mcpHintSent = true;
        // 服务端注记，不算 agent 事件：不封闭聚合段，迟到 chunk 仍能并回回合末段
        await this.appendMessage({ ...mcpHintMessage() }, { closesAggregate: false });
      }
    }
  }
  private currentTurnId: string | null = null;
  /**
   * 最近收尾回合的终端消息（end_turn advisory / 回合失败 error）。
   * kimi 会把末尾 chunk 在 prompt() resolve 之后才推过来——drainUpdates 只能等「已到本地
   * 未消费完」的更新，等不到尚未上线的通知。迟到的文本 chunk 会并回该回合最后一个
   * 同 kind 聚合段（appendAggregated，原地更新不产生新消息）；迟到的真实事件/新段
   * 落库时（见 appendMessage）把终端消息重赋 seq 排到回合最后，
   * 保证回合结束标记恒为回合内最后一条。
   */
  private lastTurnTerminal: { turnId: string; dto: ChatMessageDto } | null = null;

  /** /mcp 工具面真实命中（请求带本会话 token）时由 manager 路由过来——比 agent 通知更可靠的判据 */
  noteMcpObserved() {
    this.mcpToolCallSeen = true;
  }

  cancelTurn(): void {
    // ACP 的 cancel 是 client→agent 通知；SDK 未封装到 ActiveSession，
    // 通过底层 connection 发送。ActiveSession 无此接口，退化为提示。
    // v1 实现见 fake agent 测试与 kimi 真机验证后补全。
    void this.activeSession;
  }

  // ---------- update 流 ----------

  /** 更新流消费统计：drainUpdates 据此判断 trailing chunks 是否已全部落库 */
  private updatesReceived = 0;
  private updatesHandled = 0;
  /** 消费循环正阻塞在 nextUpdate()（= 手头没有未处理的更新） */
  private consumerIdle = false;

  private consumeUpdates() {
    const session = this.activeSession;
    if (!session) return;
    void (async () => {
      for (;;) {
        try {
          this.consumerIdle = true;
          const message = await session.nextUpdate();
          this.consumerIdle = false;
          if (message.kind === "stop") continue; // stop 已由 prompt() 的 resolve 处理
          this.updatesReceived++;
          await this.handleUpdate(message.update);
          this.updatesHandled++;
        } catch (err) {
          this.consumerIdle = false;
          // restarting 下的流断开是旧进程拆除的预期结果；closed 亦然
          if (this.closed || this.restarting) return;
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

  /**
   * prompt() resolve 不等于更新流消费完：SDK 按行处理 NDJSON，response 之前的
   * trailing chunks 可能还在消费循环的 DB 写入里排队。若直接落「回合结束」advisory，
   * 后续 chunk 开的新段会拿到更大的 seq，显示顺序颠倒（分段后从隐藏问题变成可见问题）。
   * 这里等到「消费循环空闲且 received==handled」连续稳定两个事件循环 tick 才放行；
   * 有上限兜底，异常时不挂死回合。
   */
  private async drainUpdates(maxTicks = 500) {
    let stable = 0;
    for (let i = 0; i < maxTicks && stable < 2; i++) {
      await new Promise((r) => setImmediate(r));
      if (this.consumerIdle && this.updatesReceived === this.updatesHandled) stable++;
      else stable = 0;
    }
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
        // tool_call 的续报，不算新事件：不封闭当前聚合段（agent 可能在工具进行期间持续输出）
        await this.appendMessage(
          {
            turnId: this.currentTurnId,
            kind: "tool_call_update",
            content: {
              toolCallId: update.toolCallId,
              status: update.status,
              content: update.content ?? null,
            },
          },
          { closesAggregate: false },
        );
        // kimi 只发 tool_call_update 不发 tool_call 初始通知：带 title 时同样参与 MCP 判定，
        // 否则 mcpToolCallSeen 永不置位，回合结束冒出「没有出现过毛线团工具调用」的误报提示
        if (isYarnballToolCallTitle(update.title ?? undefined)) {
          this.mcpToolCallSeen = true;
          this.markMcpObserved(this.sessionRow.id);
        }
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
   * 同 turn 同 kind 同段的 chunk 聚合成一条消息，原地更新（seq 不变，id 不变）。
   * 前端按 id upsert，实现平滑流式渲染。
   *
   * 分段：tool_call / plan / permission 等真实事件（任何走 appendMessage 且
   * closesAggregate 的消息）会封闭当前聚合段（记入 aggregateClosed），后续 chunk
   * 开新段（segment+1）——实现「agent 输出 → 工具调用 → agent 输出」的多块交错。
   * 回合收尾后（终端 advisory/error 落库不封闭段），迟到的 trailing chunk 并回
   * 该 kind 的最后一段原地更新——除非该段已被迟到的真实事件封闭（如晚到的
   * tool_call 首通知），那种情况仍开新段。
   */
  private async appendAggregated(kind: "agent_text" | "agent_thought", text: string) {
    // 内部回合（摘要 turn）：agent 输出只进聚合槽不落库——摘要由 rollContext
    // 聚合成一条 context_summary 行承载，避免「正在压缩」提示与摘要正文重复入流
    if (this.internalTurn) {
      const key = `${this.currentTurnId}:${kind}:0`;
      this.aggregateSlots.set(key, (this.aggregateSlots.get(key) ?? "") + text);
      return;
    }
    let segment = this.aggregateSegments.get(kind) ?? 0;
    let key = `${this.currentTurnId}:${kind}:${segment}`;
    if (this.aggregateSlots.has(key)) {
      const turnEnded = this.lastTurnTerminal?.turnId === this.currentTurnId;
      // 开新段的两个理由：① 段被真实事件封闭（多段交错语义不可退化）；
      // ② 回合进行中另一种 kind 的 chunk 插过队。回合已收尾时 ② 不适用——
      // trailing chunk 一律并回该 kind 的最后一段
      if (this.aggregateClosed.has(key) || (!turnEnded && this.openAggregateKey !== key)) {
        segment += 1;
        this.aggregateSegments.set(kind, segment);
        key = `${this.currentTurnId}:${kind}:${segment}`;
      }
    }

    // 先打开本段再 await：权限三条并发路径在消费循环外调 appendMessage 封闭段，
    // 若在 await 后才设 openAggregateKey，恢复时会把刚被封闭的段重新打开，
    // 后续 chunk 并回权限事件之前的旧段，显示顺序颠倒
    this.openAggregateKey = key;

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
      // 段首插入走 appendMessage 但不许它封闭自己刚打开的段
      const dto = await this.appendMessage(
        { turnId: this.currentTurnId, kind, content: { text: updated } },
        { closesAggregate: false },
      );
      this.aggregateMessageIds.set(key, dto.id);
    }
  }

  private seqCache = new Map<string, number>();
  private seqOf(messageId: string): number | undefined {
    return this.seqCache.get(messageId);
  }

  // ---------- 上下文滚动 ----------

  /** 内部回合结束后取回聚合槽里的 agent_text 文本（多段以换行拼接；空回合返回 null） */
  private captureTurnText(turnId: string): string | null {
    const parts: string[] = [];
    for (let i = 0; ; i++) {
      const text = this.aggregateSlots.get(`${turnId}:agent_text:${i}`);
      if (text == null) break;
      parts.push(text.trim());
    }
    const joined = parts.join("\n\n").trim();
    return joined.length > 0 ? joined : null;
  }

  /**
   * 是否应该滚动：本连接自建立以来累计的转录字符数（user_text + agent_text，
   * 不含摘要 turn 自身的输出）超过阈值。DB 全量行数不参与判定——上下文膨胀
   * 是「本连接喂给模型的量」，与界面历史长度无关。
   *
   * 已滚动过的会话只累计「最近一次滚动点（context_summary.throughSeq）之后」
   * 的行：滚动换新进程后喂给模型的是「摘要 + 滚动点后原文」，若继续全量累计，
   * 被摘要覆盖的历史永远超阈值，每个回合边界都会再次触发重建。
   */
  private async shouldRoll(): Promise<boolean> {
    const [lastRoll] = await this.db
      .select({ throughSeq: schema.chatMessages.seq })
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.sessionId, this.sessionRow.id),
          eq(schema.chatMessages.kind, "context_summary"),
        ),
      )
      .orderBy(desc(schema.chatMessages.seq))
      .limit(1);
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(length(${schema.chatMessages.content})), 0)` })
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.sessionId, this.sessionRow.id),
          // 只算会说话的 kind：tool_call rawInput 等卡片数据是给用户看的，不进模型上下文
          sql`${schema.chatMessages.kind} in ('user_text', 'agent_text')`,
          // 有滚动点则只算其后新增的（无滚动点时 gt 0 保持全量语义）
          gt(schema.chatMessages.seq, lastRoll?.throughSeq ?? 0),
        ),
      );
    return (row?.total ?? 0) >= contextRollThresholdChars();
  }

  /**
   * 上下文滚动：转录超阈值时，先让老 agent 写交接摘要，再原地换一个新 agent 进程，
   * 新进程用「摘要 + 滚动点之后的近期原文」回放。对用户只是多一条「正在压缩」提示
   * 和一条 context_summary 分隔线；消息流不断（seq 续号）。
   *
   * 失败策略：任一步失败落 advisory 提示并置 rollFailed（本连接不再自动滚动，
   * 直到换句柄重置）——绝不把会话标 error，老进程若还活着就继续用。
   */
  private async rollContext(): Promise<void> {
    const throughSeq = this.seq;
    console.log(`[acp:${this.sessionRow.id}] context roll triggered (seq=${throughSeq})`);
    try {
      // ① 老 agent 写交接摘要（内部回合：不落 user_text/回合结束标记）
      const summary = await this.runTurn(CONTEXT_SUMMARY_PROMPT, { internal: true });
      if (!summary || summary.length < 100) {
        throw new Error(`摘要内容过短（${summary?.length ?? 0} 字符）`);
      }

      // ② 原地换新进程：停旧连接（restarting 标记让 exit/流断开不再落错误消息），
      //    同一 this 重新 start() —— seq 续号、聚合状态清空、首个 prompt 重走 bootstrap。
      //    start() 的函数体挂在 connectWith 回调的生命周期上不会返回（与 startSession 同理
      //    只能 void），可用性靠 whenReady 判定
      this.restarting = true;
      try {
        await this.teardownConnection("context roll");
        this.activeSession = null;
        this.firstPromptDone = false;
        this.rollFailed = false;
        void this.start();
        await this.whenReady;
      } finally {
        this.restarting = false;
      }

      // ③ 摘要 + 滚动点之后的近期原文（近 2 万字符，尾部硬截断）作为新连接的回放
      const replay = await this.buildRollReplay(summary, throughSeq);
      this.pendingReplay = replay;

      // ④ 分隔线落库：前端据此渲染「上下文已压缩」标记（可展开看摘要全文）
      await this.appendMessage(
        {
          turnId: null,
          kind: "context_summary",
          content: { text: summary, throughSeq },
        },
        { closesAggregate: false },
      );
      console.log(`[acp:${this.sessionRow.id}] context roll done (summary ${summary.length} chars, replay ${replay.length} chars)`);
    } catch (err) {
      this.rollFailed = true;
      console.warn(`[acp:${this.sessionRow.id}] context roll failed:`, err);
      await this.appendMessage(
        {
          turnId: null,
          kind: "advisory",
          content: {
            text: `对话上下文较长，自动压缩未完成（${(err as Error).message}）；本次继续使用原上下文。如遇回复变慢或遗忘，可新建会话。`,
          },
        },
        { closesAggregate: false },
      ).catch(() => {});
      // 换进程阶段失败（② 之后异常）：旧连接已拆、activeSession 已清、新进程没起来，
      // 本句柄已不可用。摘除自己 + 落 error 态，后续 prompt 走 REST 层懒恢复重建新句柄，
      // 而不是复用死句柄反复报「session 未就绪」。
      // （摘要阶段失败的路径不触达：旧进程还在，老连接继续可用。）
      if (!this.activeSession) {
        this.unregisterSelf?.();
        await this.setStatus("error", `上下文压缩中重建 agent 失败：${(err as Error).message}。发送消息时会自动重连。`)
          .catch(() => {});
      }
    }
  }

  /** 滚动回放：交接摘要 + 滚动点之后保留的近期原文（user/agent 文本，尾部截断到预算内） */
  private async buildRollReplay(summary: string, throughSeq: number): Promise<string> {
    const messages = await this.db
      .select({ kind: schema.chatMessages.kind, content: schema.chatMessages.content })
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.sessionId, this.sessionRow.id),
          gt(schema.chatMessages.seq, throughSeq),
          sql`${schema.chatMessages.kind} in ('user_text', 'agent_text')`,
        ),
      )
      .orderBy(desc(schema.chatMessages.seq))
      .limit(200);
    const recentBudget = 20_000;
    const parts: string[] = [];
    let used = 0;
    for (const m of messages) {
      const text = String((m.content as { text?: string }).text ?? "").trim();
      if (!text) continue;
      const line = `${m.kind === "user_text" ? "用户" : "你"}: ${text}\n`;
      if (used + line.length > recentBudget) break;
      parts.unshift(line);
      used += line.length;
    }
    return [
      `【上下文压缩】本会话此前的对话已压缩。以下是上一个 agent 留下的交接摘要（此后以它为准继续）：`,
      ``,
      summary,
      ``,
      ...(parts.length > 0
        ? [`压缩之后最近的对话原文：`, ``, ...parts]
        : []),
    ].join("\n");
  }

  /**
   * 只拆连接不置终态：close() 的完整收尾（closed 标记、状态落库、token 回收）
   * 对上下文滚动不适用——滚动后句柄继续服役。复用 close 的拆除序列，单独实现。
   */
  private async teardownConnection(reason: string): Promise<void> {
    this.settleAllPermissions();
    this.releaseConnect?.();
    this.releaseConnect = null;
    try {
      this.activeSession?.dispose();
    } catch {}
    const child = this.process;
    if (child) await this.terminateProcessTree(child);
    this.process = null;
    void reason;
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
    // permission 请求自带 toolCall.title，是 yarnball 工具调用的旁证
    //（agent 可能既不发 tool_call 也不在 tool_call_update 里带 title）
    if (isYarnballToolCallTitle(ctx.params.toolCall.title ?? undefined)) {
      this.mcpToolCallSeen = true;
      this.markMcpObserved(this.sessionRow.id);
    }
    const decision = decidePermission({
      params: ctx.params,
      allowAll: row?.allowAllPermissions ?? false,
    });

    if (decision.action === "auto_approve") {
      // 纯注记：不封闭聚合段（与 tool_call_update 同级豁免），否则「我先拉」类文本被劈成两块
      await this.appendMessage(
        {
          turnId: this.currentTurnId,
          kind: "permission_result",
          content: {
            toolCallTitle: ctx.params.toolCall.title,
            outcome: decision.reason,
            autoApproved: true,
          },
        },
        { closesAggregate: false },
      );
      return { outcome: { outcome: "selected", optionId: decision.optionId } };
    }

    const parked = parkPermission(
      {
        sessionId: this.sessionRow.id,
        requestId: `perm-${++this.permissionSeq}-${ctx.requestId}`,
        toolCall: ctx.params.toolCall,
        options: ctx.params.options,
        resolve: () => {},
      },
      () => this.settlePermissionTimeout(parked),
    );
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

  /**
   * 超时结算：移除 parked 记录（之后的用户点击拿到「已失效」而不是落假「已允许」），
   * 并落一条 permission_result（带 requestId），UI 权限卡据此进入已答态。
   */
  private settlePermissionTimeout(parked: ParkedPermission) {
    const idx = this.parkedPermissions.indexOf(parked);
    if (idx !== -1) this.parkedPermissions.splice(idx, 1);
    // 纯注记：不封闭聚合段
    void this.appendMessage(
      {
        turnId: this.currentTurnId,
        kind: "permission_result",
        content: {
          requestId: parked.pending.requestId,
          toolCallTitle: parked.pending.toolCall.title,
          outcome: "超时未响应，已自动拒绝",
          autoApproved: false,
        },
      },
      { closesAggregate: false },
    );
  }

  /** UI 决策入口（REST 路由调用）。返回 false = 该 requestId 已不存在（已超时结算/会话重开），调用方据此回复「已失效」 */
  userDecidesPermission(requestId: string, outcome: PermissionOutcome): boolean {
    const idx = this.parkedPermissions.findIndex((p) => p.pending.requestId === requestId);
    if (idx === -1) return false;
    const [parked] = this.parkedPermissions.splice(idx, 1);
    parked.userDecides(outcome);
    // 纯注记：不封闭聚合段
    void this.appendMessage(
      {
        turnId: this.currentTurnId,
        kind: "permission_result",
        content: {
          requestId,
          toolCallTitle: parked.pending.toolCall.title,
          outcome: outcome.optionId ? `已允许（${outcome.optionName}）` : "已拒绝",
          autoApproved: false,
        },
      },
      { closesAggregate: false },
    );
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
      // env 只送 override 时必须 merge 继承环境，不能替换；PATH 用增强版（与 agent 主进程 spawn 一致）
      env: { ...(await getEnhancedEnv()), ...envOverride },
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

  /**
   * 状态落库 + SSE 推送 session 快照（前端状态灯/重连提示实时刷新，不必等轮询）。
   * 非 closed 写入带 status != 'closed' 条件：closed 是终态（用户主动断开/删行程），
   * 并发路径（启动失败清理、agent 崩溃回调）不得把它覆盖回 error/idle。
   */
  private async setStatus(status: string, lastError?: string | null) {
    try {
      await this.db
        .update(schema.chatSessions)
        .set({ status, ...(lastError !== undefined ? { lastError } : {}), updatedAt: new Date() })
        .where(
          status === "closed"
            ? eq(schema.chatSessions.id, this.sessionRow.id)
            : and(eq(schema.chatSessions.id, this.sessionRow.id), ne(schema.chatSessions.status, "closed")),
        );
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
    opts: { closesAggregate?: boolean } = {},
  ): Promise<ChatMessageDto> {
    // 真实事件（tool_call/plan/permission_request/user_text…）介入即封闭当前聚合段
    // （记入 aggregateClosed），后续 agent chunk 会开新段（appendAggregated 先打开新段
    // 再走这里，传 closesAggregate:false）；豁免名单：tool_call_update 是 tool_call 的续报、
    // permission_result 只是权限卡的结论注记、回合终端 advisory/error 与 MCP 提示注记——
    // 都不应把连贯文本劈成两段，迟到 trailing chunk 还要并回该 kind 的末段
    if (opts.closesAggregate ?? true) {
      if (this.openAggregateKey) this.aggregateClosed.add(this.openAggregateKey);
      this.openAggregateKey = null;
    }
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
    // 迟到消息（prompt resolve 后才到达的 chunk/事件）属于已收尾回合时，把该回合的
    // 终端消息（advisory/error）重排到最后，避免「回合结束」之后孤悬一条 agent 输出
    const terminal = this.lastTurnTerminal;
    if (terminal && message.turnId === terminal.turnId && dto.id !== terminal.dto.id) {
      await this.promoteTurnTerminal(terminal);
    }
    return dto;
  }

  /** 重赋回合终端消息的 seq 到当前最大并补发 SSE，DB 与前端流式渲染都恢复「终端收尾」顺序 */
  private async promoteTurnTerminal(terminal: { turnId: string; dto: ChatMessageDto }) {
    const seq = ++this.seq;
    await this.db
      .update(schema.chatMessages)
      .set({ seq })
      .where(eq(schema.chatMessages.id, terminal.dto.id));
    this.seqCache.set(terminal.dto.id, seq);
    terminal.dto = { ...terminal.dto, seq };
    this.bus.publish(chatChannel(this.sessionRow.id), { type: "message", message: terminal.dto });
  }

  private async listMessages(): Promise<ChatMessageDto[]> {
    return listAllChatMessages(this.db, this.sessionRow.id);
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
