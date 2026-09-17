//! server sidecar 生命周期：探测端口（占用先验身份）→ 拉起 → 等健康检查（同样验身份）→ 退出时回收。
//!
//! 端口占用处理（M90）：18788 被占时不能盲目把窗口指过去——旧版打包残留的孤儿 sidecar
//! 没有静态托管，指过去就是 404。占用时先探测对端 /healthz 的身份标识（app:"yarnball"）：
//!   - 同包 server 且托管着 web 产物（webStatic）→ 直接复用，不再起第二个进程写同一份 SQLite；
//!   - 同包但无静态托管（旧版孤儿 sidecar）或根本不是 yarnball → 换端口起自己的 sidecar。
//! 不尝试 kill 占用进程：无法从壳侧安全确认对端就是自己包的旧 sidecar，误杀代价高于换端口。
//!
//! 优雅关停（issue #22）：server main.ts 有完整的 SIGTERM 处理链（stopAll 杀 agent 进程组、
//! 撤销 MCP token、会话状态落库），SIGKILL 下一个都不会执行——agent 子进程会泄漏成孤儿。
//! 所以 shutdown 先 SIGTERM + 宽限期轮询探活，超时才 SIGKILL 兜底。
//!
//! 崩溃恢复（issue #22）：运行期 sidecar 意外退出（非关停期）经 ON_CRASH 回调上抛，
//! 壳侧弹「重启服务」对话框并按原路径重新拉起。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const DEFAULT_PORT: u16 = 18788;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_INTERVAL: Duration = Duration::from_millis(150);
/// 占用探测是单次请求，不能拖慢启动；对端卡死时按「身份不明」处理（换端口）
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// SIGTERM 后等 server 优雅退出的宽限期：正常关停亚秒级（关 HTTP + SQLite + 杀 agent 树），
/// 留余量到 3s；超时 SIGKILL 兜底（宁可丢优雅性也不能留下占端口的活进程）
const GRACEFUL_TIMEOUT: Duration = Duration::from_secs(3);

/// 关停所需的最小句柄：SIGTERM 用 pid 直发（&self 的 CommandChild 没有 kill 之外的信号接口）
struct SidecarHandle {
    child: CommandChild,
    pid: u32,
}

static SIDECAR: Mutex<Option<SidecarHandle>> = Mutex::new(None);
/// 关停期标记：此期间 sidecar 退出事件是预期内的，不触发崩溃回调
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
/// sidecar 意外退出时的回调（崩溃恢复入口，issue #22）：setup 阶段注册一次
static ON_CRASH: OnceLock<Box<dyn Fn(&tauri::AppHandle) + Send + Sync>> = OnceLock::new();

/// 注册 sidecar 意外退出回调（main setup 阶段调用一次）。
pub fn on_unexpected_exit(f: Box<dyn Fn(&tauri::AppHandle) + Send + Sync>) {
    let _ = ON_CRASH.set(f);
}

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

/// spawn 一个 yarnball sidecar（不等待健康检查）。launch 与崩溃恢复的 relaunch 共用。
fn spawn_sidecar(app: &tauri::AppHandle, port: u16) -> Result<CommandChild, String> {
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

    let (mut rx, child) = sidecar.spawn().map_err(|e| format!("sidecar 拉起失败：{e}"))?;

    // sidecar 输出转到主进程 stderr，便于终端排查；
    // Terminated 事件在此分流：关停期静默，运行期触发 ON_CRASH（崩溃恢复，issue #22）
    let app_for_events = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    eprintln!("[server] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[server] sidecar 退出：code={:?}", status.code);
                    // 清掉句柄登记（进程已死）。预期性判定在拿锁之后：拿不到锁说明
                    // shutdown 正持锁操作——本就处于关停路径，直接跳过回调。
                    let expected = SHUTTING_DOWN.load(Ordering::SeqCst);
                    let was_registered = SIDECAR
                        .lock()
                        .map(|mut guard| guard.take().is_some())
                        .unwrap_or(false);
                    if !expected && was_registered {
                        if let Some(cb) = ON_CRASH.get() {
                            cb(&app_for_events);
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
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

    let child = spawn_sidecar(app, port)?;
    let pid = child.pid();
    *SIDECAR.lock().map_err(|e| e.to_string())? = Some(SidecarHandle { child, pid });

    wait_healthy(port)?;
    format!("http://127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("URL 解析失败：{e}"))
}

/// 崩溃恢复（issue #22）：重新拉起 sidecar 并把主窗口导航回去。
/// 在后台线程调用（dialog 弹窗不能占主线程 blocking）。
pub fn relaunch(app: &tauri::AppHandle) -> Result<tauri::Url, String> {
    // 崩溃后关停标记可能残留（上一次 shutdown 中途失败等），恢复运行态语义
    SHUTTING_DOWN.store(false, Ordering::SeqCst);
    launch(app)
}

/// 应用退出时回收 sidecar：先 SIGTERM 让 server 走优雅关闭链（杀 agent 子进程组、
/// 撤销 token、会话落库），宽限期内轮询探活，超时 SIGKILL 兜底。
/// 信号处理器与 RunEvent::Exit 都会调到这里，幂等（句柄 take 后二次调用为 no-op）。
pub fn shutdown() {
    let Some(handle) = SIDECAR.lock().ok().and_then(|mut guard| guard.take()) else {
        return;
    };
    SHUTTING_DOWN.store(true, Ordering::SeqCst);

    // SIGTERM：直接 kill(1) 子进程（进程内不引 libc，shell-out 到 /bin/kill；
    // server 侧 main.ts 的 SIGTERM 处理器负责优雅关闭）
    let pid = handle.pid.to_string();
    let term_ok = std::process::Command::new("kill")
        .args(["-TERM", &pid])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !term_ok {
        // 发信号失败（进程可能已死或权限问题）：SIGKILL 兜底
        let _ = handle.child.kill();
        return;
    }

    // 宽限期轮询探活（kill -0）；进程消失即优雅退出完成。
    // reap 由 shell 插件的事件循环负责（持有 rx 的 async 任务收 Ended/Terminated）。
    let deadline = Instant::now() + GRACEFUL_TIMEOUT;
    while Instant::now() < deadline {
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !alive {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = handle.child.kill();
}
