//! HKM Audio System — Tauri 2 desktop shell.
//!
//! Architecture:
//! - The web console (Next.js, `src/`) runs on a local HTTP server managed by
//!   [`server::ManagedServer`] and is displayed in the main webview window.
//! - The frontend detects the shell via `window.__TAURI__.core.invoke`
//!   (`withGlobalTauri: true`) and unlocks the native desktop features:
//!   WASAPI process-exclusion loopback, per-app capture, source isolation,
//!   raw output, APO management and the native state API bridge.
//! - All commands implement the exact contract in
//!   `src/hkm/utils/{appApi,nativeDesktopAudio,appUpdater,systemMetrics}.ts`.

mod apo;
mod http_api;
mod server;
mod sys_cmds;
mod win_audio;
mod win_sessions;

use serde::Serialize;
use tauri::{
    webview::{PermissionKind, PermissionResponse},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};

/// Shared runtime state managed on the Tauri app.
pub struct DesktopState {
    pub http: reqwest::Client,
    pub captures: win_audio::CaptureRegistry,
    pub raw_output: win_audio::RawOutputEngine,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAudioStatus {
    supported: bool,
    os_build: u32,
    apo_active: bool,
    active_streams: Vec<String>,
    reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Commands (contract: src/hkm/utils/nativeDesktopAudio.ts & appApi.ts)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn desktop_api_request(
    state: tauri::State<'_, DesktopState>,
    server: tauri::State<'_, server::ManagedServer>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<http_api::DesktopApiResponse, String> {
    let base = server
        .base_url()
        .ok_or_else(|| "Console server is not running.".to_string())?;
    http_api::dispatch(&state.http, &base, method, path, body).await
}

#[tauri::command]
fn desktop_audio_status(state: tauri::State<'_, DesktopState>) -> DesktopAudioStatus {
    #[cfg(windows)]
    {
        let os_build = os_build_number();
        DesktopAudioStatus {
            supported: true,
            os_build,
            apo_active: apo::get_apo_status().apo_registered_any,
            active_streams: state.captures.active_keys(),
            reason: None,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        DesktopAudioStatus {
            supported: false,
            os_build: 0,
            apo_active: false,
            active_streams: Vec::new(),
            reason: Some("Desktop audio engine requires Windows.".to_string()),
        }
    }
}

#[tauri::command]
fn list_desktop_audio_sessions() -> Vec<win_sessions::DesktopAudioSession> {
    win_sessions::list_sessions()
}

#[tauri::command]
fn start_desktop_audio_capture(
    state: tauri::State<'_, DesktopState>,
    stream_key: String,
    target_pid: Option<u32>,
    audio_channel: tauri::ipc::Channel<tauri::ipc::Response>,
) -> Result<(), String> {
    state.captures.start(&stream_key, target_pid, audio_channel)
}

#[tauri::command]
fn stop_desktop_audio_capture(state: tauri::State<'_, DesktopState>, stream_key: String) {
    state.captures.stop(&stream_key);
}

#[tauri::command]
fn stop_all_desktop_audio_captures(state: tauri::State<'_, DesktopState>) {
    state.captures.stop_all();
}

#[tauri::command]
fn set_desktop_audio_source_isolation(
    enabled: bool,
) -> win_sessions::DesktopSourceIsolationStatus {
    win_sessions::isolation_singleton().set_isolation(enabled)
}

#[tauri::command]
fn get_apo_status() -> apo::ApoSystemStatus {
    apo::get_apo_status()
}

#[tauri::command]
fn set_apo_dry_suppression(enabled: bool, endpoint_id: Option<String>) -> bool {
    apo::set_apo_dry_suppression(enabled, endpoint_id)
}

#[tauri::command]
fn install_system_apo(endpoint_id: String) -> Result<String, String> {
    apo::install_system_apo(&endpoint_id)
}

#[tauri::command]
fn uninstall_system_apo(endpoint_id: String) -> Result<String, String> {
    apo::uninstall_system_apo(&endpoint_id)
}

#[tauri::command]
async fn start_raw_output(
    state: tauri::State<'_, DesktopState>,
    endpoint_id: Option<String>,
) -> Result<(), String> {
    let _ = endpoint_id;
    apo::set_raw_output_active(true);
    state.raw_output.start()
}

/// Receives raw 48 kHz interleaved Float32 stereo blocks (10 ms / 3840 bytes)
/// from the web `raw-output-tap` AudioWorklet via the raw IPC body.
#[tauri::command]
async fn push_raw_output_pcm(
    state: tauri::State<'_, DesktopState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            if bytes.len() % 8 != 0 {
                return Ok(());
            }
            state.raw_output.push(bytes.to_vec())
        }
        _ => Err("push_raw_output_pcm expects a raw binary body.".to_string()),
    }
}

