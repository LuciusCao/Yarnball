//! M104 壳内「保存为 PDF」（用户最终口径：无打印面板、无打印语义）：
//! 前端导出弹层在 Tauri 环境下先在 JS 侧弹系统存储对话框（tauri-plugin-dialog 的
//! save 命令，原生异步对话框）拿保存路径，再调本模块的 export_pdf 只传路径；
//! Rust 侧用 WKWebView printOperation（showsPrintPanel=false + NSPrintJobSavingURL）
//! 静默直写 PDF，走与浏览器 window.print 完全相同的 WebKit 打印管线：@media print 样式
//! （只留导出浮层、@page 边距、分页保护）、中文字体、矢量文字原样生效。
//!
//! 为什么不用 WKWebView createPDF（规格首选，评估后弃用走备选）：它捕获屏幕布局——
//! 导出浮层是 fixed+内部滚动，只能截到视口一屏且不应用 print CSS，产物与打印稿不符；
//! printOperation 静默模式复用已人工验证过的打印管线，产物正确性可预期。
//!
//! M107 死锁修复（存储对话框从 Rust 挪到 JS 侧的原因）：macOS 上 Tauri 同步命令直接
//! 跑在主线程（wry send_user_message 对主线程有 inline 快路径）。M104 在命令体内调
//! blocking_save_file：NSSavePanel 经 inline 快路径挂出 sheet（面板能出现），但随后
//! 本线程 rx.recv() 等对话框结果，而 sheet 的完成回调要靠主线程事件循环驱动——
//! 主线程自锁，面板出现后全 app 冻结。插件的 JS 入口 save 是 async 命令，跑在 tokio
//! 工作线程，阻塞等待不碰主线程事件循环，天然无此问题；对话框与打印彻底解耦后，
//! 本命令所有路径（打印失败、with_webview 异常）都不再可能锁住主线程。

use std::path::PathBuf;
use std::sync::mpsc;

use tauri::{AppHandle, Manager};

/// 前端（apps/web features/export/tauriPdf.ts）在存储对话框选定路径后调用。
/// 返回 Ok(实际保存路径) / Err(错误信息)；对话框取消在 JS 侧已短路，不会调到这里。
/// 同步命令在 macOS 跑在主线程：with_webview 经 inline 快路径直接在主线程执行打印
/// 闭包（NSPrintOperation 本就要求主线程），channel 只是取回结果的容器，不构成跨线程等待。
#[tauri::command]
pub fn export_pdf(app: AppHandle, save_path: String) -> Result<String, String> {
    let mut path = PathBuf::from(&save_path);
    // 用户在对话框里删掉扩展名时补回，保证产物是 .pdf
    if path
        .extension()
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("pdf"))
    {
        path.set_extension("pdf");
    }
    print_main_webview_to_pdf(&app, &path)?;
    Ok(path.to_string_lossy().into_owned())
}

/// 拿主窗口的 WKWebView 句柄，主线程执行静默打印（NSPrintOperation 必须跑在主线程；
/// with_webview 的闭包由 tauri 调度到主线程执行，本线程用 channel 等结果——
/// 主线程调用时走 inline 快路径直接执行，非主线程调用时主线程事件循环空闲可正常派发，
/// 两种情形下 recv 都会返回）
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
