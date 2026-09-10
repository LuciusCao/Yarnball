import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, KeyRound, TerminalSquare, X } from "lucide-react";
import type { AgentAvailability } from "@yarnball/shared";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";
import type { SettingsSection } from "./SettingsDrawer";

const DISMISS_KEY = "yarnball:onboarding-dismissed";
/** 密钥步骤的「跳过」标记：海外用户无需高德 key，跳过即视为完成 */
const AMAP_SKIP_KEY = "yarnball:onboarding-amap-skipped";

/**
 * 新手两步设置引导：① 连接本地 agent → ② 配置国内地图密钥（海外可跳过）。
 * 两步都完成（或密钥步被跳过）后消失；也可手动关闭，状态存 localStorage。
 * refreshKey 变化（如关闭设置抽屉）时重新检测。
 */
export function OnboardingBanner({
  onOpenSettings,
  refreshKey,
}: {
  onOpenSettings: (section: SettingsSection) => void;
  refreshKey?: number;
}) {
  const [agents, setAgents] = useState<AgentAvailability[] | null>(null);
  const [amapReady, setAmapReady] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1",
  );
  const [amapSkipped, setAmapSkipped] = useState(
    () => localStorage.getItem(AMAP_SKIP_KEY) === "1",
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ settings }, { agents }] = await Promise.all([
          api.getSettings(),
          api.detectAgents(),
        ]);
        if (cancelled) return;
        // 服务端已合并 DB 覆盖 + env 后判定三 key 是否齐备
        setAmapReady(settings.amapConfigured);
        setAgents(agents);
      } catch {
        // 后端还没有设置端点（旧版本）时静默，不打扰
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (dismissed || agents == null || amapReady == null) return null;

  const agentReady = agents.some((a) => a.enabled && a.available);
  const amapDone = amapReady || amapSkipped;
  if (agentReady && amapDone) return null;

  function skipAmap() {
    localStorage.setItem(AMAP_SKIP_KEY, "1");
    setAmapSkipped(true);
  }

  return (
    <section className="mb-8 rounded-2xl border border-amber-200/80 bg-amber-50/80 p-4 shadow-sm backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900">新用户设置引导</p>
          <ol className="mt-3 space-y-4">
            {/* 第一步：连接本地 agent */}
            <li>
              <StepHeader
                index={1}
                done={agentReady}
                icon={TerminalSquare}
                title="连接本地 agent"
              />
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                行程由你自己的 agent 驱动（通过 ACP 协议接入，如 kimi acp、gemini acp）。
                启用下方检测到的 agent，或添加一个新的。开始聊天后，可在对话面板选择用哪个
                agent。
              </p>
              {agents.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {agents.map((agent) => (
                    <li
                      key={agent.id}
                      className="flex items-center gap-2 rounded-lg bg-white/60 px-2.5 py-1.5"
                    >
                      <span
                        title={agent.available ? "命令可用" : "未检测到命令"}
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          agent.available ? "bg-emerald-500" : "bg-slate-300",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-700">
                        {agent.label}
                        <span className="ml-1.5 font-mono text-slate-400">
                          {agent.command} {agent.args.join(" ")}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-xs",
                          agent.enabled && agent.available
                            ? "text-emerald-600"
                            : "text-slate-400",
                        )}
                      >
                        {!agent.enabled ? "已停用" : agent.available ? "可用" : "未检测到命令"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!agentReady && (
                <StepAction onClick={() => onOpenSettings("agents")}>
                  去设置启用或添加 agent →
                </StepAction>
              )}
            </li>

            {/* 第二步：配置国内地图密钥（海外可跳过） */}
            <li>
              <StepHeader
                index={2}
                done={amapDone}
                icon={KeyRound}
                title="配置国内地图密钥"
                doneNote={amapSkipped && !amapReady ? "已跳过（海外）" : undefined}
              />
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                高德三个 key（JS API Key / Web 服务 Key / 安全密钥）仅国内行程需要；海外行程走开源地图引擎，无需配置。
              </p>
              {!amapDone && (
                <div className="mt-2 flex items-center gap-3">
                  <StepAction onClick={() => onOpenSettings("amap")}>
                    去配置密钥 →
                  </StepAction>
                  <button
                    type="button"
                    onClick={skipAmap}
                    className="text-xs text-slate-400 underline-offset-4 transition-colors hover:text-slate-600 hover:underline"
                  >
                    海外使用，跳过
                  </button>
                </div>
              )}
            </li>
          </ol>
        </div>
        <button
          type="button"
          aria-label="关闭引导"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, "1");
            setDismissed(true);
          }}
          className="shrink-0 rounded-lg p-1.5 text-amber-400 transition-colors hover:bg-amber-100 hover:text-amber-600"
        >
          <X className="size-4" />
        </button>
      </div>
    </section>
  );
}

/** 步骤标题行：序号 / 完成勾 + 图标 + 标题 */
function StepHeader({
  index,
  done,
  icon: Icon,
  title,
  doneNote,
}: {
  index: number;
  done: boolean;
  icon: typeof KeyRound;
  title: string;
  doneNote?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      {done ? (
        <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-amber-400/90 text-[10px] font-bold text-white">
          {index}
        </span>
      )}
      <Icon className="size-3.5 shrink-0 text-slate-400" />
      <span
        className={cn(
          "text-sm font-medium",
          done ? "text-slate-400" : "text-slate-700",
        )}
      >
        {title}
      </span>
      {done && doneNote && <span className="text-xs text-slate-400">{doneNote}</span>}
    </div>
  );
}

/** 步骤行动按钮：点击打开设置抽屉并定位到对应 section */
function StepAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 text-sm font-medium text-blue-600 underline-offset-4 hover:underline"
    >
      {children}
    </button>
  );
}
