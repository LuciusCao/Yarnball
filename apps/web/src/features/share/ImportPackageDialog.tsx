import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Loader2, PackageSearch, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { api as uxApi } from "../../lib/api";
import { ApiError } from "../../lib/http";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";

/**
 * 导入行程数据包（issue #34，行程列表页入口）。
 *
 * 选 .yarnball 文件（内容读成文本，不解析——解密在服务端）+ 输密码 →
 * POST /trips/import-package → 新行程 bundle → 跳转行程页。
 * 错密码 / 坏文件由服务端 GCM 校验后给出友好文案（TripPackageError → 400）。
 */
export function ImportPackageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 密码输入 IME 组合标志位（JoinPage/LoginPage 同款修复，防中文输入法 Enter 误提交） */
  const imeComposingRef = useRef(false);
  const imeResetTimerRef = useRef<number | null>(null);

  function reset() {
    setFile(null);
    setPassword("");
    setError(null);
  }

  async function submit() {
    if (!file || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const packageText = await file.text();
      const { bundle } = await uxApi.importTripPackage(packageText, password);
      toast.success(`已导入「${bundle.trip.title}」`);
      onOpenChange(false);
      reset();
      navigate(`/trip/${bundle.trip.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message || "导入失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          onOpenChange(next);
          if (!next) reset();
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <div className="mb-3 flex items-center gap-2">
          <PackageSearch className="size-4 text-slate-500" />
          <DialogTitle className="text-base font-semibold text-slate-900">导入行程数据包</DialogTitle>
        </div>
        <DialogDescription className="sr-only">选择毛线团数据包文件并输入密码，导入为一份新行程</DialogDescription>
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="text-xs font-medium text-slate-600">数据包文件（.yarnball）</label>
          <Input
            type="file"
            accept=".yarnball,application/json"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
            className="text-xs"
          />
          <label className="text-xs font-medium text-slate-600" htmlFor="import-package-password">
            包密码
          </label>
          <Input
            id="import-package-password"
            type="password"
            value={password}
            placeholder="对方分享时设置的密码"
            disabled={busy || !file}
            onChange={(e) => {
              setPassword(e.target.value);
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
              // 延迟一个宏任务复位标志位拦截那次 Enter（LoginPage 同款修复）
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
          <Button type="submit" disabled={busy || !file || !password}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                解密导入中…
              </>
            ) : (
              <>
                <KeyRound className="size-4" />
                导入为新行程
              </>
            )}
          </Button>
        </form>
        <p className="text-center text-[11px] leading-relaxed text-slate-400">
          导入会创建一份完整副本（地图、日程、酒店、须知都保留），与原行程互不影响。
        </p>
      </DialogContent>
    </Dialog>
  );
}
