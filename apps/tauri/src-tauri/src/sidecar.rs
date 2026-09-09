//! server sidecar 生命周期：探测端口 → 拉起 → 等健康检查 → 退出时回收。

use std::net::TcpListener;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

pub const DEFAULT_PORT: u16 = 18788;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_INTERVAL: Duration = Duration::from_millis(150);

static SIDECAR: Mutex<Option<CommandChild>> = Mutex::new(None);

/// server（@hono/node-server）绑的是 `::` 双栈通配，因此「端口空闲」必须
/// IPv4 + IPv6 两侧都绑定成功才算——只测 127.0.0.1 会漏掉对侧已被占的情况（EADDRINUSE）。
fn port_free(port: u16) -> bool {
    TcpListener::bind(("0.0.0.0", port)).is_ok() && TcpListener::bind(("::", port)).is_ok()
}

/// 首选 18788；被占用（如 dev server 已在跑）时让系统分配空闲端口。
fn pick_port(preferred: u16) -> u16 {
    if port_free(preferred) {
        return preferred;
    }
    for _ in 0..32 {
        let Ok(listener) = TcpListener::bind(("0.0.0.0", 0)) else {
            break;
        };
        let Ok(port) = listener.local_addr().map(|a| a.port()) else {
            continue;
        };
        drop(listener);
        if port_free(port) {
            return port;
        }
    }
    preferred
}

fn wait_healthy(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        if ureq::get(&url).call().is_ok_and(|mut resp| {
            resp.status() == 200 && resp.body_mut().read_to_string().is_ok_and(|b| b.contains("\"ok\":true"))
        }) {
            return Ok(());
        }
        thread::sleep(HEALTH_INTERVAL);
    }
    Err(format!("等待 {url} 健康检查超时（{HEALTH_TIMEOUT:?}）"))
}

/// 拉起 sidecar 并等待就绪，返回窗口应加载的源地址。
pub fn launch(app: &tauri::AppHandle) -> Result<tauri::Url, String> {
    let port = pick_port(DEFAULT_PORT);
    let origin = format!("http://127.0.0.1:{port}");

    // SQLite（M80 之后）默认库文件在 ~/.yarnball/yarnball.db，随用户走，无需配置；
    // DATABASE_URL 若已设置则原样透传（开发机覆盖用）。
    let mut sidecar = app
        .shell()
        .sidecar("yarnball-server")
        .map_err(|e| format!("解析 sidecar 二进制失败：{e}"))?
        .env("SERVER_PORT", port.to_string())
        .env("SERVER_BASE_URL", &origin)
        .env("WEB_ORIGIN", &origin);

    // bundle resources：better-sqlite3 原生模块（NODE_PATH 桥接 SEA 的 require 解析）
    // 与 drizzle 迁移目录（sea-entry 启动时自动迁移）。
    if let Ok(res_dir) = app.path().resource_dir() {
        sidecar = sidecar
            .env("NODE_PATH", res_dir.join("node_modules").to_string_lossy().to_string())
            .env("YARNBALL_MIGRATIONS_DIR", res_dir.join("migrations").to_string_lossy().to_string())
            // web 构建产物（随包打进 resources/web-dist，server 生产态静态托管，M85 契约）
            .env("YARNBALL_WEB_DIST_DIR", res_dir.join("web-dist").to_string_lossy().to_string());
    }

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("sidecar 拉起失败：{e}"))?;

    // sidecar 输出转到主进程 stderr，便于 Console.app / 终端排查
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    eprintln!("[server] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[server] sidecar 退出：code={:?}", status.code);
                    break;
                }
                _ => {}
            }
        }
    });

    *SIDECAR.lock().map_err(|e| e.to_string())? = Some(child);

    wait_healthy(port)?;
    origin.parse().map_err(|e| format!("URL 解析失败：{e}"))
}

/// 应用退出时回收 sidecar（显式 kill，避免孤儿进程占端口）。
pub fn shutdown() {
    if let Ok(mut guard) = SIDECAR.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}
