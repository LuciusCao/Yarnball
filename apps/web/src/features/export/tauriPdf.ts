import { invoke } from "@tauri-apps/api/core";

/**
 * Tauri 壳内打印/导出（M104）：JS 的 window.print 在 WKWebView 里是 no-op（WebKit 不实现），
 * 壳内改调 Rust 侧 export_pdf 命令——由 wry 的 WebView::print() 走 WKWebView
 * printOperationWithPrintInfo: 弹出 macOS 原生打印面板，面板左下 PDF 下拉即可「存为 PDF」。
 * 渲染管线与浏览器 window.print 完全一致（@media print CSS、分页、中文字体、矢量文字全保真），
 * 导出内容就是当前打开的 ExportPrintSheet 浮层。
 * 浏览器 / vite dev 环境不含 __TAURI_INTERNALS__，isTauriShell 为 false，保持 window.print 不变。
 */

/** 是否在 Tauri 壳内运行（devUrl / sidecar 托管两种形态壳都会注入 __TAURI_INTERNALS__） */
export function isTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 调壳内 export_pdf 弹原生打印面板；失败时 invoke reject（面板本身的成功/取消由用户在系统面板内决定） */
export async function printInTauriShell(): Promise<void> {
  return invoke<void>("export_pdf");
}
