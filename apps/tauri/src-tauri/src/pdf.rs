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
//! 工作线程，阻塞等待不碰主线程事件循环，天然无此问题。
//!
//! M107 返工（静默打印失控修复，两层根因）：
//! 1) 失控 PDF：tower 真机验证发现对话框修复后，静默 `runOperation()` 产出 ~77 万空白
//!    Page、566MB+ 还在增长的失控文件，主线程写盘卡死。根因不是 printInfo 配置
//!    （无头探针实测：裸 NSPrintInfo 与显式 A4 配置的纸张/边距/imageablePageBounds
//!    全部正常，但两种配置都失控，页内容流恒为 `q Q` 空操作）——而是 WKWebView 的
//!    打印是异步的：打印帧要在 Web 内容进程里算好再回 UI 进程绘制，`runOperation()`
//!    同步直跑时主 run loop 没有机会驱动这个过程，分页/绘制都拿到未就绪状态。
//!    正确姿势（社区验证的 WKWebView 静默打印路径）：
//!    `runOperationModalForWindow:delegate:didRunSelector:contextInfo:`——名字带 modal
//!    但不弹任何面板（showsPrintPanel/showsProgressPanel 均 false），它让 AppKit 在
//!    主 run loop 上驱动打印会话直到完成，再回调 didRunSelector。
//!    配套：export_pdf 改为 async 命令（跑 tokio 工作线程）——同步命令在主线程上
//!    等完成回调就是 M107 同款自锁；工作线程 rx.recv 等待，主线程事件循环驱动打印。
//! 2) 兜底：预检可打印页高拒绝异常配置开印；后检产物 0 字节或 >200MB 删除并报错；
//!    AtomicBool 防重入（JS 按钮 disabled 之外的第二道）。
//! 无头验证：examples/pdf_probe.rs（离屏 WKWebView 走生产同一条打印路径）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use tauri::{AppHandle, Manager};

/// 同一份打印任务全局只许一个在飞：打印会话在主线程跑期间若再进来一个 export_pdf，
/// 两个 printOperation 叠跑结果不可预期（M107 返工 UX 排查的防重入兜底；
/// JS 侧按钮 disabled 是第一道，这里是第二道）
static PRINT_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// 任何提前返回路径都复位在飞标志
struct PrintInFlightReset;
impl Drop for PrintInFlightReset {
    fn drop(&mut self) {
        PRINT_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

/// 产物后检阈值：正常导出的 PDF 为百 KB 级，200MB 只可能是分页失控
const MAX_SANE_PDF_BYTES: u64 = 200 * 1024 * 1024;

/// 打印完成等待上限：正常导出秒级完成，超时按失败处理（完成回调晚到时 send 进已
/// 释放的 channel 只是静默失败，不会 panic）
const PRINT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// 前端（apps/web features/export/tauriPdf.ts）在存储对话框选定路径后调用。
/// 返回 Ok(实际保存路径) / Err(错误信息)；对话框取消在 JS 侧已短路，不会调到这里。
/// 必须是 async 命令：同步命令在 macOS 直接跑在主线程，而等待打印完成回调需要
/// 主线程事件循环保持运转（同步等 = M107 同款自锁）；async 命令在 tokio 工作线程
/// 阻塞等待，主线程事件循环自由驱动 WebKit 的异步打印会话。
#[tauri::command]
pub async fn export_pdf(app: AppHandle, save_path: String) -> Result<String, String> {
    if PRINT_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有导出任务进行中，请等待完成后再试".to_string());
    }
    let _in_flight = PrintInFlightReset;

    let mut path = PathBuf::from(&save_path);
    // 用户在对话框里删掉扩展名时补回，保证产物是 .pdf
    if path
        .extension()
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("pdf"))
    {
        path.set_extension("pdf");
    }
    print_main_webview_to_pdf(&app, &path)?;

