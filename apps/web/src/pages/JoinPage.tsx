import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CalendarCheck, Compass, Eye, Loader2, Pencil, TriangleAlert } from "lucide-react";
import type { JoinInfo } from "@yarnball/shared";
import { ApiError } from "../lib/http";
import { credentialByToken, usePrincipalStore, type GuestCredential } from "../lib/principal";
import { api as uxApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

/**
 * 同伴入口页（issue #18，路由 /join/:token）。
 *
 * 流程：打开 → GET /api/join/:token/info →
 *   无效（404 / code=join_link_not_found）  → 「链接无效」友好错误页
 *   已吊销（410 / code=join_link_revoked）  → 「链接已被主人撤销」友好错误页
 *   有效 → 填昵称表单（该链接已激活过则预填昵称，可改可重进）→
 *   POST activate → 凭证存 principal store → 按角色重定向：
 *     editor → /trip/:tripId（TripPage guest 模式）
 *     viewer → /share/:token（现有只读页；实时化在 #19）
 */

type JoinState =
  | { phase: "loading" }
  | { phase: "error"; kind: "not_found" | "revoked" | "network"; message: string }
  | { phase: "ready"; info: JoinInfo };

/** 角色徽章文案：editor=可编辑同伴 / viewer=只读同伴 */
const ROLE_META = {
  editor: { label: "可编辑", Icon: Pencil, className: "bg-blue-500/15 text-blue-700" },
  viewer: { label: "只读", Icon: Eye, className: "bg-slate-500/15 text-slate-600" },
} as const;

export function JoinPage() {
  const { token = "" } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<JoinState>({ phase: "loading" });
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  /** 昵称 input 的 IME 组合输入标志位：模式复刻 TripPage 标题编辑（issue #4 同款修复） */
  const imeComposingRef = useRef(false);
  const imeResetTimerRef = useRef<number | null>(null);
  const activate = usePrincipalStore((s) => s.activate);

  useEffect(() => {
    let cancelled = false;
    // join 端点在公开区（token 在 URL 即凭证）：即使 apiFetch 注入了其他链接的 Bearer
    // 也无影响——服务端不解析该请求的 Authorization 头
    void uxApi
      .getJoinInfo(token)
      .then((info) => {
        if (cancelled) return;
        setState({ phase: "ready", info });
        // 该链接激活过：预填已存昵称（本浏览器）或服务端记录（换浏览器重进）
        const saved = credentialByToken(token);
        setDisplayName(saved?.displayName ?? info.displayName ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "join_link_revoked") {
          setState({ phase: "error", kind: "revoked", message: err.message });
        } else if (err instanceof ApiError && (err.status === 404 || err.code === "join_link_not_found")) {
          setState({ phase: "error", kind: "not_found", message: err.message });
        } else {
          setState({
            phase: "error",
            kind: "network",
            message: (err as Error).message || "网络异常，请稍后重试",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit() {
    const name = displayName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const result = await uxApi.activateJoinLink(token, name);
      const credential: GuestCredential = {
        token,
        tripId: result.tripId,
        role: result.role,
        displayName: result.displayName,
      };
      activate(credential);
      // 按角色分流：editor 进 TripPage guest 模式；viewer 保持现有只读分享页（实时化在 #19）
      navigate(result.role === "editor" ? `/trip/${result.tripId}` : `/share/${token}`, {
        replace: true,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "join_link_revoked") {
        // 提交途中被吊销：整页切到「已被撤销」错误态
        setState({ phase: "error", kind: "revoked", message: err.message });
      } else {
        // 普通错误（昵称校验/网络）：表单可见，内联提示不顶掉整页
        setFormError((err as Error).message || "激活失败，请稍后重试");
      }
    } finally {
      setBusy(false);
    }
  }

  /** 表单内联错误（昵称校验 / 网络失败）：不顶掉整页 info 态 */
  const [formError, setFormError] = useState<string | null>(null);

  // ---------- 错误页（三态：无效 / 已撤销 / 网络异常） ----------
  if (state.phase === "error") {
    const meta =
      state.kind === "revoked"
        ? {
            title: "链接已被主人撤销",
            detail: "行程主人已撤销这个协作链接，无法继续访问。请联系主人重新生成链接。",
          }
        : state.kind === "not_found"
          ? {
              title: "链接无效",
              detail: "这个链接不存在或已被删除。请检查链接是否完整，或向行程主人重新获取。",
            }
          : {
              title: "暂时连不上服务",
              detail: `${state.message}。请检查网络后刷新重试。`,
            };
    return (
      <div className="flex h-full items-center justify-center bg-slate-100">
        <div className="mx-4 flex max-w-sm flex-col items-center gap-3 rounded-3xl border border-slate-200/80 bg-white/80 px-8 py-10 text-center shadow-sm backdrop-blur">
          <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/12">
            <TriangleAlert className="size-6 text-amber-500" />
          </div>
          <h1 className="text-base font-semibold text-slate-900">{meta.title}</h1>
          <p className="text-sm leading-relaxed text-slate-500">{meta.detail}</p>
          {state.kind === "network" && (
            <Button variant="outline" onClick={() => window.location.reload()}>
              刷新重试
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ---------- 加载中 ----------
  if (state.phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-slate-100 text-sm text-slate-400">
        <Loader2 className="size-4 animate-spin" />
        正在打开链接…
      </div>
    );
  }

  // ---------- 填昵称表单 ----------
  const { info } = state;
  const roleMeta = ROLE_META[info.role];
  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-b from-sky-50 to-slate-100">
      <div className="mx-4 flex w-full max-w-sm flex-col gap-4 rounded-3xl border border-slate-200/80 bg-white/85 px-8 py-9 shadow-xl backdrop-blur">
        <div className="flex size-12 items-center justify-center self-center rounded-2xl bg-blue-600/10">
          <Compass className="size-6 text-blue-600" />
        </div>
        <div className="text-center">
          <p className="text-xs font-medium text-slate-400">你被邀请协作一段行程</p>
          <h1 className="mt-1 text-lg font-semibold text-slate-900">{info.tripTitle}</h1>
        </div>
        <div className="flex items-center justify-center gap-2">
          <span
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${roleMeta.className}`}
          >
            <roleMeta.Icon className="size-3" />
            {roleMeta.label}同伴
          </span>
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/12 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
            <CalendarCheck className="size-3" />
            实时同步
          </span>
        </div>
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="text-xs font-medium text-slate-600" htmlFor="join-display-name">
            你的昵称（同伴和行程主人可见）
          </label>
          <Input
            id="join-display-name"
            autoFocus
            value={displayName}
            placeholder="如：小明"
            maxLength={30}
            disabled={busy}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setFormError(null);
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
              // 延迟一个宏任务复位标志位拦截那次 Enter（TripPage 标题编辑同款修复）
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
          {formError && <p className="text-xs leading-relaxed text-red-500">{formError}</p>}
          <Button type="submit" disabled={busy || displayName.trim().length === 0}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {info.role === "editor" ? "进入行程（可编辑）" : "查看行程（只读）"}
          </Button>
        </form>
        <p className="text-center text-[11px] leading-relaxed text-slate-400">
          链接即身份，无需注册登录。{info.role === "editor" ? "你和行程主人的修改会实时同步。" : "你只能查看，不能修改。"}
        </p>
      </div>
    </div>
  );
}
