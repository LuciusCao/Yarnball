import { invoke } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";

/**
 * Tauri 壳内「保存为 PDF」（M104，用户口径：无打印面板、无打印语义，直接存文件）：
 * JS 的 window.print 在 WKWebView 里是 no-op（WebKit 不实现），壳内分两步走——
 * 1) JS 侧弹系统存储对话框拿路径（tauri-plugin-dialog 的 save 命令，原生异步对话框）；
 * 2) 把路径传给 Rust 侧 export_pdf 命令（src-tauri/src/pdf.rs），走 WKWebView
 *    printOperation 静默直写 PDF（showsPrintPanel=false + jobSavingURL），渲染管线与
 *    浏览器 window.print 一致，导出内容就是当前打开的 ExportPrintSheet 浮层。
 * 浏览器 / vite dev 环境不含 __TAURI_INTERNALS__，isTauriShell 为 false，回退 window.print。
 *
 * M107 死锁修复：M104 把存储对话框放在 Rust 同步命令里（blocking_save_file），
 * 而 macOS 同步命令直接跑在主线程——sheet 挂出后主线程阻塞等对话框结果，
 * 对话框结果又要主线程事件循环驱动，自锁导致全 app 冻结。插件的 save 是 async 命令
 * （跑在 tokio 工作线程），阻塞等待不碰主线程事件循环，故对话框整体挪到 JS 侧。
 * 未引入 @tauri-apps/plugin-dialog 的 JS 包，按插件命令契约原始 invoke：
 * plugin:dialog|save 入参 { options: { title?, defaultPath?, filters? } }，返回路径 | null（取消）。
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
 * 壳内「保存为 PDF」：系统存储对话框选路径 → 打印管线静默写盘。
 * 返回实际保存路径；用户取消对话框返回 null；失败时 invoke reject。
 */
export async function saveTripPdfInTauri(tripTitle: string): Promise<string | null> {
  const fileName = suggestedPdfName(tripTitle);
  // 存储对话框默认目录 ~/Downloads（取不到时只给文件名，面板回退系统默认位置）
  let defaultPath = fileName;
  try {
    defaultPath = await join(await downloadDir(), fileName);
  } catch {
    // 忽略：回退为仅文件名
  }
  const savePath = await invoke<string | null>("plugin:dialog|save", {
    options: {
      title: "保存为 PDF",
      defaultPath,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    },
  });
  if (!savePath) return null;
  return invoke<string>("export_pdf", { savePath });
}
