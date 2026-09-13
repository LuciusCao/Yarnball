//! M104 壳内「保存为 PDF」（用户最终口径：无打印面板、无打印语义）：
//! 前端导出弹层在 Tauri 环境下调 export_pdf —— 系统存储对话框（tauri-plugin-dialog/rfd，
//! 默认目录 ~/Downloads，默认文件名带行程标题，用户可改）选路径后，用 WKWebView
//! printOperation（showsPrintPanel=false + NSPrintJobSavingURL）静默直写 PDF，
//! 走与浏览器 window.print 完全相同的 WebKit 打印管线：@media print 样式
//! （只留导出浮层、@page 边距、分页保护）、中文字体、矢量文字原样生效。
//!
//! 为什么不用 WKWebView createPDF（规格首选，评估后弃用走备选）：它捕获屏幕布局——
//! 导出浮层是 fixed+内部滚动，只能截到视口一屏且不应用 print CSS，产物与打印稿不符；
//! printOperation 静默模式复用已人工验证过的打印管线，产物正确性可预期。

use std::path::PathBuf;
use std::sync::mpsc;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// 前端（apps/web features/export/tauriPdf.ts）在壳内点「保存为 PDF」时调用。
/// 返回 Ok(Some(实际保存路径)) / Ok(None)（用户取消存储对话框）/ Err(错误信息)。
#[tauri::command]
pub fn export_pdf(app: AppHandle, file_name: String) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_file_name(&file_name);
    // 存储对话框默认目录 ~/Downloads（取不到时不设，面板回退系统默认位置）
    if let Some(downloads) = std::env::home_dir()
        .map(|home| home.join("Downloads"))
        .filter(|dir| dir.is_dir())
    {
        dialog = dialog.set_directory(downloads);
    }
    let Some(file_path) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let mut path = file_path
        .into_path()
        .map_err(|e| format!("解析保存路径失败: {e}"))?;
    // 用户在对话框里删掉扩展名时补回，保证产物是 .pdf
    if path
        .extension()
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("pdf"))
    {
        path.set_extension("pdf");
    }
    print_main_webview_to_pdf(&app, &path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 拿主窗口的 WKWebView 句柄，切主线程执行静默打印（NSPrintOperation 必须跑在主线程；
/// with_webview 的闭包由 tauri 调度到主线程执行，本线程用 channel 等结果）
#[cfg(target_os = "macos")]
fn print_main_webview_to_pdf(app: &AppHandle, path: &PathBuf) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    let (tx, rx) = mpsc::channel();
    let path = path.clone();
    window
        .with_webview(move |webview| {
            let _ = tx.send(silent_print_to_pdf(webview.inner(), &path));
        })
        .map_err(|e| format!("获取 webview 失败: {e}"))?;
    rx.recv().map_err(|_| "打印任务中断".to_string())?
}

/// 打印管线静默直写：jobDisposition=save + jobSavingURL=目标路径，不弹任何面板
#[cfg(target_os = "macos")]
fn silent_print_to_pdf(wk_ptr: *mut std::ffi::c_void, path: &PathBuf) -> Result<(), String> {
    use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob};
    use objc2_foundation::{NSURL, NSString};

    let Some(path_str) = path.to_str() else {
        return Err("保存路径含非 UTF-8 字符".to_string());
    };
    // Safety: wk_ptr 来自 tauri PlatformWebview::inner()（文档保证为 WKWebView 句柄）；
    // 本函数仅在主线程经 with_webview 调用，句柄随 webview 存活。
    unsafe {
        let wk = &*(wk_ptr as *const objc2_web_kit::WKWebView);
        let info = NSPrintInfo::new();
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
        info.dictionary().insert(NSPrintJobSavingURL, &url);
        let op = wk.printOperationWithPrintInfo(&info);
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);
        if op.runOperation() {
            Ok(())
        } else {
            Err("打印管线写入 PDF 失败".to_string())
        }
    }
}
