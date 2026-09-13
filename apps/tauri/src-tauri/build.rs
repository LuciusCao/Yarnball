fn main() {
    // app 自定义 command 的 ACL 声明（M104 export_pdf 漏配导致「Command export_pdf not
    // allowed by ACL」）：Tauri 2 的 IPC ACL 在 app 存在 ACL manifest 后对所有 app command
    // 强制校验（tauri/src/webview/mod.rs 的 has_app_acl_manifest 判定），必须在此登记，
    // 由 tauri-build 自动生成 allow-export-pdf / deny-export-pdf 权限（下划线转连字符），
    // 再在 capabilities/default.json 里引用 allow-export-pdf 放行。
    // 新增 #[tauri::command] 时必须同步加到这里，否则壳内调用必被 ACL 拦截。
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["export_pdf"]),
    );
    tauri_build::try_build(attributes).expect("tauri-build 失败");
}
