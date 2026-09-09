mod onboarding;
mod sidecar;

use std::thread;

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // SIGTERM/SIGINT 兜底：RunEvent::Exit 只在正常退出（Cmd+Q / 菜单退出）时触发，
            // 信号终止不走事件循环，需在这里先回收 sidecar 再退出，避免孤儿进程占端口。
            // 必须在 sidecar::launch 之前安装——launch 内有最长 20s 的健康检查窗口，
            // 期间收到信号若处理器未就位，sidecar 会成孤儿。
            #[cfg(unix)]
            tauri::async_runtime::spawn(async {
                use tokio::signal::unix::{signal, SignalKind};
                let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
                let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
                tokio::select! {
                    _ = term.recv() => {}
                    _ = int.recv() => {}
                }
                sidecar::shutdown();
                std::process::exit(0);
            });

            let url = if tauri::is_dev() {
                // 开发模式：窗口加载 vite dev server（需先 `pnpm dev` 起 server + web，见 README）
                WebviewUrl::App("index.html".into())
            } else {
                // 生产模式：先加载本地 splash（奶油底 + icon，随包打在 frontendDist 里），
                // sidecar 在后台线程拉起，健康检查通过后 navigate 到 server 页面。
                // 这样启动期间用户看到的是品牌闪屏，而不是白屏/转圈或（旧 bug）被指向
                // 占端口孤儿进程的 404。
                let window = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("splash.html".into()))
                    .title("毛线团")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(960.0, 640.0)
                    .build()?;

                let thread_handle = handle.clone();
                thread::spawn(move || {
                    match sidecar::launch(&thread_handle) {
                        Ok(origin) => {
                            if let Err(e) = window.navigate(origin) {
                                eprintln!("[tauri] 窗口跳转 server 地址失败：{e}");
                            }
                        }
                        Err(err) => {
                            eprintln!("[tauri] sidecar 启动失败：{err}");
                            thread_handle
                                .dialog()
                                .message(format!(
                                    "本地服务启动失败：{err}\n\n请查看终端/Console 日志（[server] 前缀），或到 GitHub 提 issue。"
                                ))
                                .title("毛线团")
                                .blocking_show();
                            // 启动失败时停在 splash：盲目 fallback 到 18788 可能指向
                            // 占端口的陌生进程/旧版孤儿（无静态托管，404），反而误导
                        }
                    }
                });

                onboarding::maybe_show(&handle);
                return Ok(());
            };

            WebviewWindowBuilder::new(&handle, "main", url)
                .title("毛线团")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .build()?;

            onboarding::maybe_show(&handle);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let RunEvent::Exit = event {
                sidecar::shutdown();
            }
        });
}
