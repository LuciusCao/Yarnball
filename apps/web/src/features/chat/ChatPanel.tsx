import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { AgentRegistryDto, ChatMessageDto, ChatSessionDto, TripDto } from "@yarnball/shared";
import { toast } from "sonner";
import { AlertTriangle, Brain, CalendarClock, Check, Clock, ListChecks, Loader2, SendHorizontal, ShieldCheck, Unplug, X } from "lucide-react";
import { api } from "../../api/client";
import { api as libApi } from "../../lib/api";
import {
  TRANSIT_KIND_META,
  transitKindOf,
  transitRouteText,
} from "../itinerary/transit";
import { Button } from "../../components/ui/button";
import { Textarea, Select } from "../../components/ui/input";
import { useChatStore } from "../../stores/tripStore";

/**
 * 对话面板：与用户 agent 的交流界面。
 * - 流式 agent 消息：流式中纯文本渲染，完成后 markdown 渲染（避免半截 markdown 抖动）
 * - tool_call 卡片：按 toolCallId 归并，可展开
 * - permission 待答卡：允许/拒绝 + allow-all
 */

interface ChatPanelProps {
  trip: TripDto;
  sessions: ChatSessionDto[];
  onSessionsChanged: () => void;
  selectedPlaceId: string | null;
}

/** 空态引导示例话术：未连接时静态展示；已连接空会话时点击填入输入框 */
const EXAMPLE_PROMPTS = [
  "这是我从攻略里复制的行程，帮我解析成地点",
  "帮我推荐几家住宿区域附近的酒店",
  "把想去的餐厅列给我，我挑几家加入行程",
] as const;

/** 会话状态中文标签（原始 status 枚举对用户无意义） */
const STATUS_LABEL: Record<ChatSessionDto["status"], string> = {
  starting: "连接中",
  idle: "已连接",
  running: "处理中",
  error: "连接异常",
  closed: "已断开",
};

