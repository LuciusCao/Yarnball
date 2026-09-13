import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Printer, X } from "lucide-react";
import type { TripBundle } from "@yarnball/shared";
import { ExportPrintSheet } from "./ExportPrintSheet";
import { EXPORT_BODY_CLASS, EXPORT_OVERLAY_CLASS, EXPORT_PRINT_CSS } from "./printCss";
import { useTripWeather } from "../itinerary/weather";

/**
 * 导出弹层（M97，issue #7）：全屏打印预览 + 「打印 / 存为 PDF」按钮（window.print，
 * 浏览器打印对话框里选「另存为 PDF」即导出文件，零新增依赖）。
 * 经 createPortal 挂到 body 下：打印时 CSS 按 body 直接子节点隐藏应用本体（#root），
 * 只留本浮层参与打印分页。
 * M102：打开时复用行程页的天气查询缓存（react-query 同 queryKey，已在行程面板拉过则零额外请求），
 * 天气随打印稿每日开头段落一并输出。
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
  // 打开期间给 body 打标：打印 CSS 据此隐藏应用其余部分；Esc 关闭
  useEffect(() => {
    if (!open) return;
    document.body.classList.add(EXPORT_BODY_CLASS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove(EXPORT_BODY_CLASS);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // 天气（M102，#5）：仅弹层打开时启用；行程面板已拉过则直接命中缓存
  const weatherQuery = useTripWeather(bundle.trip.id, open);

  if (!open) return null;

  return createPortal(
    <div className={EXPORT_OVERLAY_CLASS}>
      <style>{EXPORT_PRINT_CSS}</style>
      {/* 工具条：仅屏幕态显示（打印态被 CSS 隐藏） */}
      <div className="ybe-toolbar sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-5 py-2.5 backdrop-blur">
        <span className="text-sm font-semibold text-slate-800">导出行程 · 打印预览</span>
        <span className="text-xs text-slate-400">
          在打印对话框中选择「另存为 PDF」即可导出文件
        </span>
        <button
          onClick={() => window.print()}
          className="ml-auto flex items-center gap-1.5 rounded-full bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
        >
          <Printer className="size-3.5" />
          打印 / 存为 PDF
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
