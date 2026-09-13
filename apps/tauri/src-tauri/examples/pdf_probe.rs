//! 无头 PDF 打印探针（M107 返工验证）：离屏 WKWebView 加载长中文 HTML，
//! 用与生产（src/pdf.rs）相同的静默 printOperation 管线写 PDF，验证产物页数/大小合理。
//!
//! 用法（在 apps/tauri/src-tauri 下）：
//!   cargo run --example pdf_probe -- bare  [输出路径]   # 复现旧配置：裸 NSPrintInfo
//!   cargo run --example pdf_probe -- fixed [输出路径]   # 生产配置：A4+边距+自动分页
//!
//! 退出码：0 = 符合预期（fixed 通过断言 / bare 正常完成并打印统计）；
//!         1 = fixed 断言失败；2 = 加载超时；3 = 失控复现（看门狗：产物 >100MB 立即杀进程，
//!         这是 bare 模式的预期结果——对应真机 77 万空白页/566MB 的失控写入）。
//!
//! 注意：需要在有 window server 的 macOS 桌面 session 里跑（WKWebView 是 UI 进程组件）。

use std::path::PathBuf;
use std::time::{Duration, Instant};

use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSPrintInfo,
    NSPrintJobSavingURL, NSPrintSaveJob, NSWindow, NSWindowStyleMask,
};
use objc2_foundation::{
    NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSRunLoop, NSSize, NSString, NSURL,
};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

