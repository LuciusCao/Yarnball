import { invoke } from "@tauri-apps/api/core";

/**
 * Tauri 壳内「保存为 PDF」（M104，用户口径：无打印面板、无打印语义，直接存文件）：
 * JS 的 window.print 在 WKWebView 里是 no-op（WebKit 不实现），壳内改调 Rust 侧
 * export_pdf 命令（src-tauri/src/pdf.rs）——系统存储对话框选路径后，走 WKWebView
 * printOperation 静默直写 PDF（showsPrintPanel=false + jobSavingURL），渲染管线与
 * 浏览器 window.print 一致，导出内容就是当前打开的 ExportPrintSheet 浮层。
 * 浏览器 / vite dev 环境不含 __TAURI_INTERNALS__，isTauriShell 为 false，回退 window.print。
 */

/** 是否在 Tauri 壳内运行（devUrl / sidecar 托管两种形态壳都会注入 __TAURI_INTERNALS__） */
export function isTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 非法文件名字符替换为 -，空标题兜底 */
export function suggestedPdfName(tripTitle: string): string {
  const cleaned = tripTitle.replace(/[\\/:*?"<>|]/g, "-").trim();
  return `${cleaned || "行程导出"}.pdf`;
}

/**
 * 调壳内 export_pdf：系统存储对话框选路径 → 打印管线静默写盘。
 * 返回实际保存路径；用户取消对话框返回 null；失败时 invoke reject。
 */
export async function saveTripPdfInTauri(tripTitle: string): Promise<string | null> {
  return invoke<string | null>("export_pdf", { fileName: suggestedPdfName(tripTitle) });
}
