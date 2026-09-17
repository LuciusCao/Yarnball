//! 首启引导占位：提醒配置 agent CLI 与高德 key。
//! 完整引导页待后续迭代；此处用原生对话框 + 一次性标记文件实现最小闭环。
//! 高德 key 与 agent CLI 的管理界面就是应用内的「设置」抽屉（已有功能）。
//!
//! issue #22：去掉壳侧 which 探测——GUI app 的 PATH 极简（launchd 只给 /usr/bin:/bin:…），
//! nvm/brew/npm 装的 agent CLI 全在 PATH 之外，首启必然误报「未检测到」。
//! 可用性事实源是 server 的 GET /agents/detect（增强 PATH 搜索，processEnv.ts），
//! 这里直接探测不了（首启对话框时 server 未必就绪），改为引导用户到设置页看检测结果。
//!
//! 线程纪律：对话框从主线程 blocking_show 改为后台线程 show（回调式）——
//! blocking_show 虽经 rfd 无 parent 路径不死锁，但会泊住 setup（splash 渲染延后）。

use std::path::PathBuf;

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

fn marker_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("first-run-done"))
}

/// 首启欢迎对话框：后台线程回调式展示，不阻塞 setup/事件循环。
pub fn maybe_show(app: &tauri::AppHandle) {
    let Some(marker) = marker_path(app) else { return };
    if marker.exists() {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let app_for_cb = app.clone();
        app.dialog()
            .message(
                "欢迎使用毛线团！\n\n\
                agent CLI（kimi / gemini / claude-code-acp）的可用性请在应用内\n\
                「设置」抽屉查看与配置（检测走登录 shell，覆盖 npm/brew/nvm 安装）。\n\n\
                国内行程需要高德开放平台 key，请在「设置」抽屉中填写\n\
                （海外行程零配置，国内未配 key 时自动使用开源地图引擎）。",
            )
            .title("毛线团 · 首次启动")
            .show(move |_| {
                // 标记写在回调里：用户关掉对话框才算完成首启（中途退出下次还会弹）
                if let Some(marker) = marker_path(&app_for_cb) {
                    if let Some(dir) = marker.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(marker, b"");
                }
            });
    });
}
