//! 首启引导占位：检测 agent CLI 可用性，提醒配置高德 key。
//! 完整引导页待后续迭代；此处用原生对话框 + 一次性标记文件实现最小闭环。
//! 高德 key 与 agent CLI 的管理界面就是应用内的「设置」抽屉（已有功能）。

use std::path::PathBuf;

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const AGENT_CLIS: [(&str, &str); 3] = [
    ("Kimi Code", "kimi"),
    ("Gemini CLI", "gemini"),
    ("Claude Code (ACP)", "claude-code-acp"),
];

fn which(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn marker_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("first-run-done"))
}

pub fn maybe_show(app: &tauri::AppHandle) {
    let Some(marker) = marker_path(app) else { return };
    if marker.exists() {
        return;
    }

    let found: Vec<&str> = AGENT_CLIS
        .iter()
        .filter(|(_, cmd)| which(cmd))
        .map(|(label, _)| *label)
        .collect();
    let agent_line = if found.is_empty() {
        "未检测到可用的 agent CLI（kimi / gemini / claude-code-acp）。\n请先在终端安装其一，再到应用内「设置」选择。".to_string()
    } else {
        format!("已检测到 agent CLI：{}", found.join("、"))
    };

    app.dialog()
        .message(format!(
            "欢迎使用毛线团！\n\n{agent_line}\n\n国内行程需要高德开放平台 key，\n请在应用内「设置」抽屉中填写（海外行程零配置）。"
        ))
        .title("毛线团 · 首次启动")
        .blocking_show();

    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(marker, b"");
}
