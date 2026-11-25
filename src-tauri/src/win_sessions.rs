//! Windows audio session enumeration + "source isolation" firewall.
//!
//! Source isolation implements the safety model described in the console UI
//! (`HardwareDiagnosticsModule`): while the HKM console's processed desktop-audio
//! output is audible on the speakers, HKM temporarily mutes the *source app*
//! Windows audio sessions (process loopback captures app audio pre-mute, so the
//! console still receives it), preventing double audio and runaway feedback.
//! When isolation is disabled, every session HKM itself muted is restored.
//! A background watcher re-checks for newly launched audio sessions ~1×/second
//! while isolation is active.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAudioSession {
    pub pid: u32,
    pub name: String,
    pub exe_path: String,
    pub state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSourceIsolationStatus {
    pub enabled: bool,
    pub muted_sessions: u32,
    pub skipped_sessions: u32,
    pub message: Option<String>,
}

struct IsolationWatcher {
    stop: std::sync::Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct IsolationManager {
    enabled: AtomicBool,
    muted_pids: Mutex<HashSet<u32>>,
    watcher: Mutex<Option<IsolationWatcher>>,
}

impl IsolationManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Enables or disables source isolation, returning the resulting status.
    pub fn set_isolation(&self, enabled: bool) -> DesktopSourceIsolationStatus {
        if enabled {
            let status = isolate_now(self);
            if status.enabled {
                self.enabled.store(true, Ordering::Relaxed);
                self.spawn_watcher();
            } else {
                // Unreliable isolation → restore immediately so nothing stays muted.
                let _ = restore_isolation(self);
                self.enabled.store(false, Ordering::Relaxed);
            }
            status
        } else {
            self.enabled.store(false, Ordering::Relaxed);
            self.stop_watcher();
            let (muted, skipped, message) = restore_isolation(self);
            DesktopSourceIsolationStatus {
                enabled: false,
                muted_sessions: muted,
                skipped_sessions: skipped,
                message,
            }
        }
    }

    fn spawn_watcher(&self) {
        if let Ok(mut watcher_slot) = self.watcher.lock() {
            if watcher_slot.is_some() {
                return;
            }
            let stop = std::sync::Arc::new(AtomicBool::new(false));
            let thread_stop = stop.clone();
            let join = std::thread::Builder::new()
                .name("hkm-isolation-watch".to_string())
                .spawn(move || {
                    while !thread_stop.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(1000));
                        if thread_stop.load(Ordering::Relaxed) {
                            break;
                        }
                        let manager = isolation_singleton();
                        if manager.is_enabled() {
                            let _ = isolate_now(manager);
                        }
                    }
                })
                .ok();
            *watcher_slot = Some(IsolationWatcher { stop, join });
        }
    }

    fn stop_watcher(&self) {
        if let Ok(mut slot) = self.watcher.lock() {
            if let Some(mut watcher) = slot.take() {
                watcher.stop.store(true, Ordering::Relaxed);
                if let Some(join) = watcher.join.take() {
                    let _ = join.join();
                }
            }
        }
    }
}

static ISOLATION_MANAGER: OnceLock<IsolationManager> = OnceLock::new();

