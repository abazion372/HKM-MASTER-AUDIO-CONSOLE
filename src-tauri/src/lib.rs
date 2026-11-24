//! HKM Audio System — Tauri 2 desktop shell.
//!
//! Architecture:
//! - The web console (Next.js, `src/`) runs on a local HTTP server managed by
//!   [`server::ServerManager`] and is displayed in the main webview window.
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
    pub server: server::ServerManager,
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
    /// Live native output stream status: None = off, "shared …" / "exclusive …"
    /// = running, "…-error: …" = last failure (v2 per-jack engine).
    raw_output_mode: Option<String>,
    reason: Option<String>,
}

/// Physical jack metadata for a render endpoint, read through the Windows
/// Device Topology API (IKsJackDescription). Contract:
/// `src/hkm/utils/nativeDesktopAudio.ts` → `DesktopJackDescription`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopJackDescription {
    /// MMDevice endpoint ID (registry key name under MMDevices\Audio\Render).
    pub endpoint_id: String,
    /// Endpoint friendly name, e.g. "Speakers (Realtek(R) Audio)".
    pub friendly_name: String,
    /// Jack index within the endpoint's IKsJackDescription.
    pub jack_index: u32,
    /// Silkscreen colour, 0x00RRGGBB (0 = unknown).
    pub color_rgb: u32,
    /// First WAVEFORMATEXTENSIBLE channel position this jack feeds (-1 unknown).
    pub channel: i32,
    /// Whether a plug is physically detected in the jack.
    pub is_connected: bool,
    /// Connector type hint (e.g. "analog-jack-3.5mm", "optical", "hdmi").
    pub connector_type: String,
    /// Chassis location hint (e.g. "rear", "front").
    pub location: String,
}

// ---------------------------------------------------------------------------
// Commands (contract: src/hkm/utils/nativeDesktopAudio.ts & appApi.ts)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn desktop_api_request(
    state: tauri::State<'_, DesktopState>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<http_api::DesktopApiResponse, String> {
    let base = state.server.base_url();
    if base.is_empty() {
        return Err("Console server is not running.".to_string());
    }
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
            raw_output_mode: state.raw_output.current_status(),
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
            raw_output_mode: None,
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
fn list_jack_descriptions() -> Vec<DesktopJackDescription> {
    win_audio::list_jack_descriptions()
}

#[tauri::command]
async fn start_raw_output(
    state: tauri::State<'_, DesktopState>,
    endpoint_id: Option<String>,
    channels: Option<u16>,
    exclusive: Option<bool>,
) -> Result<(), String> {
    apo::set_raw_output_active(true);
    // Stereo is the classic web-worklet contract; 3..=32 arms the discrete
    // multichannel path (WAVEFORMATEXTENSIBLE speaker-mask stream) for
    // per-jack rendering on 5.1/7.1/pro cards. `exclusive` opens the endpoint
    // in exclusive WASAPI (bit-perfect per-jack delivery, no shared mixer or
    // APO interference — the v2 native engine path).
    let ch = channels.unwrap_or(2).clamp(2, 32);
    state
        .raw_output
        .start(endpoint_id, ch, exclusive.unwrap_or(false))
}

/// Receives raw 48 kHz interleaved Float32 blocks (10 ms / 480 frames — stereo
/// or N-channel matching the armed jack layout) from the web `raw-output-tap`
/// AudioWorklet via the raw IPC body.
///
/// NOTE: on newer tauri versions the parameter is `tauri::ipc::Request` without
/// a lifetime — drop `<'_>` if the compiler complains.
#[tauri::command]
async fn push_raw_output_pcm(
    state: tauri::State<'_, DesktopState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            // Only complete f32 stereo frames are accepted (8-byte multiples).
            if bytes.len() % 8 != 0 {
                return Ok(()); // Ignore malformed tails (frontend also tolerates drops).
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
    if let Some(state) = app.try_state::<DesktopState>() {
        state.server.shutdown();
    }
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // MUST stay the first registered plugin: the second instance of the
        // app hands its args to this callback and exits before reaching setup.
        // This also guarantees that at startup any running hkm-server.exe is
        // a stale orphan (safe to kill) rather than a live second console.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        // Church console policy: the operator assigns physical inputs inside
        // the app, so the WebView microphone permission is granted natively and
        // the Chromium "wants to use your microphone" prompt NEVER appears —
        // not on first run, not after an update, and not when the console
        // server falls back to a different fixed port (new origin).
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let http = reqwest::Client::new();
            let state = DesktopState {
                http: http.clone(),
                server: server::ServerManager::new(),
                captures: win_audio::CaptureRegistry::new(),
                raw_output: win_audio::RawOutputEngine::new(),
            };
            app.manage(state);

            let handle = app.handle().clone();
            let base = match server::ensure_server(
                app.handle(),
                &app.state::<DesktopState>().inner().server,
                &http,
            ) {
                Ok(base) => base,
                Err(err) => {
                    fatal_message(&handle, &format!("The HKM console server could not start.\n\n{}", err));
                    return Err(Box::new(std::io::Error::other(err)));
                }
            };

            let url: tauri::Url = base
                .parse()
                .map_err(|err| format!("Invalid server URL '{}': {}", base, err))?;
            if let Err(e) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("HKM Audio System — Church Audio Console")
                .inner_size(1680.0, 980.0)
                .min_inner_size(1280.0, 800.0)
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
            list_jack_descriptions,
            start_raw_output,
            push_raw_output_pcm,
            stop_raw_output,
            open_windows_sound_settings,
            system_cpu_usage,
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
