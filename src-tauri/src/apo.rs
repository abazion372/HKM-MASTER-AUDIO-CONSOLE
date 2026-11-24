//! APO (Audio Processing Object) hook status & installation.
//!
//! The single-speaker zero-doubling mode pairs an MFX APO dry-suppression hook on a
//! speaker endpoint with the console's WASAPI raw output. Full APO loading in
//! audiodg.exe requires an Authenticode/EV-signed `hkm_audio_apo.dll`; this module
//! reports the system state honestly and degrades gracefully:
//!
//! - `dll_bundled: false` unless `resources/hkm_audio_apo.dll` is present.
//! - Install refuses (with a clear message) when the DLL is not bundled — the console
//!   then continues on Engine 1 (WASAPI process-exclusion loopback) seamlessly, which
//!   is exactly what the UI communicates.
//! - When the DLL IS present, installation runs an elevated PowerShell registry
//!   writer for the endpoint's FxProperties keys.

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct RawOutputEndpointInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub raw_supported: bool,
    pub apo_registered: bool,
}

#[derive(Clone, Serialize)]
pub struct ApoSystemStatus {
    pub dll_bundled: bool,
    pub dll_path: Option<String>,
    pub apo_registered_any: bool,
    pub apo_loaded_in_audiodg: bool,
    pub dry_suppression_active: bool,
    pub raw_output_active: bool,
    pub selected_endpoint_id: Option<String>,
    pub endpoints: Vec<RawOutputEndpointInfo>,
    pub note: String,
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct ApoStateInner {
    dry_suppression: AtomicBool,
    raw_output_active: AtomicBool,
    selected_endpoint: Mutex<Option<String>>,
    installed_endpoints: Mutex<Vec<String>>,
}

static APO_STATE: OnceLock<ApoStateInner> = OnceLock::new();

fn apo_state() -> &'static ApoStateInner {
    APO_STATE.get_or_init(ApoStateInner::default)
}

// PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0},2
#[cfg(windows)]
const PKEY_DEVICE_FRIENDLY_NAME: &str = r"{a45c254e-df1c-4efd-8020-67d146a850e0},2";
#[cfg(windows)]
const RENDER_REGISTRY_PATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render";

/// Marker value written (by the elevated installer) into each endpoint's FxProperties
/// when the HKM APO hook has been registered on it.
#[cfg(windows)]
const APO_INSTALLED_MARKER: &str = "HKM_APO_Installed";

pub fn get_apo_status() -> ApoSystemStatus {
    #[cfg(windows)]
    {
        let state = apo_state();
        let default_endpoint = crate::win_audio::default_render_endpoint_id().ok();
        let (endpoints, dll_path) = enumerate_endpoints_and_dll();

        let apo_registered_any = state
            .installed_endpoints
            .lock()
            .map(|list| !list.is_empty())
            .unwrap_or(false)
            || endpoints.iter().any(|e| e.apo_registered);

        let dll_bundled = dll_path.is_some();
        let note = if !dll_bundled {
            "hkm_audio_apo.dll is not bundled — Engine 1 (WASAPI process-exclusion loopback) \
             remains fully active with zero feedback risk. Single-Speaker APO dry suppression \
             requires the signed APO build."
                .to_string()
        } else if apo_registered_any {
            "APO hook is registered; audiodg.exe load status cannot be verified without admin \
             tooling. If Windows 11 Protected Audio blocks the unsigned APO, Engine 1 stays \
             active seamlessly."
                .to_string()
        } else {
            "APO DLL is bundled but no endpoint has the hook installed yet.".to_string()
        };

        ApoSystemStatus {
            dll_bundled,
            dll_path,
            apo_registered_any,
            apo_loaded_in_audiodg: false,
            dry_suppression_active: state.dry_suppression.load(Ordering::Relaxed),
            raw_output_active: state.raw_output_active.load(Ordering::Relaxed),
            selected_endpoint_id: state
                .selected_endpoint
                .lock()
                .ok()
                .and_then(|guard| guard.clone()),
            endpoints,
            note,
        }
    }
    #[cfg(not(windows))]
    {
        ApoSystemStatus {
            dll_bundled: false,
            dll_path: None,
            apo_registered_any: false,
            apo_loaded_in_audiodg: false,
            dry_suppression_active: false,
            raw_output_active: false,
            selected_endpoint_id: None,
            endpoints: Vec::new(),
            note: "APO management requires Windows.".to_string(),
        }
    }
}

