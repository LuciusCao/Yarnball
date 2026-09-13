import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileDown, X } from "lucide-react";
import { toast } from "sonner";
import type { TripBundle } from "@yarnball/shared";
import { ExportPrintSheet } from "./ExportPrintSheet";
import { EXPORT_BODY_CLASS, EXPORT_OVERLAY_CLASS, EXPORT_PRINT_CSS } from "./printCss";
import { isTauriShell, saveTripPdfInTauri } from "./tauriPdf";
import { useTripWeather } from "../itinerary/weather";

/**
 * 导出弹层（M97，issue #7）：全屏打印预览 + 「保存为 PDF」按钮。
 * 经 createPortal 挂到 body 下：打印时 CSS 按 body 直接子节点隐藏应用本体（#root），
 * 只留本浮层参与打印分页。
 * M102：打开时复用行程页的天气查询缓存（react-query 同 queryKey，已在行程面板拉过则零额外请求），
 * 天气随打印稿每日开头段落一并输出。
 * M104（用户口径：app 里只做保存为 PDF，无打印面板/打印语义）：
 * Tauri 壳（WKWebView）里 JS 的 window.print 是 no-op，壳内先在 JS 侧弹系统存储对话框
 * （M107：对话框挪到 JS 侧修主线程死锁）拿路径，再调 export_pdf 命令静默直写 PDF
 * （见 tauriPdf.ts / src-tauri/src/pdf.rs）；浏览器环境回退 window.print
 * （打印对话框里选「另存为 PDF」）。
 */
export function ExportPrintDialog({
  bundle,
  open,
  onClose,
}: {
  bundle: TripBundle;
  open: boolean;
  onClose: () => void;
}) {
  // 打开期间给 body 打标：打印 CSS 据此隐藏应用其余部分；Esc 关闭。
  // 同时把 document.title 换成行程标题：浏览器回退路径的打印任务名/默认文件名取它
  // （壳内直存路径的文件名由存储对话框默认名给出），关闭时还原。
  useEffect(() => {
    if (!open) return;
    const prevTitle = document.title;
    document.title = bundle.trip.title;
    document.body.classList.add(EXPORT_BODY_CLASS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.title = prevTitle;
      document.body.classList.remove(EXPORT_BODY_CLASS);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, bundle.trip.title]);

  // 天气（M102，#5）：仅弹层打开时启用；行程面板已拉过则直接命中缓存
  const weatherQuery = useTripWeather(bundle.trip.id, open);

  // M104：壳内走「存储对话框 → 静默直写 PDF」；浏览器回退 window.print。
  // 两条路径共用同一套 @media print CSS 与 ExportPrintSheet，导出内容一致。
  const inTauri = isTauriShell();
  const [saving, setSaving] = useState(false);
  const onExport = async () => {
    if (!inTauri) {
      window.print();
      return;
    }
    setSaving(true);
    try {
      const savedPath = await saveTripPdfInTauri(bundle.trip.title);
      if (savedPath) toast.success("PDF 已保存", { description: savedPath });
    } catch (err) {
      toast.error(`保存 PDF 失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className={EXPORT_OVERLAY_CLASS}>
      <style>{EXPORT_PRINT_CSS}</style>
      {/* 工具条：仅屏幕态显示（打印态被 CSS 隐藏） */}
      <div className="ybe-toolbar sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-5 py-2.5 backdrop-blur">
        <span className="text-sm font-semibold text-slate-800">导出行程 · 预览</span>
        {!inTauri && (
          <span className="text-xs text-slate-400">
            浏览器将打开打印对话框，选择「另存为 PDF」即可导出文件
          </span>
        )}
        <button
          onClick={() => void onExport()}
          disabled={saving}
          className="ml-auto flex items-center gap-1.5 rounded-full bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          <FileDown className="size-3.5" />
          {saving ? "正在保存…" : "保存为 PDF"}
        </button>
        <button
          onClick={onClose}
          title="关闭预览"
          className="flex size-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-900/8 hover:text-slate-700"
        >
          <X className="size-4" />
        </button>
      </div>
      <ExportPrintSheet bundle={bundle} weather={weatherQuery.data ?? null} />
    </div>,
    document.body,
  );
}
