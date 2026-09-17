//! 主窗口生命周期单点（issue #22）：创建、navigate、聚焦、dock 重开。
//! 抽出来是因为这些动作现在有多个调用方——setup、sidecar 崩溃恢复、
//! single-instance 回调、RunEvent::Reopen——各自重建一份 builder 必然漂移。

use std::sync::OnceLock;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 主窗口标签（capabilities/default.json 的 windows 匹配的就是它）
pub const MAIN_LABEL: &str = "main";

/// 当前 server origin（launch 成功后记录）：Reopen 时无窗口按它重建；
/// None = sidecar 还没起来（停 splash 阶段），重建回 splash 走启动流
static CURRENT_ORIGIN: OnceLock<String> = OnceLock::new();

pub fn create_main(
    handle: &AppHandle,
    url: WebviewUrl,
) -> tauri::Result<tauri::WebviewWindow> {
    WebviewWindowBuilder::new(handle, MAIN_LABEL, url)
        .title("毛线团")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 640.0)
        // issue #15 兜底：非本应用 origin 的整窗导航一律拒绝。正常链路里外链已被
        // 前端 document 拦截层转走，这里防的是漏网形态（无 target 链接、JS location 跳转）。
        // 白名单：tauri:// 自定义协议（splash / dev index.html 资产）+ 本地 http 回源
        //（生产 127.0.0.1:<port>；dev 由 devUrl 走 tauri:// 不进这里）。拒绝时把外链
        // 转交系统浏览器（opener），用户不丢上下文。
        .on_navigation(|url| {
            let s = url.as_str();
            if s.starts_with("tauri://") || s.starts_with("http://127.0.0.1:") || s.starts_with("http://localhost:") {
                return true;
            }
            if s.starts_with("http://") || s.starts_with("https://") {
                // shell-out 到系统 open（opener 插件 API 需要 Runtime 泛型句柄，
                // 导航回调里只有 Url；/usr/bin/open 与 opener 同一出口语义）
                let _ = std::process::Command::new("open")
                    .arg(s)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            }
            false
        })
        .build()
}

/// 窗口导航到 server origin（launch/崩溃恢复共用），并记录 origin 供 Reopen 重建。
pub fn navigate_main(handle: &AppHandle, origin: tauri::Url) -> tauri::Result<()> {
    let _ = CURRENT_ORIGIN.set(origin.to_string());
    match handle.get_webview_window(MAIN_LABEL) {
        Some(window) => window.navigate(origin),
        None => {
            // 理论不可达（navigate 前窗口必已创建）；兜底重建一个指向 origin 的窗口
            create_main(handle, WebviewUrl::External(origin))?;
            Ok(())
        }
    }
}

/// 聚焦主窗口（single-instance 回调）：窗口不存在时按记录的 origin 重建。
pub fn focus_main(handle: &AppHandle) {
    match handle.get_webview_window(MAIN_LABEL) {
        Some(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        None => reopen_main(handle),
    }
}

/// dock 图标点击（RunEvent::Reopen，无可见窗口）：按记录 origin 重建，
/// sidecar 未就绪时回 splash 重走启动流（后台拉起 + 健康检查后 navigate）。
pub fn reopen_main(handle: &AppHandle) {
    if handle.get_webview_window(MAIN_LABEL).is_some() {
        return;
    }
    let url = match CURRENT_ORIGIN.get() {
        Some(origin) => WebviewUrl::External(origin.parse().expect("记录过的 origin 必合法")),
        None => WebviewUrl::App("splash.html".into()),
    };
    let _ = create_main(handle, url);
}