#[tauri::command]
async fn stop_raw_output(state: tauri::State<'_, DesktopState>) -> Result<(), String> {
    apo::set_raw_output_active(false);
    state.raw_output.stop();
    Ok(())
}

#[tauri::command]
fn open_windows_sound_settings(page: String) -> bool {
    sys_cmds::open_windows_sound_settings(&page)
}

#[tauri::command]
fn system_cpu_usage() -> Option<f64> {
    sys_cmds::system_cpu_usage()
}

#[tauri::command]
fn prepare_for_update(app: AppHandle) {
    // Cleanly stop audio captures and raw output before the NSIS passive updater
    // launches so no audio or file handle remains locked during in-place update.
    if let Some(state) = app.try_state::<DesktopState>() {
        state.captures.stop_all();
        state.raw_output.stop();
    }
    let _ = win_sessions::isolation_singleton().set_isolation(false);
}

#[tauri::command]
fn finish_update_and_exit(app: AppHandle) {
    // Shut down the embedded server and exit the old shell immediately so the
    // Windows NSIS `/P /R` updater can overwrite hkm-audio-system.exe without
    // file-lock contention and relaunch the new version cleanly.
    shutdown_everything(&app);
    app.exit(0);
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    shutdown_everything(&app);
    app.restart();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn os_build_number() -> u32 {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .and_then(|key| key.get_value::<String, _>("CurrentBuildNumber"))
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

#[cfg(not(windows))]
fn os_build_number() -> u32 {
    0
}

/// Native fatal-error dialog so startup failures are never silent.
fn fatal_message(app: &AppHandle, message: &str) {
    eprintln!("[hkm-audio] fatal: {}", message);
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::{
            MB_ICONERROR, MB_OK, MessageBoxW,
        };
        let text: Vec<u16> = format!("{}\0", message).encode_utf16().collect();
        let caption: Vec<u16> = "HKM Audio System\0".encode_utf16().collect();
        unsafe {
            MessageBoxW(
                None,
                PCWSTR(text.as_ptr()),
                PCWSTR(caption.as_ptr()),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    let _ = app;
}

fn shutdown_everything(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        state.captures.stop_all();
        state.raw_output.stop();
    }
    let _ = win_sessions::isolation_singleton().set_isolation(false);
    if let Some(server) = app.try_state::<server::ManagedServer>() {
        server.shutdown();
    }
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(server::ManagedServer::default())
        .setup(|app| {
            // Run on a dedicated worker thread so COM MTA initialization never
            // poisons the main GUI thread's STA apartment required by tao/OleInitialize.
            std::thread::spawn(|| {
                win_sessions::ensure_self_sessions_unmuted();
            });
            let http = reqwest::Client::new();
            let state = DesktopState {
                http,
                captures: win_audio::CaptureRegistry::new(),
                raw_output: win_audio::RawOutputEngine::new(),
            };
            app.manage(state);

            let handle = app.handle().clone();
            let base = match tauri::async_runtime::block_on(server::ensure_server(&handle)) {
                Ok(base) => base,
                Err(err) => {
                    fatal_message(
                        &handle,
                        &format!("The HKM console server could not start.\n\n{}", err),
                    );
                    return Err(Box::new(std::io::Error::other(err)));
                }
            };

            let url: tauri::Url = base
                .parse()
                .map_err(|err| format!("Invalid server URL '{}': {}", base, err))?;
            // min_inner_size(960, 600) ensures 100% compatibility on 1366x768 and 1024x768 PCs
            if let Err(e) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("HKM Audio System — Church Audio Console")
                .inner_size(1440.0, 860.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                .center()
                .build()
            {
                let msg = format!("Failed to create the main window: {}", e);
                fatal_message(&handle, &msg);
                return Err(Box::new(std::io::Error::other(msg)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_api_request,
            desktop_audio_status,
            list_desktop_audio_sessions,
            start_desktop_audio_capture,
            stop_desktop_audio_capture,
            stop_all_desktop_audio_captures,
            set_desktop_audio_source_isolation,
            get_apo_status,
            set_apo_dry_suppression,
            install_system_apo,
            uninstall_system_apo,
            start_raw_output,
            push_raw_output_pcm,
            stop_raw_output,
            open_windows_sound_settings,
            system_cpu_usage,
            prepare_for_update,
            finish_update_and_exit,
            restart_app,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building the HKM Audio System desktop application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            shutdown_everything(app_handle);
        }
    });
}
