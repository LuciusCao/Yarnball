mod onboarding;
mod sidecar;

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
                // 生产模式：拉起 server sidecar，窗口加载本地 server 的地址
                match sidecar::launch(&handle) {
                    Ok(origin) => WebviewUrl::External(origin),
                    Err(err) => {
                        eprintln!("[tauri] sidecar 启动失败：{err}");
                        app.dialog()
                            .message(format!(
                                "本地服务启动失败：{err}\n\n请查看终端/Console 日志（[server] 前缀），或到 GitHub 提 issue。"
                            ))
                            .title("毛线团")
                            .blocking_show();
                        // 仍打开窗口指向默认端口，便于用户看到服务端报错/已有实例
                        let fallback = format!("http://127.0.0.1:{}", sidecar::DEFAULT_PORT);
                        WebviewUrl::External(fallback.parse().expect("valid fallback url"))
                    }
                }
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
