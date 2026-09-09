//! server sidecar 生命周期：探测端口（占用先验身份）→ 拉起 → 等健康检查（同样验身份）→ 退出时回收。
//!
//! 端口占用处理（M90）：18788 被占时不能盲目把窗口指过去——旧版打包残留的孤儿 sidecar
//! 没有静态托管，指过去就是 404。占用时先探测对端 /healthz 的身份标识（app:"yarnball"）：
//!   - 同包 server 且托管着 web 产物（webStatic）→ 直接复用，不再起第二个进程写同一份 SQLite；
//!   - 同包但无静态托管（旧版孤儿 sidecar）或根本不是 yarnball → 换端口起自己的 sidecar。
//! 不尝试 kill 占用进程：无法从壳侧安全确认对端就是自己包的旧 sidecar，误杀代价高于换端口。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

pub const DEFAULT_PORT: u16 = 18788;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_INTERVAL: Duration = Duration::from_millis(150);
/// 占用探测是单次请求，不能拖慢启动；对端卡死时按「身份不明」处理（换端口）
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

static SIDECAR: Mutex<Option<CommandChild>> = Mutex::new(None);

/// /healthz 的身份标识（server 端 M90 起下发；旧版只有 {"ok":true}，视为身份不明）
struct HealthzIdentity {
    is_yarnball: bool,
    web_static: bool,
}

/// 「端口空闲」判定。注意：Rust 的 TcpListener::bind 在 Unix 上默认带 SO_REUSEADDR，
/// 而对端 node server 也带（node 默认）——macOS 上两个都带 SO_REUSEADDR 时，通配地址
/// 与具体地址的绑定可以「共存」（实测：127.0.0.1:18788 被占用时，bind 0.0.0.0:18788 与
/// bind [::]:18788 都能成功），光靠 bind 探测会漏报。这就是 M90 打包态 404 的根因链条：
/// 旧孤儿 sidecar（绑 127.0.0.1）在 18788 上没被探出 → 新 sidecar 同端口 EADDRINUSE 起不来
/// → 旧代码的健康检查被孤儿的 200 骗过 → 窗口指向没有静态托管的旧进程。
/// 所以先 connect 探活（有监听者必然 connect 得通），再用 bind 兜底未 listen 的占用。
fn port_free(port: u16) -> bool {
    const CONNECT_TIMEOUT: Duration = Duration::from_millis(200);
    let v4 = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let v6 = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port);
    if TcpStream::connect_timeout(&v4, CONNECT_TIMEOUT).is_ok()
        || TcpStream::connect_timeout(&v6, CONNECT_TIMEOUT).is_ok()
    {
        return false;
    }
    TcpListener::bind(("0.0.0.0", port)).is_ok() && TcpListener::bind(("::", port)).is_ok()
}

/// 让系统分配一个空闲端口。
fn pick_free_port() -> u16 {
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
    DEFAULT_PORT
}

/// 探测某端口 /healthz 的身份。任何网络/解析失败都返回 None（按身份不明处理）。
fn probe_healthz(port: u16) -> Option<HealthzIdentity> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(PROBE_TIMEOUT))
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let url = format!("http://127.0.0.1:{port}/healthz");
    let mut resp = agent.get(&url).call().ok()?;
    if resp.status() != 200 {
        return None;
    }
    let body = resp.body_mut().read_to_string().ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    Some(HealthzIdentity {
        is_yarnball: json.get("app").and_then(|v| v.as_str()) == Some("yarnball"),
        web_static: json.get("webStatic").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

/// 等待自己拉起的 sidecar 就绪。必须验身份（app:"yarnball"），不能只看 200——
/// 否则极端竞争下端口被别的 server 抢走，旧 server 的 {"ok":true} 会把我们骗过去。
fn wait_healthy(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(identity) = probe_healthz(port) {
            if identity.is_yarnball {
                return Ok(());
            }
        }
        thread::sleep(HEALTH_INTERVAL);
    }
    Err(format!("等待 {url} 健康检查超时（{HEALTH_TIMEOUT:?}）"))
}

/// 拉起 sidecar 并等待就绪，返回窗口应加载的源地址。
pub fn launch(app: &tauri::AppHandle) -> Result<tauri::Url, String> {
    let mut port = DEFAULT_PORT;
    if !port_free(DEFAULT_PORT) {
        match probe_healthz(DEFAULT_PORT) {
            Some(identity) if identity.is_yarnball && identity.web_static => {
                // 占用者是同包 server 且自己托管 UI（dev server / 已在运行的实例）：直接复用，
                // 避免再起一个进程写同一份 SQLite。不记录进 SIDECAR——不是我们的孩子，退出时不回收。
                eprintln!("[tauri] {DEFAULT_PORT} 已被 yarnball server（含静态托管）占用，直接复用");
                return format!("http://127.0.0.1:{DEFAULT_PORT}")
                    .parse()
                    .map_err(|e| format!("URL 解析失败：{e}"));
            }
            Some(identity) if identity.is_yarnball => {
                // 旧版孤儿 sidecar（无静态托管）：指过去就是 404，换端口
                eprintln!("[tauri] {DEFAULT_PORT} 被无静态托管的旧版 yarnball server 占用，换端口启动");
                port = pick_free_port();
            }
            _ => {
                // 陌生进程或身份不明：换端口
                eprintln!("[tauri] {DEFAULT_PORT} 被其他进程占用，换端口启动");
                port = pick_free_port();
            }
        }
    }
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
