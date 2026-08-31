#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, process::Command};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version, install_update_from_url])
        .run(tauri::generate_context!())
        .expect("error while running LOELSTI");
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn install_update_from_url(app: tauri::AppHandle, url: String) -> Result<String, String> {
    if !cfg!(target_os = "windows") {
        return Err("Der automatische Installer ist derzeit für Windows verfügbar.".to_string());
    }
    const PREFIX: &str = "https://github.com/stikerpo-spec/LOELSTI/releases/download/";
    if !url.starts_with(PREFIX) || !url.ends_with("/LOELSTI-Windows.exe") {
        return Err("Ungültige LOELSTI-Update-Adresse.".to_string());
    }
    let response = reqwest::blocking::get(&url)
        .map_err(|e| format!("Update konnte nicht heruntergeladen werden: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Update-Server antwortete mit Status {}.", response.status()));
    }
    let bytes = response.bytes()
        .map_err(|e| format!("Update-Daten konnten nicht gelesen werden: {e}"))?;
    let path = std::env::temp_dir().join("LOELSTI-Update.exe");
    fs::write(&path, &bytes)
        .map_err(|e| format!("Update konnte nicht gespeichert werden: {e}"))?;
    let mut command = Command::new(&path);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    command.spawn()
        .map_err(|e| format!("LOELSTI-Installer konnte nicht gestartet werden: {e}"))?;
    app.exit(0);
    Ok(path.to_string_lossy().into_owned())
}