export function ChatPanel({ trip, sessions, onSessionsChanged, selectedPlaceId }: ChatPanelProps) {
  // GET /api/agents 现在返回全部注册 agent（含 disabled，带 command/args）——只保留 enabled
  const [agents, setAgents] = useState<AgentRegistryDto[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.status !== "closed") ?? null,
    [sessions],
  );
  const { messages, subscribe, reset, upsertMessage } = useChatStore();

  useEffect(() => {
    void libApi.listAgents().then(({ agents }) => {
      const enabled = agents.filter((a) => a.enabled);
      setAgents(enabled);
      setAgentsLoaded(true);
      if (enabled.length > 0) setAgentId((prev) => prev || enabled[0].id);
    });
  }, []);

  useEffect(() => {
    if (!activeSession) {
      reset();
      return;
    }
    const unsubscribe = subscribe(activeSession.id);
    // UI 选中态回写（agent 经 get_trip_context 实时读）
    void api.setUiContext(activeSession.id, { selectedPlaceId, tripId: trip.id });
    return unsubscribe;
  }, [activeSession?.id, reset, subscribe, trip.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // 轮询 session 状态（running→idle 切换驱动 UI；服务端状态变化也会发 SSE session 事件，
  // 但 chat store 目前只消费 message 事件，头部状态灯仍以轮询为准）
  useEffect(() => {
    if (!activeSession) return;
    const timer = setInterval(() => onSessionsChanged(), 3000);
    return () => clearInterval(timer);
  }, [activeSession?.id, onSessionsChanged]);

  async function startSession() {
    if (!agentId) return;
    setStarting(true);
    try {
      await api.createChatSession(trip.id, agentId);
      onSessionsChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  /** 「重新连接」：server 重启 / agent 崩溃后的手动懒恢复（与 prompt 自动恢复同路径） */
  async function reconnect() {
    if (!activeSession) return;
    setReconnecting(true);
    try {
      await libApi.reconnectChatSession(activeSession.id);
      onSessionsChanged();
    } catch (err) {
      toast.error((err as Error).message);
      onSessionsChanged();
    } finally {
      setReconnecting(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || !activeSession) return;
    setInput("");
    try {
      await api.sendPrompt(activeSession.id, text);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  /**
   * 「规划每日行程」引导：拉当前 bundle，把已加入行程/候选地点摘要 + 区域聚类建议（M11）+
   * 大交通锚点组装成预制指令，走现有发送链路发给 agent，提示按区域成片分天。
   * place.status 来自 shared 契约：locked=必排，candidate=按顺路取舍。
   */
  async function planDays() {
    if (!activeSession) return;
    setPlanning(true);
    try {
      const { bundle } = await api.getBundle(trip.id);
      const locked = bundle.places.filter((p) => p.status === "locked");
      const candidates = bundle.places.filter((p) => p.status !== "locked");
      if (locked.length === 0 && candidates.length === 0) {
        toast.info("还没有地点。先让 agent 解析攻略，或在「添加地点」里手动加几个。");
        return;
      }
      const fmt = (list: typeof bundle.places) =>
        list
          .map((p) => `${p.name}${p.durationMin ? `（约${p.durationMin}分钟）` : ""}`)
          .join("、") || "（无）";

      // 区域聚类建议（M11：GET /api/trips/:tripId/suggest-clusters，lib/api 单点）；失败时静默降级，不阻塞规划引导
      let clusterLines: string[] = [];
      try {
        const { suggestion } = await libApi.suggestDayClusters(trip.id);
        clusterLines = suggestion.clusters
          .map((c) => {
            const names = c.places.map((p) => p.name).join("、");
            if (!names) return null;
            const day = c.suggestedDayIndex != null ? `（建议排 Day ${c.suggestedDayIndex}）` : "";
            return `区域${c.clusterIndex + 1}${day}：${names}`;
          })
          .filter((l): l is string => l != null);
      } catch {
        // 聚类端点不可用时忽略，提示 agent 自行聚类
      }

      // 大交通锚点（M11）：抵达/离开/城市间时刻固定，排程须对齐（类别按所处天推断）
      const dayIndexById = new Map(bundle.days.map((d) => [d.id, d.dayIndex]));
      const placeById = new Map(bundle.places.map((p) => [p.id, p]));
      const totalDays = bundle.days.length;
      const anchorLines = bundle.entries
        .filter((e) => e.entryType === "transit")
        .map((e) => {
          const kind = TRANSIT_KIND_META[transitKindOf(e, dayIndexById.get(e.dayId) ?? 0, totalDays) ?? "intercity"].label;
          const times = [e.departTime, e.arriveTime].filter(Boolean).join("–");
          const route = transitRouteText(e, placeById) ?? "";
          return `Day ${dayIndexById.get(e.dayId) ?? "?"} ${times ? `${times} ` : ""}${kind}${route ? ` ${route}` : ""}`;
        });

      const lines = [
        `请帮我规划这次「${bundle.trip.destinationCity}」之行的每日行程，按区域成片分天：同一片区的地点尽量排在同一天，减少跨区折返。`,
        `已加入行程（必须排入）：${fmt(locked)}`,
        `候选地点（按顺路和体验取舍）：${fmt(candidates)}`,
      ];
      if (clusterLines.length > 0) {
        lines.push(`区域聚类建议（按地理位置分组，供分天参考）：\n${clusterLines.join("\n")}`);
      } else {
        lines.push("请先把上述地点按地理位置聚类，再按区域成片分天。");
      }
      if (anchorLines.length > 0) {
        lines.push(
          `大交通锚点（时刻固定不可变动，排程须对齐：到达日从落地时间起算，离开日预留前往机场/车站的时间）：\n${anchorLines.join("\n")}`,
        );
      }
      lines.push(
        `当前已有 ${bundle.days.length} 天日程框架。要求：每天从 09:00 开始（有大交通锚点的天以锚点为准），为每个地点写入 startTime，交通段自动计算；排完后简述安排思路。`,
      );
      await api.sendPrompt(activeSession.id, lines.join("\n"));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPlanning(false);
    }
  }

  async function closeSession() {
    if (!activeSession) return;
    await api.closeChatSession(activeSession.id);
    reset();
    onSessionsChanged();
  }

  if (!activeSession) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-slate-600">
          连接你自己的 agent，让它直接在这份行程上工作：
          <br />
          粘贴攻略 / 酒店候选，解析、定位、编排。
        </p>
        {/* 全部注册 agent 都被停用时：不渲染空下拉，引导去设置页启用 */}
        {agentsLoaded && agents.length === 0 ? (
          <p className="text-xs text-amber-600">
            没有已启用的 agent —— 请先到设置页注册或启用一个 agent。
          </p>
        ) : (
          <div className="flex gap-2">
            <Select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="h-10 px-3"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
            <Button variant="primary" size="lg" onClick={startSession} disabled={starting || !agentId}>
              {starting ? "启动中…" : "连接 agent"}
            </Button>
          </div>
        )}
        {starting && <p className="text-xs text-slate-400">正在启动 agent 子进程…</p>}
        {/* 示例话术 chips：未连接时静态预览，告诉用户连上后能说什么 */}
        <div className="flex max-w-[280px] flex-col items-center gap-1.5">
          <p className="text-[11px] text-slate-400">连接后可以这样说：</p>
          {EXAMPLE_PROMPTS.map((text) => (
            <span
              key={text}
              className="rounded-full border border-slate-300/60 bg-white/50 px-3 py-1 text-[11px] text-slate-500"
            >
              {text}
            </span>
          ))}
        </div>
        {/* 规划引导（空态置灰）：连接 agent 后一键把已加入行程/候选地点发给 agent 排程 */}
        <button
          disabled
          title="先连接 agent，再让它规划每日行程"
          className="flex items-center gap-1.5 rounded-full border border-slate-300/50 px-3 py-1.5 text-xs text-slate-400 opacity-60"
        >
          <CalendarClock className="size-3.5" />
          规划每日行程（先连接 agent）
        </button>
      </div>
    );
  }

  const running = activeSession.status === "running";
  // starting = 首次启动或断线懒恢复进行中（server 重启后 prompt/reconnect 触发）
  const connecting = activeSession.status === "starting";

  return (
    <div className="flex h-full flex-col">
      {/* 会话头（右侧留出面板收起把手的高度） */}
      <div className="flex items-center gap-2 border-b border-slate-900/8 pl-3 pr-11 py-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${connecting ? "animate-pulse" : ""}`} style={{
          background:
            activeSession.status === "running" ? "#f59e0b" :
            activeSession.status === "error" ? "#ef4444" :
            activeSession.status === "idle" ? "#22c55e" : "#94a3b8",
        }} />
        <span className="text-sm font-medium">{activeSession.agentLabel}</span>
        <span className="text-xs text-slate-400">
          {connecting && messages.length > 0 ? "重连中" : STATUS_LABEL[activeSession.status]}
        </span>
        <label className="ml-auto flex items-center gap-1 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={activeSession.allowAllPermissions}
            onChange={(e) => {
              void api.setAllowAll(activeSession.id, e.target.checked).then(onSessionsChanged);
            }}
          />
          允许全部权限
        </label>
        <Button
          variant="outline"
          size="sm"
          onClick={closeSession}
          title="断开 agent"
          className="h-6 gap-1 px-2 text-[11px]"
        >
          <Unplug className="size-3" />
          断开
        </Button>
      </div>

      {/* 断线恢复中：提示用户不要重复点击，恢复完成后自动回到 idle */}
      {connecting && (
        <div className="flex items-center gap-1.5 border-b border-amber-200/60 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700">
          <Loader2 className="size-3 animate-spin" />
          {messages.length > 0 ? "正在重连 agent…（恢复此前的对话上下文）" : "正在启动 agent…"}
        </div>
      )}

      {activeSession.lastError && (
        <div className="flex items-center gap-2 border-b border-red-200/60 bg-red-500/10 px-3 py-1.5 text-xs text-red-600">
          <span className="flex-1">{activeSession.lastError}</span>
          {activeSession.status === "error" && (
            <button
              onClick={() => void reconnect()}
              disabled={reconnecting}
              className="flex shrink-0 items-center gap-1 rounded-md border border-red-300/70 bg-white/70 px-2 py-0.5 font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
            >
              {reconnecting ? <Loader2 className="size-3 animate-spin" /> : null}
              {reconnecting ? "重连中…" : "重新连接"}
            </button>
          )}
        </div>
      )}

      {/* 消息流 */}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {/* 已连接的空会话：引导第一条消息，chips 点击填入输入框 */}
        {messages.length === 0 && !running && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-xs text-slate-500">
              把你的攻略文本直接粘贴给我，我会解析成地点放进候选池。
            </p>
            {EXAMPLE_PROMPTS.map((text) => (
              <button
                key={text}
                onClick={() => setInput(text)}
                className="rounded-full border border-scheduled/30 bg-scheduled/8 px-3 py-1 text-[11px] text-scheduled transition-colors hover:bg-scheduled/15"
              >
                {text}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            running={running}
            onAnswerPermission={async (requestId, optionId) => {
              await api.answerPermission(activeSession.id, requestId, optionId);
            }}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入 */}
      <div className="border-t border-slate-900/8 p-3">
        {/* 规划引导（主行动点）：把已加入行程/候选地点摘要组装成预制指令发给 agent */}
        <button
          onClick={() => void planDays()}
          disabled={running || planning || connecting}
          title="把当前已加入行程/候选地点发给 agent，让它排每日行程（含 startTime 与交通段）"
          className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-brand-hover disabled:opacity-50"
        >
          {planning ? <Loader2 className="size-3.5 animate-spin" /> : <CalendarClock className="size-3.5" />}
          规划每日行程
        </button>
        <div className="relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={
              running ? "agent 处理中…" :
              connecting ? "正在重连 agent…" :
              "粘贴攻略文本，或直接说：把 Bondi Beach 安排到 Day 2"
            }
            disabled={running || connecting}
            className="pr-14"
          />
          <button
            onClick={() => void send()}
            disabled={running || connecting || !input.trim()}
            title="发送"
            className="absolute bottom-2.5 right-2 flex size-8 items-center justify-center rounded-full bg-brand text-white shadow transition-all enabled:hover:bg-brand-hover disabled:opacity-40"
          >
            <SendHorizontal className="size-4" />
          </button>
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          agent 的每次操作会实时反映在地图上 · {messages.length} 条消息
        </p>
      </div>
    </div>
  );
}

// ---------- 消息渲染 ----------

function MessageBubble({
  message,
  running,
  onAnswerPermission,
}: {
  message: ChatMessageDto;
  running: boolean;
  onAnswerPermission: (requestId: string, optionId: string | null) => Promise<void>;
}) {
  switch (message.kind) {
    case "user_text":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-3 py-2 text-sm text-white shadow">
            {String(message.content.text ?? "")}
          </div>
        </div>
      );
    case "agent_text": {
      const text = String(message.content.text ?? "");
      // 流式中纯文本（半截 markdown 渲染会抖动）；完成后渲染 markdown。
      return (
        <div className="flex justify-start">
          <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-white/85 px-3 py-2 text-sm text-slate-800 shadow-sm">
            {running ? text : <Markdown text={text} />}
          </div>
        </div>
      );
    }
    case "agent_thought":
      return (
        <details className="rounded-lg border border-slate-900/8 bg-white/50 px-3 py-1.5 text-xs text-slate-500">
          <summary className="flex cursor-pointer select-none items-center gap-1.5">
            <Brain className="size-3" />
            思考过程
          </summary>
          <div className="mt-1 whitespace-pre-wrap">{String(message.content.text ?? "")}</div>
        </details>
      );
    case "tool_call":
      return <ToolCallCard message={message} />;
    case "tool_call_update":
      return null;
    case "plan":
      return (
        <div className="rounded-lg border border-slate-900/8 bg-white/60 px-3 py-2 text-xs">
          <p className="mb-1 flex items-center gap-1.5 font-medium text-slate-600">
            <ListChecks className="size-3.5" />
            计划
          </p>
          <ol className="list-inside list-decimal space-y-0.5 text-slate-600">
            {(message.content.entries as { content: string; status?: string }[] | undefined)?.map(
              (e, i) => (
                <li key={i} className={e.status === "completed" ? "text-slate-400 line-through" : ""}>
                  {e.content}
                </li>
              ),
            )}
          </ol>
        </div>
      );
    case "permission_request": {
      const toolCall = message.content.toolCall as { title?: string } | undefined;
      const options = (message.content.options as { optionId: string; name: string; kind: string }[]) ?? [];
      const requestId = String(message.content.requestId ?? "");
      return (
        <div className="rounded-lg border border-amber-300/70 bg-amber-100/70 px-3 py-2 text-sm shadow-sm">
          <p className="flex items-center gap-1.5 font-medium text-amber-800">
            <ShieldCheck className="size-4 shrink-0" />
            请求权限：{toolCall?.title ?? "工具调用"}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {options.map((o) => (
              <button
                key={o.optionId}
                onClick={() => void onAnswerPermission(requestId, o.optionId)}
                className={`rounded-lg px-3 py-1 text-xs font-medium shadow-sm ${
                  o.kind.startsWith("allow")
                    ? "bg-amber-600 text-white hover:bg-amber-700"
                    : "border border-amber-400/70 bg-white/60 text-amber-700 hover:bg-amber-50"
                }`}
              >
                {o.name}
              </button>
            ))}
          </div>
        </div>
      );
    }
    case "permission_result":
      return (
        <div className="px-1 text-[11px] text-slate-400">
          {String(message.content.toolCallTitle ?? "")} → {String(message.content.outcome ?? "")}
        </div>
      );
    case "advisory":
      return (
        <div className="rounded-lg bg-white/50 px-3 py-1.5 text-[11px] text-slate-400">
          {String(message.content.text ?? "")}
        </div>
      );
    case "error":
      return (
        <div className="flex items-start gap-1.5 rounded-lg border border-red-200/70 bg-red-100/70 px-3 py-2 text-xs text-red-600">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{String(message.content.text ?? "")}</span>
        </div>
      );
    default:
      return null;
  }
}

function ToolCallCard({ message }: { message: ChatMessageDto }) {
  const [open, setOpen] = useState(false);
  const { title, status, rawInput } = message.content as {
    title?: string;
    status?: string;
    rawInput?: unknown;
  };
  const StatusIcon =
    status === "completed" ? Check : status === "failed" ? X : status === "in_progress" ? Loader2 : Clock;
  const spin = status === "in_progress";
  const statusColor =
    status === "completed"
      ? "text-emerald-600"
      : status === "failed"
        ? "text-red-500"
        : "text-slate-400";
  const summary =
    rawInput != null
      ? (() => {
          try {
            const parsed = typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput;
            return JSON.stringify(parsed).slice(0, 80);
          } catch {
            return String(rawInput).slice(0, 80);
          }
        })()
      : "";
  return (
    <div className="rounded-lg border border-slate-900/8 bg-white/70 text-xs shadow-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <StatusIcon className={`size-3.5 shrink-0 ${statusColor} ${spin ? "animate-spin" : ""}`} />
        <span className="font-medium text-slate-700">{title ?? "工具调用"}</span>
        <span className="ml-auto truncate text-slate-400">{summary}</span>
      </button>
      {open && (
        <pre className="max-h-40 overflow-auto border-t border-slate-900/8 px-3 py-2 text-[11px] text-slate-500">
          {rawInput != null ? JSON.stringify(rawInput, null, 2) : "(无输入)"}
        </pre>
      )}
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () =>
      sanitizeHtml(marked.parse(text, { async: false }) as string, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
      }),
    [text],
  );
  return (
    <div
      className="prose-sm max-w-none [&_a]:text-blue-600 [&_a]:underline [&_li]:my-0.5 [&_p]:my-1 [&_pre]:my-1 [&_pre]:overflow-auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