    // 失控兜底（后检）：产物 0 字节或超阈值时删除并报错，失控文件绝不留盘
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(&path);
        return Err("打印未产出有效文件".to_string());
    }
    if size > MAX_SANE_PDF_BYTES {
        let _ = std::fs::remove_file(&path);
        return Err(format!(
            "打印产物异常（{}MB，疑似分页失控），已删除并中止",
            size / 1024 / 1024
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// 拿主窗口的 WKWebView 句柄，在主线程启动静默打印会话并等工作线程侧收到完成回调。
/// 本函数在工作线程执行：with_webview 把闭包派发到主线程（启动打印后立即返回），
/// 本线程 rx.recv_timeout 等 didRunSelector 回调——主线程事件循环全程自由，无自锁。
#[cfg(target_os = "macos")]
fn print_main_webview_to_pdf(app: &AppHandle, path: &PathBuf) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    // NSWindow 指针仅转交主线程闭包使用（usize 绕过 *mut c_void 非 Send）
    let ns_window = window
        .ns_window()
        .map_err(|e| format!("获取主窗口句柄失败: {e}"))? as usize;
    let (tx, rx) = mpsc::channel::<Result<bool, String>>();
    let path = path.clone();
    window
        .with_webview(move |webview| {
            // Safety: wk_ptr 来自 tauri PlatformWebview::inner()（文档保证为 WKWebView 句柄），
            // ns_window 来自 tauri Window::ns_window()；本闭包仅在主线程执行，句柄均存活。
            let (wk, win) = unsafe {
                (
                    &*(webview.inner() as *const objc2_web_kit::WKWebView),
                    &*(ns_window as *const objc2_app_kit::NSWindow),
                )
            };
            // 启动成功时 tx 已移交完成回调（delegate contextInfo），失败时就地 send
            if let Err(e) = start_silent_print(wk, win, &path, tx.clone()) {
                let _ = tx.send(Err(e));
            }
        })
        .map_err(|e| format!("获取 webview 失败: {e}"))?;
    match rx.recv_timeout(PRINT_TIMEOUT) {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err("打印管线写入 PDF 失败".to_string()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("打印超时（120s 未完成）".to_string()),
    }
}

/// 静默打印用的完整配置 NSPrintInfo：A4 纵向 + 与导出 @page 一致的边距 + 自动分页。
/// setUpPrintOperationDefaultValues 先归一化默认值（缩放因子等），显式设置在其后覆写。
/// 注意：printInfo 配置正确并不能保证静默打印正确（WKWebView 异步打印帧才是 M107
/// 失控的根因），但显式纸张/边距仍是要的——不依赖系统默认打印机环境。
/// 抽出为 pub 供 examples/pdf_probe.rs 无头验证与生产共用同一份配置，防漂移。
#[cfg(target_os = "macos")]
pub fn silent_print_info() -> objc2::rc::Retained<objc2_app_kit::NSPrintInfo> {
    use objc2_app_kit::{NSPrintInfo, NSPrintingPaginationMode};
    use objc2_foundation::NSSize;

    let info = NSPrintInfo::new();
    info.setUpPrintOperationDefaultValues();
    // A4 纵向：210×297mm = 595.28×841.89pt
    info.setPaperSize(NSSize::new(595.28, 841.89));
    // 边距与导出打印 CSS 的 @page { margin: 14mm 12mm } 一致（mm→pt ×72/25.4）
    info.setTopMargin(39.69);
    info.setBottomMargin(39.69);
    info.setLeftMargin(34.02);
    info.setRightMargin(34.02);
    info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    info
}

/// 打印完成回调的 delegate：仅一个 printOperationDidRun:success:contextInfo: 方法，
/// contextInfo 里装着 Box<mpsc::Sender>，回调时取回 send 结果（Box 由 from_raw 回收，
/// 不会泄漏；接收端已 drop 时 send 静默失败）。
/// 抽出为 pub 供 examples/pdf_probe.rs 走生产同一条打印路径。
#[cfg(target_os = "macos")]
pub mod print_delegate {
    use std::ffi::c_void;
    use std::sync::mpsc::Sender;

    use objc2::define_class;
    use objc2::runtime::{Bool, NSObject};
    use objc2::MainThreadOnly;
    use objc2_app_kit::NSPrintOperation;

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "YarnballPrintDelegate"]
        #[ivars = ()]
        pub struct PrintDelegate;

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn print_operation_did_run(
                &self,
                _op: &NSPrintOperation,
                success: Bool,
                context_info: *mut c_void,
            ) {
                // Safety: context_info 是 start_silent_print 里 Box::into_raw 的 Sender，
                // 每次打印只回调一次，from_raw 恰好取回一次。
                let tx = unsafe { Box::from_raw(context_info as *mut Sender<Result<bool, String>>) };
                let _ = tx.send(Ok(success.as_bool()));
            }
        }
    );

    impl PrintDelegate {
        fn new(mtm: objc2::MainThreadMarker) -> objc2::rc::Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            // Safety: NSObject 的 init 签名正确
            unsafe { objc2::msg_send![super(this), init] }
        }

        pub fn send_on_completion(
            mtm: objc2::MainThreadMarker,
            tx: Sender<Result<bool, String>>,
        ) -> (objc2::rc::Retained<Self>, *mut c_void) {
            (Self::new(mtm), Box::into_raw(Box::new(tx)) as *mut c_void)
        }
    }
}

