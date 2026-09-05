import { useEffect, useState } from "react";
import { CheckCircle2, Circle, KeyRound, TerminalSquare, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";

const DISMISS_KEY = "yarnball:onboarding-dismissed";

interface SetupStatus {
  amapReady: boolean;
  agentReady: boolean;
}

/**
 * 首次使用引导条：高德密钥未配置或没有可达 agent CLI 时显示 checklist。
 * 可关闭，关闭状态存 localStorage；key 变化（如关闭设置抽屉）时重新检测。
 */
export function OnboardingBanner({
  onOpenSettings,
  refreshKey,
}: {
  onOpenSettings: () => void;
  refreshKey?: number;
}) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1",
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
        setStatus({
          // 服务端已合并 DB 覆盖 + env 后判定三 key 是否齐备
          amapReady: settings.amapConfigured,
          agentReady: agents.some((a) => a.enabled && a.available),
        });
      } catch {
        // 后端还没有设置端点（旧版本）时静默，不打扰
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (dismissed || !status || (status.amapReady && status.agentReady)) return null;

  const items = [
    {
      icon: KeyRound,
      done: status.amapReady,
      text: "配置高德地图密钥（国内行程需要，海外可跳过）",
    },
    {
      icon: TerminalSquare,
      done: status.agentReady,
      text: "添加一个可用的 agent CLI（如 kimi acp）",
    },
  ];

  return (
    <section className="mb-8 rounded-2xl border border-amber-200/80 bg-amber-50/80 p-4 shadow-sm backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-amber-900">开始使用前，还差几步：</p>
          <ul className="mt-2.5 space-y-2">
            {items.map(({ icon: Icon, done, text }) => (
              <li key={text} className="flex items-center gap-2.5">
                {done ? (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                ) : (
                  <Circle className="size-4 shrink-0 text-amber-400" />
                )}
                <Icon className="size-3.5 shrink-0 text-slate-400" />
                <span
                  className={cn(
                    "text-sm",
                    done ? "text-slate-400 line-through" : "text-slate-700",
                  )}
                >
                  {text}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-3 text-sm font-medium text-blue-600 underline-offset-4 hover:underline"
          >
            打开设置完成配置 →
          </button>
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
