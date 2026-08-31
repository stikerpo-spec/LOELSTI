#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub fn run() {
    crate::app::run();
}

mod app {
    pub fn run() {
        super::desktop_run();
    }
}

fn desktop_run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error while running LOELSTI");
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}