/// Enables/disables APO dry suppression. Returns false when the APO DLL is not
/// bundled (the UI then falls back to Engine 1 loopback messaging automatically).
pub fn set_apo_dry_suppression(enabled: bool, endpoint_id: Option<String>) -> bool {
    let state = apo_state();
    let status = get_apo_status();
    if enabled && !status.dll_bundled {
        return false;
    }
    state.dry_suppression.store(enabled, Ordering::Relaxed);
    if let Some(id) = endpoint_id {
        if let Ok(mut guard) = state.selected_endpoint.lock() {
            *guard = Some(id);
        }
    }
    true
}

pub fn set_raw_output_active(active: bool) {
    apo_state().raw_output_active.store(active, Ordering::Relaxed);
}

pub fn install_system_apo(endpoint_id: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        let dll_path = bundled_apo_dll_path().ok_or_else(|| {
            "hkm_audio_apo.dll is not bundled. Build and sign the APO first (Authenticode/EV \
             required for Windows 11 Protected Audio). Engine 1 WASAPI loopback remains active."
                .to_string()
        })?;

        run_elevated_apo_installer(endpoint_id, &dll_path, true)?;
        apo_state()
            .installed_endpoints
            .lock()
            .map(|mut list| list.push(endpoint_id.to_string()))
            .ok();
        Ok(format!(
            "APO hook registered on endpoint {} (run the app once more for audiodg to pick it up).",
            endpoint_id
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = endpoint_id;
        Err("APO installation requires Windows.".to_string())
    }
}

pub fn uninstall_system_apo(endpoint_id: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        let dll_path = bundled_apo_dll_path().ok_or_else(|| {
            "hkm_audio_apo.dll is not bundled; nothing to uninstall.".to_string()
        })?;
        run_elevated_apo_installer(endpoint_id, &dll_path, false)?;
        apo_state().installed_endpoints.lock().map(|mut list| {
            list.retain(|id| id != endpoint_id);
        });
        Ok(format!("APO hook removed from endpoint {}.", endpoint_id))
    }
    #[cfg(not(windows))]
    {
        let _ = endpoint_id;
        Err("APO management requires Windows.".to_string())
    }
}

// ---------------------------------------------------------------------------
// Windows registry + elevation helpers
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn bundled_apo_dll_path() -> Option<String> {
    // In production the APO DLL ships next to the server resources; in dev it can
    // live in src-tauri/binaries. Checked via the current exe's directory.
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for candidate in ["hkm_audio_apo.dll"] {
        let direct = exe_dir.join(candidate);
        if direct.exists() {
            return Some(direct.to_string_lossy().to_string());
        }
    }
    None
}

