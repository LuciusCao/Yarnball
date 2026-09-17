import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { useOwnerAuth } from "../lib/principal";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

/**
 * 远程主人登录页（issue #32，路由 /login）。
 *
 * 主人在自己其他设备（iPad / 局域网另一台电脑 / 经隧道的远程浏览器）上粘贴 owner token，
 * 获得完整主人 UI（agent 面板 / 设置 / 分享管理 / 行程删除）。本机 loopback 无需登录。
 *
 * 流程：粘贴 token → POST /api/owner-token/verify（token 作 Bearer，principalMiddleware
 * 完成校验：无效/已重置 → 401，匿名未配置 → 403 引导）→ useOwnerAuth.signIn 持久化 →
 * 进行程列表。凭证失效（主人在本机重置 token）由 apiFetch 的 401 踢出兜底。
 */

export function LoginPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** token 输入的 IME 组合标志位（JoinPage 同款修复，防中文输入法 Enter 误提交） */
  const imeComposingRef = useRef(false);
  const imeResetTimerRef = useRef<number | null>(null);
  const signIn = useOwnerAuth((s) => s.signIn);

  async function submit() {
    const candidate = token.trim();
    if (!candidate || busy) return;
    setBusy(true);
    setError(null);
    try {
      // 候选 token 直接作 Bearer 发 verify（原生 fetch，不走 apiFetch——凭证尚未存入，
      // 且避免 apiFetch 的 401 踢出广播误伤）：校验由服务端 principalMiddleware 完成
      //（无效/已重置 → 401；远程匿名且未配置 owner token → 403 引导文案）
      const res = await fetch("/api/owner-token/verify", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${candidate}` },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        signIn(candidate);
        navigate("/", { replace: true });
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "远程访问凭证无效，请核对后重试");
    } catch (err) {
      setError((err as Error).message || "网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-b from-sky-50 to-slate-100">
      <div className="mx-4 flex w-full max-w-sm flex-col gap-4 rounded-3xl border border-slate-200/80 bg-white/85 px-8 py-9 shadow-xl backdrop-blur">
        <div className="flex size-12 items-center justify-center self-center rounded-2xl bg-blue-600/10">
          <KeyRound className="size-6 text-blue-600" />
        </div>
        <div className="text-center">
          <h1 className="text-lg font-semibold text-slate-900">主人登录</h1>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            在其他设备上以主人身份使用毛线团：粘贴「设置 → 远程访问凭证」生成的 token，
            即可获得完整功能（agent 对话 / 设置 / 分享管理）。
          </p>
        </div>
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="text-xs font-medium text-slate-600" htmlFor="owner-token-input">
            远程访问凭证（owner token）
          </label>
          <Input
            id="owner-token-input"
            autoFocus
            value={token}
            placeholder="粘贴设置页生成的 token"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => {
              setToken(e.target.value);
              setError(null);
            }}
            onCompositionStart={() => {
              if (imeResetTimerRef.current !== null) {
                clearTimeout(imeResetTimerRef.current);
                imeResetTimerRef.current = null;
              }
              imeComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              // WebKit 下 Enter 确认候选词时 keydown 的 isComposing 已为 false，
              // 延迟一个宏任务复位标志位拦截那次 Enter（JoinPage 同款修复）
              imeResetTimerRef.current = window.setTimeout(() => {
                imeComposingRef.current = false;
                imeResetTimerRef.current = null;
              }, 0);
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229 &&
                !imeComposingRef.current
              ) {
                void submit();
              }
            }}
          />
          {error && (
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-red-500">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || token.trim().length === 0}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            登录
          </Button>
        </form>
        <p className="text-center text-[11px] leading-relaxed text-slate-400">
          本机使用无需登录。token 仅生成时展示一次，重置后此处的旧凭证自动失效。
        </p>
      </div>
    </div>
  );
}