/// 在主线程启动静默打印会话：jobDisposition=save + jobSavingURL=目标路径，不弹任何
/// 面板，runOperationModalForWindow 让 AppKit 驱动 WebKit 的异步打印直到完成，
/// 完成结果经 tx 回调。返回 Err 表示启动失败（预检不过等），此时 tx 未被消费。
/// 抽出为 pub 供 examples/pdf_probe.rs 无头验证走生产同一条打印路径。
#[cfg(target_os = "macos")]
pub fn start_silent_print(
    wk: &objc2_web_kit::WKWebView,
    window: &objc2_app_kit::NSWindow,
    path: &PathBuf,
    tx: mpsc::Sender<Result<bool, String>>,
) -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSPrintJobSavingURL, NSPrintSaveJob};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSURL, NSString};

    let Some(path_str) = path.to_str() else {
        return Err("保存路径含非 UTF-8 字符".to_string());
    };
    let info = silent_print_info();
    // 失控兜底（预检）：可打印页高必须落在合理区间，否则就是异常配置，直接拒绝开印
    // （正常 A4 为 841.89 - 2×39.69 ≈ 762pt）
    let printable_height = info.paperSize().height - info.topMargin() - info.bottomMargin();
    if !(200.0..=2000.0).contains(&printable_height) {
        return Err(format!(
            "打印页面配置异常（可打印页高 {printable_height:.0}pt），已中止"
        ));
    }
    let mtm = MainThreadMarker::new().ok_or("静默打印必须在主线程启动")?;
    let (delegate, context_info) = print_delegate::PrintDelegate::send_on_completion(mtm, tx);
    // Safety: wk/window 句柄调用方保证存活且本函数在主线程调用；
    // delegate 经 contextInfo 在回调前由 AppKit 持有操作会话，生命周期覆盖到回调。
    unsafe {
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
        info.dictionary().insert(NSPrintJobSavingURL, &url);
        let op = wk.printOperationWithPrintInfo(&info);
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);
        // WKWebView 静默打印的已知要求：打印视图 frame 显式设为纸张大小，
        // 否则操作可能崩溃（社区验证路径，见模块头注）
        if let Some(view) = op.view() {
            view.setFrame(NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(info.paperSize().width, info.paperSize().height),
            ));
        }
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            window,
            Some(&*(objc2::rc::Retained::as_ptr(&delegate) as *const AnyObject)),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            context_info,
        );
        // delegate 必须活到 didRunSelector 回调：打印会话持有 op 但不持有 delegate，
        // 用 takeRetain 把所有权交给运行环境——故意泄漏一份 retain（每次打印 40 字节级，
        // 换来生命周期绝对安全；回调里无法可靠 balanced release，这个量级可接受）
        std::mem::forget(delegate);
    }
    Ok(())
}
