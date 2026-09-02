import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { ChatMessageDto, ChatSessionDto, TripDto } from "@odessey/shared";
import { api } from "../../api/client";
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

export function ChatPanel({ trip, sessions, onSessionsChanged, selectedPlaceId }: ChatPanelProps) {
  const [agents, setAgents] = useState<{ id: string; label: string }[]>([]);
  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.status !== "closed") ?? null,
    [sessions],
  );
  const { messages, subscribe, reset, upsertMessage } = useChatStore();

  useEffect(() => {
    void api.agents().then(({ agents }) => {
      setAgents(agents);
      if (agents.length > 0) setAgentId((prev) => prev || agents[0].id);
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

  // 轮询 session 状态（running→idle 切换驱动 UI；SSE 状态推送 v2 可加）
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
      alert((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || !activeSession) return;
    setInput("");
    try {
      await api.sendPrompt(activeSession.id, text);
    } catch (err) {
      alert((err as Error).message);
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
        <div className="flex gap-2">
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="rounded-lg border border-slate-300/60 bg-white/70 px-3 py-2 text-sm"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <button
            onClick={startSession}
            disabled={starting || !agentId}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:opacity-50"
          >
            {starting ? "启动中…" : "连接 agent"}
          </button>
        </div>
        {starting && <p className="text-xs text-slate-400">正在启动 agent 子进程…</p>}
      </div>
    );
  }

  const running = activeSession.status === "running";

  return (
    <div className="flex h-full flex-col">
      {/* 会话头 */}
      <div className="flex items-center gap-2 border-b border-slate-900/8 px-3 py-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{
          background:
            activeSession.status === "running" ? "#f59e0b" :
            activeSession.status === "error" ? "#ef4444" :
            activeSession.status === "idle" ? "#22c55e" : "#94a3b8",
        }} />
        <span className="text-sm font-medium">{activeSession.agentLabel}</span>
        <span className="text-xs text-slate-400">{activeSession.status}</span>
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
        <button
          onClick={closeSession}
          className="rounded border border-slate-300/60 px-2 py-0.5 text-xs text-slate-500 hover:bg-white/60"
        >
          断开
        </button>
      </div>

      {activeSession.lastError && (
        <div className="border-b border-red-200/60 bg-red-500/10 px-3 py-1.5 text-xs text-red-600">
          {activeSession.lastError}
        </div>
      )}

      {/* 消息流 */}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
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
        <div className="flex gap-2">
          <textarea
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
              running ? "agent 处理中…" : "粘贴攻略文本，或直接说：把 Bondi Beach 安排到 Day 2"
            }
            disabled={running}
            className="flex-1 resize-none rounded-xl border border-slate-300/60 bg-white/70 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none disabled:bg-slate-100/50"
          />
          <button
            onClick={send}
            disabled={running || !input.trim()}
            className="shrink-0 self-end rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:opacity-50"
          >
            发送
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
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-3 py-2 text-sm text-white shadow">
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
          <summary className="cursor-pointer select-none">💭 思考过程</summary>
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
          <p className="mb-1 font-medium text-slate-600">📋 计划</p>
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
          <p className="font-medium text-amber-800">🔐 请求权限：{toolCall?.title ?? "工具调用"}</p>
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
        <div className="rounded-lg border border-red-200/70 bg-red-100/70 px-3 py-2 text-xs text-red-600">
          ⚠️ {String(message.content.text ?? "")}
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
  const icon =
    status === "completed" ? "✅" : status === "failed" ? "❌" : status === "in_progress" ? "🔄" : "⏳";
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
        <span>{icon}</span>
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