pub fn isolation_singleton() -> &'static IsolationManager {
    ISOLATION_MANAGER.get_or_init(IsolationManager::new)
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod windows_impl {
    use super::*;

    use std::collections::HashMap;
    use windows::core::{Interface, PWSTR};
    use windows::Win32::Foundation::{BOOL, CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::Media::Audio::{
        IAudioSessionControl, IAudioSessionControl2, IAudioSessionEnumerator, IAudioSessionManager2,
        ISimpleAudioVolume,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    extern "system" {
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> HANDLE;
        fn Process32FirstW(h_snapshot: HANDLE, lppe: *mut ProcessEntry32W) -> BOOL;
        fn Process32NextW(h_snapshot: HANDLE, lppe: *mut ProcessEntry32W) -> BOOL;
    }

    /// Returns the set of PIDs belonging to this console's own process tree
    /// (including all `msedgewebview2.exe` broker, renderer, and AudioService
    /// descendant processes). We must NEVER mute our own WebView2 audio process
    /// during source isolation, and if an earlier session left it muted in the
    /// Windows Volume Mixer, we unmute it automatically.
    fn collect_self_process_tree(self_pid: u32) -> HashSet<u32> {
        let mut tree = HashSet::new();
        tree.insert(self_pid);

        let mut parent_map: HashMap<u32, u32> = HashMap::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap != INVALID_HANDLE_VALUE && !snap.is_invalid() {
                let mut entry: ProcessEntry32W = std::mem::zeroed();
                entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
                if Process32FirstW(snap, &mut entry).as_bool() {
                    loop {
                        parent_map.insert(entry.th32_process_id, entry.th32_parent_process_id);
                        if !Process32NextW(snap, &mut entry).as_bool() {
                            break;
                        }
                    }
                }
                let _ = CloseHandle(snap);
            }
        }

        for &pid in parent_map.keys() {
            let mut cur = pid;
            for _ in 0..16 {
                if tree.contains(&cur) {
                    tree.insert(pid);
                    break;
                }
                match parent_map.get(&cur) {
                    Some(&parent) if parent != 0 && parent != cur => cur = parent,
                    _ => break,
                }
            }
        }
        tree
    }

    fn is_self_or_webview_session(pid: u32, self_tree: &HashSet<u32>) -> bool {
        if self_tree.contains(&pid) {
            return true;
        }
        if let Some((name, path)) = process_identity(pid) {
            let lower_name = name.to_ascii_lowercase();
            let lower_path = path.to_ascii_lowercase();
            if lower_name == "hkm-audio-system"
                || lower_name == "msedgewebview2"
                || lower_path.contains("hkm audio system")
                || lower_path.contains("church.hkm.audiosystem")
            {
                return true;
            }
        }
        false
    }

    struct SessionEntry {
        pid: u32,
        active: bool,
        control: IAudioSessionControl,
    }

    fn enumerate_sessions() -> Result<Vec<SessionEntry>, String> {
        crate::win_audio::com_init_for_caller()?;
        let device = crate::win_audio::default_render_device()?;
        let manager: IAudioSessionManager2 = unsafe { device.Activate(crate::win_audio::clsctx_all(), None) }
            .map_err(|e| format!("IAudioSessionManager2 activation failed: {}", e))?;
        let enumerator: IAudioSessionEnumerator = unsafe { manager.GetSessionEnumerator() }
            .map_err(|e| format!("GetSessionEnumerator failed: {}", e))?;

        let count: i32 = unsafe { enumerator.GetCount() }.map_err(|e| format!("GetCount failed: {}", e))?;

        let mut entries = Vec::new();
        for index in 0..count {
            let control: IAudioSessionControl = match unsafe { enumerator.GetSession(index) } {
                Ok(control) => control,
                Err(_) => continue,
            };
            let control2: IAudioSessionControl2 = match control.cast() {
                Ok(c2) => c2,
                Err(_) => continue,
            };
            let pid = unsafe { control2.GetProcessId() }.unwrap_or(0);
            // AudioSessionStateActive == 1 (Inactive=0, Expired=2).
            let state_raw = unsafe { control.GetState() }.map(|s| s.0).unwrap_or(0);
            entries.push(SessionEntry {
                pid,
                active: state_raw == 1,
                control,
            });
        }
        Ok(entries)
    }

    fn process_identity(pid: u32) -> Option<(String, String)> {
        // SAFETY: read-only process-image query with a scoped handle.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buffer = [0u16; 512];
            let mut len = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if ok && len > 0 {
                let path = String::from_utf16_lossy(&buffer[..len as usize]);
                let name = path
                    .rsplit(['\\', '/'])
                    .next()
                    .unwrap_or("app")
                    .trim_end_matches(".exe")
                    .to_string();
                Some((name, path))
            } else {
                None
            }
        }
    }

    pub(super) fn list_sessions_win() -> Vec<DesktopAudioSession> {
        let self_pid = unsafe { GetCurrentProcessId() };
        let self_tree = collect_self_process_tree(self_pid);
        match enumerate_sessions() {
            Ok(entries) => entries
                .into_iter()
                .filter(|entry| entry.pid != 0 && !is_self_or_webview_session(entry.pid, &self_tree))
                .map(|entry| {
                    let (name, path) =
                        process_identity(entry.pid).unwrap_or((format!("PID {}", entry.pid), String::new()));
                    DesktopAudioSession {
                        pid: entry.pid,
                        name,
                        exe_path: path,
                        state: if entry.active { "active".to_string() } else { "inactive".to_string() },
                    }
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Ensures HKM's own process tree (including its WebView2 AudioService child)
    /// is never left muted in the Windows Volume Mixer.
    pub(super) fn ensure_self_sessions_unmuted_win() {
        let self_pid = unsafe { GetCurrentProcessId() };
        let self_tree = collect_self_process_tree(self_pid);
        if let Ok(entries) = enumerate_sessions() {
            for entry in entries {
                if entry.pid != 0 && is_self_or_webview_session(entry.pid, &self_tree) {
                    if let Ok(volume) = entry.control.cast::<ISimpleAudioVolume>() {
                        if unsafe { volume.GetMute() }.map(|b| b.as_bool()).unwrap_or(false) {
                            let _ = unsafe { volume.SetMute(false, std::ptr::null()) };
                        }
                    }
                }
            }
        }
    }

    pub(super) fn isolate_now_win(
        muted_pids: &Mutex<HashSet<u32>>,
    ) -> (u32, u32, Vec<u32>) {
        let self_pid = unsafe { GetCurrentProcessId() };
        let self_tree = collect_self_process_tree(self_pid);
        let mut muted = 0u32;
        let mut skipped = 0u32;
        let mut newly_muted: Vec<u32> = Vec::new();

        match enumerate_sessions() {
            Ok(entries) => {
                for entry in entries {
                    if entry.pid == 0 {
                        continue;
                    }
                    // Self + WebView2 AudioService child tree: ensure UNMUTED so
                    // speaker output and OBS Application Audio Capture are never silenced!
                    if is_self_or_webview_session(entry.pid, &self_tree) {
                        if let Ok(volume) = entry.control.cast::<ISimpleAudioVolume>() {
                            if unsafe { volume.GetMute() }.map(|b| b.as_bool()).unwrap_or(false) {
                                let _ = unsafe { volume.SetMute(false, std::ptr::null()) };
                            }
                        }
                        continue;
                    }
                    let volume: ISimpleAudioVolume = match entry.control.cast() {
                        Ok(volume) => volume,
                        Err(_) => {
                            skipped += 1;
                            continue;
                        }
                    };
                    // Leave operator-muted sessions untouched (they are already isolated).
                    if unsafe { volume.GetMute() }.map(|b| b.as_bool()).unwrap_or(false) {
                        continue;
                    }
                    // NOTE: SetMute's bool param maps directly on current windows-rs;
                    // on versions where it is BOOL, use `true.into()`.
                    if unsafe { volume.SetMute(true, std::ptr::null()) }.is_ok() {
                        muted += 1;
                        newly_muted.push(entry.pid);
                    } else {
                        skipped += 1;
                    }
                }
            }
            Err(_) => {
                skipped += 1;
            }
        }

        if let Ok(mut set) = muted_pids.lock() {
            set.extend(newly_muted.iter().copied());
        }
        (muted, skipped, newly_muted)
    }

    pub(super) fn restore_isolation_win(
        muted_pids: &Mutex<HashSet<u32>>,
    ) -> (u32, u32, Option<String>) {
        let pids: Vec<u32> = muted_pids
            .lock()
            .map(|mut set| set.drain().collect())
            .unwrap_or_default();
        if pids.is_empty() {
            return (0, 0, None);
        }

        let mut restored = 0u32;
        let mut failed = 0u32;
        if let Ok(entries) = enumerate_sessions() {
            for entry in entries {
                if !pids.contains(&entry.pid) {
                    continue;
                }
                let volume: ISimpleAudioVolume = match entry.control.cast() {
                    Ok(volume) => volume,
                    Err(_) => {
                        failed += 1;
                        continue;
                    }
                };
                if unsafe { volume.SetMute(false, std::ptr::null()) }.is_ok() {
                    restored += 1;
                } else {
                    failed += 1;
                }
            }
        } else {
            failed = pids.len() as u32;
        }

        let message = if failed > 0 {
            Some(format!(
                "{} session(s) could not be unmuted automatically — check the Windows volume mixer.",
                failed
            ))
        } else {
            None
        };
        (restored, failed, message)
    }
}

#[cfg(windows)]
use windows_impl as sys;

/// Enumerates the current Windows audio sessions of the default render device
/// (excluding the console's own process).
pub fn list_sessions() -> Vec<DesktopAudioSession> {
    #[cfg(windows)]
    {
        sys::list_sessions_win()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

fn isolate_now(manager: &IsolationManager) -> DesktopSourceIsolationStatus {
    #[cfg(windows)]
    {
        let (muted, skipped, _) = sys::isolate_now_win(&manager.muted_pids);
        let message = if skipped > 0 {
            Some(format!(
                "{} Windows audio session(s) could not be safely isolated.",
                skipped
            ))
        } else {
            None
        };
        DesktopSourceIsolationStatus {
            enabled: skipped == 0,
            muted_sessions: muted,
            skipped_sessions: skipped,
            message,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = manager;
        DesktopSourceIsolationStatus {
            enabled: false,
            muted_sessions: 0,
            skipped_sessions: 1,
            message: Some("Source isolation requires Windows.".to_string()),
        }
    }
}

fn restore_isolation(manager: &IsolationManager) -> (u32, u32, Option<String>) {
    #[cfg(windows)]
    {
        sys::ensure_self_sessions_unmuted_win();
        sys::restore_isolation_win(&manager.muted_pids)
    }
    #[cfg(not(windows))]
    {
        let _ = manager;
        (0, 0, Some("Source isolation requires Windows.".to_string()))
    }
}

pub fn ensure_self_sessions_unmuted() {
    #[cfg(windows)]
    {
        sys::ensure_self_sessions_unmuted_win();
    }
}
