mod onboarding;
// pub：examples/pdf_probe.rs 无头验证复用生产同一份打印配置/打印路径，防漂移
pub mod pdf;
mod sidecar;
mod window;

use tauri::{RunEvent, WebviewUrl};
use tauri_plugin_dialog::DialogExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // issue #15：外链统一走系统默认浏览器（前端 document 拦截层调 plugin:opener|open_url）
        .plugin(tauri_plugin_opener::init())
        // issue #22：单实例——二实例只聚焦首实例主窗口然后退出，避免两个壳
        // 共享/互杀同一个 sidecar（首实例退出时会把复用中的 sidecar 一起带走）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::focus_main(app);
        }))
        .invoke_handler(tauri::generate_handler![pdf::export_pdf])
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

            // issue #22：sidecar 运行期意外退出的恢复入口——后台线程弹原生对话框
            // （重启走原 launch 路径 + 窗口重新 navigate），不能阻塞事件回调线程
            sidecar::on_unexpected_exit(Box::new(move |app| {
                let app = app.clone();
                std::thread::spawn(move || {
                    let choice = app
                        .dialog()
                        .message("本地服务意外退出了。\n\n重启服务继续使用，还是退出应用？")
                        .title("毛线团")
                        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                            "重启服务".to_string(),
                            "退出应用".to_string(),
                        ))
                        .blocking_show();
                    if choice {
                        match sidecar::relaunch(&app) {
                            Ok(origin) => {
                                if let Err(e) = window::navigate_main(&app, origin) {
                                    eprintln!("[tauri] 崩溃恢复后窗口跳转失败：{e}");
                                }
                            }
                            Err(err) => {
                                eprintln!("[tauri] sidecar 重启失败：{err}");
                                app.exit(1);
                            }
                        }
                    } else {
                        app.exit(0);
                    }
                });
            }));

            let url = if tauri::is_dev() {
                // 开发模式：窗口加载 vite dev server（需先 `pnpm dev` 起 server + web，见 README）
                WebviewUrl::App("index.html".into())
            } else {
                // 生产模式：先加载本地 splash（奶油底 + icon，随包打在 frontendDist 里），
                // sidecar 在后台线程拉起，健康检查通过后 navigate 到 server 页面。
                // 这样启动期间用户看到的是品牌闪屏，而不是白屏/转圈或（旧 bug）被指向
                // 占端口孤儿进程的 404。
                window::create_main(&handle, WebviewUrl::App("splash.html".into()))?;

                let thread_handle = handle.clone();
                std::thread::spawn(move || {
                    match sidecar::launch(&thread_handle) {
                        Ok(origin) => {
                            if let Err(e) = window::navigate_main(&thread_handle, origin) {
                                eprintln!("[tauri] 窗口跳转 server 地址失败：{e}");
                            }
                        }
                        Err(err) => {
                            eprintln!("[tauri] sidecar 启动失败：{err}");
                            thread_handle
                                .dialog()
                                .message(format!(
                                    "本地服务启动失败：{err}\n\n请查看终端日志（[server] 前缀），或到 GitHub 提 issue。"
                                ))
                                .title("毛线团")
                                .show(|_| {});
                            // 启动失败时停在 splash：盲目 fallback 到 18788 可能指向
                            // 占端口的陌生进程/旧版孤儿（无静态托管，404），反而误导
                        }
                    }
                });

                onboarding::maybe_show(&handle);
                return Ok(());
            };

            window::create_main(&handle, url)?;

            onboarding::maybe_show(&handle);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                RunEvent::Exit => sidecar::shutdown(),
                // issue #22：macOS 关窗不退出（tao 未注册 terminateAfterLastWindowClosed），
                // dock 图标点击触发 Reopen——无主窗口时重建（按当前 server origin 或 splash 重新走启动流）
                RunEvent::Reopen { has_visible_windows, .. } => {
                    if !has_visible_windows {
                        window::reopen_main(app);
                    }
                }
                _ => {}
            }
        });
}