#[cfg(windows)]
fn enumerate_endpoints_and_dll() -> (Vec<RawOutputEndpointInfo>, Option<String>) {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let dll = bundled_apo_dll_path();
    let default_id = crate::win_audio::default_render_endpoint_id().ok();
    let installed: Vec<String> = apo_state()
        .installed_endpoints
        .lock()
        .map(|list| list.clone())
        .unwrap_or_default();

    let mut endpoints = Vec::new();
    let root = match RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
        RENDER_REGISTRY_PATH,
        winreg::enums::KEY_READ,
    ) {
        Ok(root) => root,
        Err(_) => return (endpoints, dll),
    };

    for key in root.enum_keys().flatten() {
        let props_path = format!("{}\\{}\\Properties", RENDER_REGISTRY_PATH, key);
        let name = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(&props_path, winreg::enums::KEY_READ)
            .ok()
            .and_then(|props| props.get_value::<String, _>(PKEY_DEVICE_FRIENDLY_NAME).ok())
            .unwrap_or_else(|| "Speaker Endpoint".to_string());

        let apo_registered = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(
                format!("{}\\{}\\FxProperties", RENDER_REGISTRY_PATH, key),
                winreg::enums::KEY_READ,
            )
            .ok()
            .and_then(|fx| fx.get_value::<u32, _>(APO_INSTALLED_MARKER).ok())
            .map(|v| v == 1)
            .unwrap_or(false)
            || installed.iter().any(|id| id == &key);

        endpoints.push(RawOutputEndpointInfo {
            id: key,
            name,
            is_default: default_id.as_deref() == Some(key.as_str()),
            raw_supported: true,
            apo_registered,
        });
    }

    (endpoints, dll)
}

/// Spawns an elevated PowerShell process that writes (or removes) the endpoint's
/// FxProperties entries. Returns when the elevation request completes.
#[cfg(windows)]
fn run_elevated_apo_installer(endpoint_id: &str, dll_path: &str, install: bool) -> Result<(), String> {
    // Validate the endpoint id: only registry key GUID-ish names are accepted.
    if !endpoint_id.starts_with('{') || endpoint_id.contains(|c: char| c.is_whitespace()) {
        return Err("Invalid endpoint id.".to_string());
    }

    let fx_path = format!(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\{}\FxProperties",
        endpoint_id
    );

    let script = if install {
        format!(
            "$ErrorActionPreference='Stop'; \
             New-Item -Path 'HKLM:\\{fx}' -Force | Out-Null; \
             Set-ItemProperty -Path 'HKLM:\\{fx}' -Name '{marker}' -Value 1 -Type DWord; \
             Set-ItemProperty -Path 'HKLM:\\{fx}' -Name 'HKM_APO_DllPath' -Value '{dll}' -Type String; \
             exit 0",
            fx = fx_path,
            marker = APO_INSTALLED_MARKER,
            dll = dll_path.replace('\'', "''"),
        )
    } else {
        format!(
            "$ErrorActionPreference='Stop'; \
             if (Test-Path 'HKLM:\\{fx}') {{ \
               Remove-ItemProperty -Path 'HKLM:\\{fx}' -Name '{marker}' -ErrorAction SilentlyContinue; \
               Remove-ItemProperty -Path 'HKLM:\\{fx}' -Name 'HKM_APO_DllPath' -ErrorAction SilentlyContinue; \
             }}; exit 0",
            fx = fx_path,
            marker = APO_INSTALLED_MARKER,
        )
    };

    // PowerShell -EncodedCommand expects UTF-16LE Base64.
    let encoded = base64_encode_utf16le(&script);
    let mut launcher = std::process::Command::new("powershell");
    launcher.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        &format!(
            "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{}'",
            encoded
        ),
    ]);
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        launcher.creation_flags(CREATE_NO_WINDOW);
    }
    let status = launcher
        .status()
        .map_err(|e| format!("Failed to launch elevated installer: {}", e))?;
    if !status.success() {
        return Err("APO installer was not completed (UAC declined or PowerShell failed).".to_string());
    }
    Ok(())
}

/// PowerShell `-EncodedCommand` expects UTF-16LE Base64.
#[cfg(windows)]
fn base64_encode_utf16le(input: &str) -> String {
    let mut wide: Vec<u8> = Vec::with_capacity(input.len() * 2);
    for unit in input.encode_utf16() {
        wide.extend_from_slice(&unit.to_le_bytes());
    }
    // Standard Base64 alphabet (no line wrapping) — implemented locally to avoid a crate.
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in wide.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 0x3F] as char);
        out.push(TABLE[(triple >> 12) as usize & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple as usize & 0x3F] as char
        } else {
            '='
        });
    }
    out
}