/// 失控看门狗阈值：正常产物百 KB 级，超 100MB 即判失控
const RUNAWAY_BYTES: u64 = 100 * 1024 * 1024;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "fixed".to_string());
    let out = std::env::args()
        .nth(2)
        .unwrap_or_else(|| format!("/tmp/yarnball_pdf_probe_{mode}.pdf"));
    let out_path = PathBuf::from(&out);
    let _ = std::fs::remove_file(&out_path);

    if mode == "debug" {
        debug_print_infos();
        return;
    }

    let mtm = MainThreadMarker::new().expect("探针必须跑在主线程");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

    // 离屏窗口 + WKWebView：打印分页与窗口位置无关，视图挂进窗口层级求稳妥
    let frame = NSRect::new(NSPoint::new(-20000.0, -20000.0), NSSize::new(820.0, 1000.0));
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            mtm.alloc(),
            frame,
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    let wk = unsafe { WKWebView::initWithFrame_configuration(mtm.alloc(), frame, &config) };
    window.setContentView(Some(&wk));

    // 长中文 HTML：400 段，A4 合理分页预期 ~10-15 页
    let html = build_html(400);
    unsafe { wk.loadHTMLString_baseURL(&NSString::from_str(&html), None) };

    // 等加载完成（最多 15s），期间手动驱动主 run loop
    let deadline = Instant::now() + Duration::from_secs(15);
    while unsafe { wk.isLoading() } {
        if Instant::now() > deadline {
            eprintln!("[probe] 加载超时");
            std::process::exit(2);
        }
        spin_run_loop(0.05);
    }
    // 渲染/字体沉降
    spin_run_loop(1.0);

    // 失控看门狗：产物一旦超阈值立即杀进程，绝不再写真机那样的 566MB
    let watchdog_path = out_path.clone();
    std::thread::spawn(move || loop {
        if let Ok(meta) = std::fs::metadata(&watchdog_path) {
            if meta.len() > RUNAWAY_BYTES {
                eprintln!(
                    "[probe] RUNAWAY 复现：产物已 {}MB 仍在增长（看门狗中止）",
                    meta.len() / 1024 / 1024
                );
                std::process::exit(3);
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    });

    println!("[probe] 模式={mode} 输出={out}");
    let started = Instant::now();
    let print_ok = if mode == "bare" {
        // M107 修复前的旧路径：同步 runOperation 直跑，预期失控
        // （WKWebView 异步打印帧未就绪 → 空白页无限分页）
        bare_silent_print(&wk, &out_path)
    } else {
        // 生产同一条打印路径：同一份 printInfo 配置 + 预检 +
        // runOperationModalForWindow 异步打印会话，主线程泵 run loop 等完成回调
        let (tx, rx) = std::sync::mpsc::channel::<Result<bool, String>>();
        if let Err(e) = yarnball_lib::pdf::start_silent_print(&wk, &window, &out_path, tx) {
            eprintln!("[probe] 打印启动失败: {e}");
            false
        } else {
            let deadline = Instant::now() + Duration::from_secs(120);
            loop {
                match rx.try_recv() {
                    Ok(Ok(ok)) => break ok,
                    Ok(Err(e)) => {
                        eprintln!("[probe] 打印失败: {e}");
                        break false;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        if Instant::now() > deadline {
                            eprintln!("[probe] 打印超时（120s 未完成）");
                            break false;
                        }
                        spin_run_loop(0.05);
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => break false,
                }
            }
        }
    };
    let elapsed = started.elapsed();

    let size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    let pages = count_pdf_pages(&out_path);
    println!(
        "[probe] runOperation={print_ok} 耗时={:.1}s 大小={:.1}KB 页数={pages}",
        elapsed.as_secs_f64(),
        size as f64 / 1024.0
    );

    if mode == "bare" {
        // bare 能正常走完说明裸配置在该环境未失控，打印统计供人工判断
        println!("[probe] bare 模式完成（未触发看门狗）");
        return;
    }
    // fixed 断言：打印成功、大小在合理区间、页数在合理区间
    if !print_ok || size < 5 * 1024 || size > 50 * 1024 * 1024 || !(2..=100).contains(&pages) {
        eprintln!("[probe] FAIL：产物不在合理区间");
        std::process::exit(1);
    }
    println!("[probe] PASS：产物页数/大小合理");
}

/// dump 各来源 printInfo 的分页关键值，定位失控根因
fn debug_print_infos() {
    let dump = |label: &str, info: &NSPrintInfo| {
        let ps = info.paperSize();
        let bounds = info.imageablePageBounds();
        let printer_name = info.printer().name().to_string();
        println!(
            "[debug] {label}: paperSize={:.1}x{:.1} margins(t/b/l/r)={:.1}/{:.1}/{:.1}/{:.1} \
             imageable=({:.1},{:.1} {:.1}x{:.1}) printer={printer_name}",
            ps.width, ps.height,
            info.topMargin(), info.bottomMargin(), info.leftMargin(), info.rightMargin(),
            bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height,
        );
    };
    dump("new()", &NSPrintInfo::new());
    dump("silent_print_info()", &yarnball_lib::pdf::silent_print_info());
    let shared = NSPrintInfo::sharedPrintInfo();
    dump("sharedPrintInfo()", &shared);
}

/// 驱动主 run loop secs 秒（让 WebKit 加载/渲染的事件得以处理）
fn spin_run_loop(secs: f64) {
    let end = Instant::now() + Duration::from_secs_f64(secs);
    let run_loop = NSRunLoop::currentRunLoop();
    while Instant::now() < end {
        let until = NSDate::dateWithTimeIntervalSinceNow(0.05);
        // Safety: extern static 只读引用，主线程使用
        run_loop.runMode_beforeDate(unsafe { NSDefaultRunLoopMode }, &until);
    }
}

/// 旧失控配置复现：裸 NSPrintInfo + save 语义，不做任何纸张/分页设置
fn bare_silent_print(wk: &WKWebView, path: &PathBuf) -> bool {
    let info = NSPrintInfo::new();
    // Safety: 同生产打印闭包——主线程调用，wk/printInfo 句柄存活
    unsafe {
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
        info.dictionary().insert(NSPrintJobSavingURL, &url);
        let op = wk.printOperationWithPrintInfo(&info);
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);
        op.runOperation()
    }
}

/// 粗数 PDF 页数：扫描 "/Type /Page"（去掉 "/Type /Pages" 根节点）。
/// CGPDFContext 产物的页对象不压缩，直接字节扫描可靠；扫不到时返回 0 由调用方按大小兜底判断
fn count_pdf_pages(path: &PathBuf) -> usize {
    let Ok(bytes) = std::fs::read(path) else { return 0 };
    let page_markers = count_occurrences(&bytes, b"/Type /Page") + count_occurrences(&bytes, b"/Type/Page");
    let pages_root = count_occurrences(&bytes, b"/Type /Pages") + count_occurrences(&bytes, b"/Type/Pages");
    page_markers.saturating_sub(pages_root)
}

fn count_occurrences(haystack: &[u8], needle: &[u8]) -> usize {
    if needle.is_empty() || haystack.len() < needle.len() {
        return 0;
    }
    (0..=haystack.len() - needle.len())
        .filter(|&i| &haystack[i..i + needle.len()] == needle)
        .count()
}

/// 构造 approx 10-15 页 A4 的长中文文档（模拟导出行程的内容密度）
fn build_html(paragraphs: usize) -> String {
    let mut body = String::new();
    for i in 1..=paragraphs {
        body.push_str(&format!(
            "<h2>第 {i} 天 · 悉尼市区深度游</h2>\
             <p>上午 09:00 从酒店出发，步行 800 米到达环形码头，乘坐渡轮前往曼利海滩。\
             沿途经过悉尼歌剧院与海港大桥，船程约 30 分钟。建议提前在码头购票，\
             高峰时段排队约 15 分钟。午餐推荐海滩边的海鲜餐厅，人均 45 澳元。</p>\
             <p>下午参观岩石区周末市集，随后步行至皇家植物园，傍晚在麦考瑞夫人角看日落。\
             交通方式：渡轮 + 步行，全天步行约 8 公里，请穿舒适的鞋。</p>"
        ));
    }
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">\
         <style>body {{ font-family: \"PingFang SC\", sans-serif; font-size: 12px; line-height: 1.65; }}\
         h2 {{ font-size: 15px; border-bottom: 2px solid #000; padding-bottom: 6px; }}</style>\
         </head><body>{body}</body></html>"
    )
}
