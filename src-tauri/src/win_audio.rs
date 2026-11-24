//! WASAPI desktop audio engine for the HKM console.
//!
//! Implements the native audio contract expected by the web console
//! (`src/hkm/utils/nativeDesktopAudio.ts` + worklets):
//!
//! - **Capture**: Windows *process loopback* (Win10 2004+ / Win11). The global
//!   `native-desktop-audio` stream captures every app EXCEPT the console itself
//!   (process-exclusion — zero feedback loop, no virtual cable needed). Per-app
//!   streams (`native-app-audio:<pid>`) capture exactly one process.
//!   Audio is normalized to the console wire format — 48 kHz interleaved Float32
//!   stereo — and streamed to the frontend over a Tauri IPC `Channel` as raw bytes.
//!
//! - **Raw output**: post-DSP console output rendered through a dedicated shared-mode
//!   WASAPI stream (AUTOCONVERTPCM) fed with 10 ms / 480-frame f32 blocks pushed from
//!   the web AudioWorklet tap (`raw-output-tap-worklet.js`).
//!
//! The process-loopback activation path (`ActivateAudioInterfaceAsync` with a
//! `VT_BLOB PROPVARIANT` of `AudioClientActivationParams`) deliberately uses raw
//! COM (manual vtables + runtime `GetProcAddress` loading) so the exotic parts do
//! not depend on windows-rs codegen; everything else uses windows-rs.
//!
//! NOTE for maintainers: windows-rs occasionally moves WAVEFORMATEX-family types
//! between `Win32::Media::Audio` and `Win32::Media::Multimedia` across versions.
//! If a `use` path fails to resolve on your windows crate version, adjust the
//! imports at the top of `windows_impl` — nothing else needs to change.

#![allow(clippy::missing_safety_doc)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};
use std::thread::{self, JoinHandle};

use tauri::ipc::{Channel, Response};

pub const TARGET_SAMPLE_RATE: f64 = 48_000.0;

// ---------------------------------------------------------------------------
// Public registry: named capture streams
// ---------------------------------------------------------------------------

struct CaptureHandle {
    stop: std::sync::Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct CaptureRegistry {
    streams: Mutex<HashMap<String, CaptureHandle>>,
}

impl CaptureRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(
        &self,
        stream_key: &str,
        target_pid: Option<u32>,
        channel: Channel<Response>,
    ) -> Result<(), String> {
        let mut streams = self.streams.lock().map_err(|e| e.to_string())?;
        if let Some(mut existing) = streams.remove(stream_key) {
            existing.stop.store(true, Ordering::Relaxed);
            if let Some(join) = existing.join.take() {
                let _ = join.join();
            }
        }

        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let key_owned = stream_key.to_string();
        let join = thread::Builder::new()
            .name(format!("hkm-capture-{}", stream_key))
            .spawn(move || {
                if let Err(err) = capture_pump(&key_owned, target_pid, &thread_stop, channel) {
                    eprintln!("[hkm-audio] capture stream '{}' failed: {}", key_owned, err);
                }
            })
            .map_err(|e| format!("Failed to spawn capture thread: {}", e))?;

        streams.insert(
            stream_key.to_string(),
            CaptureHandle {
                stop,
                join: Some(join),
            },
        );
        Ok(())
    }

    pub fn stop(&self, stream_key: &str) {
        if let Ok(mut streams) = self.streams.lock() {
            if let Some(mut handle) = streams.remove(stream_key) {
                handle.stop.store(true, Ordering::Relaxed);
                if let Some(join) = handle.join.take() {
                    let _ = join.join();
                }
            }
        }
    }

    pub fn stop_all(&self) {
        if let Ok(mut streams) = self.streams.lock() {
            for (_, mut handle) in streams.drain() {
                handle.stop.store(true, Ordering::Relaxed);
                if let Some(join) = handle.join.take() {
                    let _ = join.join();
                }
            }
        }
    }

    pub fn active_keys(&self) -> Vec<String> {
        self.streams
            .lock()
            .map(|streams| streams.keys().cloned().collect())
            .unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Raw output engine (post-DSP render tap)
// ---------------------------------------------------------------------------

struct RawOutputWorker {
    stop: std::sync::Arc<AtomicBool>,
    queue: mpsc::SyncSender<Vec<u8>>,
    join: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct RawOutputEngine {
    worker: Mutex<Option<RawOutputWorker>>,
}

impl RawOutputEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self) -> Result<(), String> {
        let mut guard = self.worker.lock().map_err(|e| e.to_string())?;
        stop_worker(&mut guard);
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(256);
        let thread_stop = stop.clone();
        let join = thread::Builder::new()
            .name("hkm-raw-output".to_string())
            .spawn(move || {
                if let Err(err) = raw_output_pump(&thread_stop, rx) {
                    eprintln!("[hkm-audio] raw output stream failed: {}", err);
                }
            })
            .map_err(|e| format!("Failed to spawn raw output thread: {}", e))?;
        *guard = Some(RawOutputWorker {
            stop,
            queue: tx,
            join: Some(join),
        });
        Ok(())
    }

    pub fn push(&self, bytes: Vec<u8>) -> Result<(), String> {
        let guard = self.worker.lock().map_err(|e| e.to_string())?;
        if let Some(worker) = guard.as_ref() {
            // Drop-on-full mirrors the frontend's "ignore transient drop" contract.
            let _ = worker.queue.try_send(bytes);
        }
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.worker.lock() {
            stop_worker(&mut guard);
        }
    }
}

fn stop_worker(worker: &mut Option<RawOutputWorker>) {
    if let Some(mut w) = worker.take() {
        w.stop.store(true, Ordering::Relaxed);
        // Dropping the sender unblocks the pump's try_recv loop on shutdown.
        drop(w.queue);
        if let Some(join) = w.join.take() {
            let _ = join.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Wire-format converter: any WAVEFORMATEX → 48 kHz interleaved f32 stereo
// ---------------------------------------------------------------------------

struct StreamConverter {
    is_float: bool,
    bits: u16,
    channels: u16,
    rate: f64,
    last_l: f32,
    last_r: f32,
}

impl StreamConverter {
    fn new() -> Self {
        Self {
            is_float: true,
            bits: 32,
            channels: 2,
            rate: TARGET_SAMPLE_RATE,
            last_l: 0.0,
            last_r: 0.0,
        }
    }

    fn configure(&mut self, info: &FormatInfo) {
        self.is_float = info.is_float;
        self.bits = info.bits;
        self.channels = info.channels.max(1);
        self.rate = info.rate as f64;
        self.last_l = 0.0;
        self.last_r = 0.0;
    }

    /// Decodes one capture packet into interleaved stereo f32 at the source rate,
    /// then linearly resamples to 48 kHz (with cross-packet continuity).
    fn convert(&mut self, data: &[u8], frames: u32) -> Vec<u8> {
        if frames == 0 || self.channels == 0 {
            return Vec::new();
        }
        let mut stereo: Vec<f32> = Vec::with_capacity(frames as usize * 2);
        let bytes_per_sample = (self.bits / 8).max(1) as usize;

        for frame in 0..frames as usize {
            let base = frame * self.channels as usize * bytes_per_sample;
            if base + bytes_per_sample > data.len() {
                break;
            }
            let l = self.decode_sample(&data[base..]);
            let r = if self.channels >= 2 {
                let rb = base + bytes_per_sample;
                if rb + bytes_per_sample <= data.len() {
                    self.decode_sample(&data[rb..])
                } else {
                    l
                }
            } else {
                l
            };
            stereo.push(l);
            stereo.push(r);
        }

        let out: Vec<f32> = if (self.rate - TARGET_SAMPLE_RATE).abs() < 0.5 {
            stereo.clone()
        } else {
            // Linear resample with continuity against the previous packet's tail.
            let src_frames = stereo.len() / 2;
            let step = self.rate / TARGET_SAMPLE_RATE;
            let mut resampled: Vec<f32> = Vec::with_capacity((src_frames as f64 / step) as usize * 2 + 2);
            let mut i = 0.0f64;
            while i < src_frames as f64 {
                let idx = i.floor() as usize;
                let frac = (i - idx as f64) as f32;
                let (l0, r0) = if idx == 0 {
                    (self.last_l, self.last_r)
                } else {
                    (stereo[(idx - 1) * 2], stereo[(idx - 1) * 2 + 1])
                };
                let (l1, r1) = if idx < src_frames {
                    (stereo[idx * 2], stereo[idx * 2 + 1])
                } else {
                    (l0, r0)
                };
                resampled.push(l0 + (l1 - l0) * frac);
                resampled.push(r0 + (r1 - r0) * frac);
                i += step;
            }
            resampled
        };

        if stereo.len() >= 2 {
            self.last_l = stereo[stereo.len() - 2];
            self.last_r = stereo[stereo.len() - 1];
        }

        let mut bytes = Vec::with_capacity(out.len() * 4);
        for sample in &out {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    fn decode_sample(&self, raw: &[u8]) -> f32 {
        match (self.is_float, self.bits) {
            (true, 32) => {
                if raw.len() >= 4 {
                    f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]])
                } else {
                    0.0
                }
            }
            (false, 16) => {
                if raw.len() >= 2 {
                    i16::from_le_bytes([raw[0], raw[1]]) as f32 / 32_768.0
                } else {
                    0.0
                }
            }
            (false, 24) => {
                if raw.len() >= 3 {
                    let v = (raw[0] as i32) | ((raw[1] as i32) << 8) | ((raw[2] as i32) << 16);
                    let sign_extended = if v & 0x80_0000 != 0 { v | !0xFF_FFFF } else { v };
                    sign_extended as f32 / 8_388_608.0
                } else {
                    0.0
                }
            }
            (false, 32) => {
                if raw.len() >= 4 {
                    i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as f32 / 2_147_483_648.0
                } else {
                    0.0
                }
            }
            _ => 0.0,
        }
    }

    fn silence(&self, frames: u32) -> Vec<u8> {
        vec![0u8; frames as usize * 2 * 4]
    }
}

#[derive(Clone, Copy)]
struct FormatInfo {
    rate: u32,
    channels: u16,
    bits: u16,
    is_float: bool,
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod windows_impl {
    use super::*;

    use windows::core::{GUID, PCSTR, PCWSTR};
    use windows::Win32::Media::Audio::{
        AUDCLNT_BUFFERFLAGS, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, CLSID_MMDeviceEnumerator,
        IAudioCaptureClient, IAudioClient, IAudioRenderClient, IMMDevice, IMMDeviceEnumerator, eConsole, eRender,
    };
    use windows::Win32::Media::Multimedia::{
        WAVE_FORMAT_EXTENSIBLE, WAVE_FORMAT_IEEE_FLOAT, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    };
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows::Win32::System::Threading::GetCurrentProcessId;

    // ----------------------------- GUIDs / constants ------------------------

    const IID_IUNKNOWN: GUID = GUID::from_u128(0x0000_0000_0000_0000_C000_0000_0000_0046);
    const IID_IAUDIO_CLIENT: GUID = GUID::from_u128(0x1CB9_AD4C_DBFA_4C32_B178_C2F5_68A7_033B);
    const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_u128(0x0000_0003_0000_0010_8000_00AA_0038_9B71);
    const SUBTYPE_PCM: GUID = GUID::from_u128(0x0000_0001_0000_0010_8000_00AA_0038_9B71);

    const E_NOINTERFACE: i32 = 0x8000_4002u32 as i32;
    const S_OK: i32 = 0;
    /// RPC_E_CHANGED_MODE — the thread already joined an apartment; calls still work.
    const RPC_E_CHANGED_MODE: i32 = 0x8001_0106u32 as i32;

    /// `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
    const ACTIVATION_TYPE_PROCESS_LOOPBACK: u32 = 1;
    const LOOPBACK_INCLUDE_TARGET: u32 = 0;
    const LOOPBACK_EXCLUDE_TARGET: u32 = 1;
    /// `VT_BLOB` VARENUM.
    const VT_BLOB: u16 = 65;

    pub(super) type HResult = i32;

    // ------------------- Process loopback activation (raw COM) --------------

    /// Mirror of `AudioClientActivationParams` — only the process-loopback branch
    /// of the union is relevant, so it is flattened (12 bytes, repr(C) as declared).
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AudioClientActivationParamsRaw {
        activation_type: u32,
        target_process_id: u32,
        process_loopback_mode: u32,
    }

    /// Mirror of `PROPVARIANT` carrying a VT_BLOB payload (24 bytes, same layout).
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct BlobPropVariantRaw {
        vt: u16,
        pad: [u16; 3],
        cb_size: u32,
        pad2: u32,
        data: *const u8,
    }

    #[repr(C)]
    struct CompletionVtable {
        query_interface:
            unsafe extern "system" fn(*mut std::ffi::c_void, *const GUID, *mut *mut std::ffi::c_void) -> HResult,
        add_ref: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
        release: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
        activate_completed:
            unsafe extern "system" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> HResult,
    }

    struct CompletionHandler {
        vtable: *const CompletionVtable,
        refs: std::sync::atomic::AtomicU32,
        done: Mutex<Option<(HResult, *mut std::ffi::c_void)>>,
        notify: Option<mpsc::Sender<()>>,
    }

    static COMPLETION_VTABLE: CompletionVtable = CompletionVtable {
        query_interface: handler_query_interface,
        add_ref: handler_add_ref,
        release: handler_release,
        activate_completed: handler_activate_completed,
    };

    unsafe extern "system" fn handler_query_interface(
        this: *mut std::ffi::c_void,
        riid: *const GUID,
        out: *mut *mut std::ffi::c_void,
    ) -> HResult {
        let inner = &*(this as *const CompletionHandler);
        if *riid == IID_IUNKNOWN {
            *out = this;
            inner.refs.fetch_add(1, Ordering::Relaxed);
            S_OK
        } else {
            *out = std::ptr::null_mut();
            E_NOINTERFACE
        }
    }

    unsafe extern "system" fn handler_add_ref(this: *mut std::ffi::c_void) -> u32 {
        let inner = &*(this as *const CompletionHandler);
        inner.refs.fetch_add(1, Ordering::Relaxed) + 1
    }

    unsafe extern "system" fn handler_release(_this: *mut std::ffi::c_void) -> u32 {
        // The handler is owned (boxed) by the activating thread; never freed here.
        1
    }

    #[repr(C)]
    struct AsyncOpVtable {
        _query_interface:
            unsafe extern "system" fn(*mut std::ffi::c_void, *const GUID, *mut *mut std::ffi::c_void) -> HResult,
        _add_ref: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
        release: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
        get_activate_result:
            unsafe extern "system" fn(*mut std::ffi::c_void, *mut HResult, *mut *mut std::ffi::c_void) -> HResult,
    }

    unsafe extern "system" fn handler_activate_completed(
        this: *mut std::ffi::c_void,
        operation: *mut std::ffi::c_void,
    ) -> HResult {
        let inner = &*(this as *const CompletionHandler);
        let mut hr: HResult = 0;
        let mut unknown: *mut std::ffi::c_void = std::ptr::null_mut();
        if !operation.is_null() {
            let op_vtable = &*(*(operation as *const *const AsyncOpVtable));
            (op_vtable.get_activate_result)(operation, &mut hr, &mut unknown);
            (op_vtable.release)(operation);
        }
        if let Ok(mut done) = inner.done.lock() {
            *done = Some((hr, unknown));
        }
        if let Some(tx) = inner.notify.as_ref() {
            let _ = tx.send(());
        }
        S_OK
    }

    type ActivateAudioInterfaceAsyncFn = unsafe extern "system" fn(
        *const u16,
        *const GUID,
        *const std::ffi::c_void,
        *mut std::ffi::c_void,
        *mut *mut std::ffi::c_void,
    ) -> HResult;

    /// `ActivateAudioInterfaceAsync` is not exposed through an import library, so it
    /// is resolved from mmdevapi.dll at runtime via GetProcAddress.
    fn load_activate_audio_interface_async() -> Option<ActivateAudioInterfaceAsyncFn> {
        static FN_ADDR: OnceLock<usize> = OnceLock::new();
        let addr = *FN_ADDR.get_or_init(|| unsafe {
            let wide: Vec<u16> = "mmdevapi.dll\0".encode_utf16().collect();
            let module = match LoadLibraryW(PCWSTR(wide.as_ptr())) {
                Ok(module) => module,
                Err(_) => return 0,
            };
            GetProcAddress(module, PCSTR(b"ActivateAudioInterfaceAsync\0".as_ptr()))
                .map(|f| f as usize)
                .unwrap_or(0)
        });
        if addr == 0 {
            None
        } else {
            // SAFETY: the address is the documented ActivateAudioInterfaceAsync export.
            Some(unsafe { std::mem::transmute::<usize, ActivateAudioInterfaceAsyncFn>(addr) })
        }
    }

    /// Activates a process-loopback IAudioClient:
    /// - `Some(pid)` → capture ONLY that process (per-app stream).
    /// - `None` → capture every process EXCEPT this one (global desktop audio,
    ///   process-exclusion = zero self-feedback, no virtual cable required).
    pub(super) fn activate_process_loopback_client(
        target_pid: Option<u32>,
    ) -> Result<IAudioClient, String> {
        let activate = load_activate_audio_interface_async().ok_or_else(|| {
            "This Windows build does not export ActivateAudioInterfaceAsync (requires Windows 10 \
             version 2004 or newer). Desktop-audio loopback is unavailable; physical \
             microphone and USB interface channels are unaffected."
                .to_string()
        })?;

        let self_pid = unsafe { GetCurrentProcessId() };
        let (pid, mode) = match target_pid {
            Some(pid) => (pid, LOOPBACK_INCLUDE_TARGET),
            None => (self_pid, LOOPBACK_EXCLUDE_TARGET),
        };

        let params = AudioClientActivationParamsRaw {
            activation_type: ACTIVATION_TYPE_PROCESS_LOOPBACK,
            target_process_id: pid,
            process_loopback_mode: mode,
        };
        let variant = BlobPropVariantRaw {
            vt: VT_BLOB,
            pad: [0; 3],
            cb_size: std::mem::size_of::<AudioClientActivationParamsRaw>() as u32,
            pad2: 0,
            data: &params as *const _ as *const u8,
        };

        let (tx, rx) = mpsc::channel::<()>();
        let handler = Box::new(CompletionHandler {
            vtable: &COMPLETION_VTABLE,
            refs: std::sync::atomic::AtomicU32::new(1),
            done: Mutex::new(None),
            notify: Some(tx),
        });
        let handler_ptr: *mut CompletionHandler = Box::into_raw(handler);

        // SAFETY: raw COM activation. A null device path is used for process loopback
        // (the "device" is defined entirely by the activation parameters).
        let mut operation: *mut std::ffi::c_void = std::ptr::null_mut();
        let hr = unsafe {
            activate(
                std::ptr::null(),
                &IID_IAUDIO_CLIENT,
                &variant as *const BlobPropVariantRaw as *const std::ffi::c_void,
                handler_ptr as *mut std::ffi::c_void,
                &mut operation,
            )
        };

        let result = if hr < 0 {
            Err(format!(
                "ActivateAudioInterfaceAsync failed (0x{:08X}). Process loopback may be blocked \
                 on this system (Windows 10 2004+ / Windows 11 required).",
                hr as u32
            ))
        } else {
            match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(()) => {
                    let done = unsafe { &*handler_ptr }
                        .done
                        .lock()
                        .ok()
                        .and_then(|mut guard| guard.take())
                        .unwrap_or((-1, std::ptr::null_mut()));
                    if done.0 < 0 {
                        Err(format!(
                            "Process loopback activation failed (0x{:08X}).",
                            done.0 as u32
                        ))
                    } else if done.1.is_null() {
                        Err("Process loopback activation returned no audio client.".to_string())
                    } else {
                        // SAFETY: GetActivateResult returned an owned interface pointer for
                        // IID_IAudioClient; windows-rs interface wrappers are a single pointer
                        // wide, so this transmute adopts the COM reference (Drop = Release).
                        Ok(unsafe { std::mem::transmute::<*mut std::ffi::c_void, IAudioClient>(done.1) })
                    }
                }
                Err(_) => {
                    // Only release the pending operation if the callback truly never ran.
                    let callback_pending = unsafe { &*handler_ptr }
                        .done
                        .lock()
                        .map(|guard| guard.is_none())
                        .unwrap_or(true);
                    if callback_pending && !operation.is_null() {
                        let op_vtable = unsafe { &*(*(operation as *const *const AsyncOpVtable)) };
                        unsafe { (op_vtable.release)(operation) };
                    }
                    Err("Process loopback activation timed out.".to_string())
                }
            }
        };

        // Intentionally LEAK the ~100-byte completion handler: the COM runtime may
        // still hold a lingering reference after completion, so its memory must
        // outlive the process (captures are rare — a few per app session).
        std::mem::forget(unsafe { Box::from_raw(handler_ptr) });
        result
    }

    // ----------------------------- Shared helpers ---------------------------

    pub(super) fn init_com_mta() -> Result<(), String> {
        // RPC_E_CHANGED_MODE means this thread already joined an apartment — the
        // subsequent COM calls still work, so treat it as success.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let code: i32 = hr.0;
        if code == 0 || code == RPC_E_CHANGED_MODE {
            Ok(())
        } else {
            Err(format!("CoInitializeEx failed (0x{:08X}).", code as u32))
        }
    }

    pub(super) fn get_default_render_device() -> Result<IMMDevice, String> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&CLSID_MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|e| format!("MMDevice enumerator unavailable: {}", e))?;
        unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|e| format!("No default render endpoint available: {}", e))
    }

    pub(super) fn get_render_device_by_id(endpoint_id: &str) -> Result<IMMDevice, String> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&CLSID_MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|e| format!("MMDevice enumerator unavailable: {}", e))?;
        let wide: Vec<u16> = endpoint_id.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }
            .map_err(|e| format!("Render endpoint '{}' not found: {}", endpoint_id, e))
    }

    pub(super) fn parse_wave_format(wfx: &WAVEFORMATEX) -> FormatInfo {
        let mut is_float = wfx.wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
        if wfx.wFormatTag == WAVE_FORMAT_EXTENSIBLE && wfx.cbSize >= 22 {
            // SAFETY: extensible formats guarantee cbSize >= 22.
            let ext = unsafe { &*(wfx as *const WAVEFORMATEX as *const WAVEFORMATEXTENSIBLE) };
            if ext.SubFormat == SUBTYPE_IEEE_FLOAT {
                is_float = true;
            } else if ext.SubFormat == SUBTYPE_PCM {
                is_float = false;
            }
        }
        FormatInfo {
            rate: wfx.nSamplesPerSec,
            channels: wfx.nChannels,
            bits: wfx.wBitsPerSample,
            is_float,
        }
    }

    pub(super) fn free_wave_format(wfx: *mut WAVEFORMATEX) {
        if !wfx.is_null() {
            unsafe { CoTaskMemFree(Some(wfx as *const std::ffi::c_void)) };
        }
    }

    /// 48 kHz interleaved Float32 stereo request format for the raw output stream.
    pub(super) fn target_wave_format() -> WAVEFORMATEX {
        WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
            nChannels: 2,
            nSamplesPerSec: 48_000,
            wBitsPerSample: 32,
            nBlockAlign: 8,
            nAvgBytesPerSec: 48_000 * 8,
            cbSize: 0,
        }
    }

    pub(super) fn zero_stream_flags() -> AUDCLNT_STREAMFLAGS {
        AUDCLNT_STREAMFLAGS(0)
    }

    pub(super) fn zero_buffer_flags() -> AUDCLNT_BUFFERFLAGS {
        AUDCLNT_BUFFERFLAGS(0)
    }
    pub(super) fn render_stream_flags() -> AUDCLNT_STREAMFLAGS {
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
    }

    pub(super) use AUDCLNT_SHAREMODE_SHARED as ShareMode;
    pub(super) use AUDCLNT_BUFFERFLAGS_SILENT as FlagSilent;
    pub(super) use windows::Win32::System::Com::CLSCTX_ALL;
    pub(super) type CaptureClientT = IAudioCaptureClient;
    pub(super) type RenderClientT = IAudioRenderClient;
    pub(super) type AudioClientT = IAudioClient;
    pub(super) type WaveFormatT = WAVEFORMATEX;
}

#[cfg(windows)]
use windows_impl as sys;

// ---------------------------------------------------------------------------
// Cross-module helpers (used by win_sessions / apo)
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub fn com_init_for_caller() -> Result<(), String> {
    sys::init_com_mta()
}

#[cfg(windows)]
pub fn default_render_device() -> Result<windows::Win32::Media::Audio::IMMDevice, String> {
    sys::get_default_render_device()
}

#[cfg(windows)]
pub fn render_device_by_id(endpoint_id: &str) -> Result<windows::Win32::Media::Audio::IMMDevice, String> {
    sys::get_render_device_by_id(endpoint_id)
}

#[cfg(windows)]
pub fn clsctx_all() -> windows::Win32::System::Com::CLSCTX {
    sys::CLSCTX_ALL
}

/// The default render endpoint's MMDevice ID string (matches the registry key
/// name under HKLM\...\MMDevices\Audio\Render — used by the APO status list).
#[cfg(windows)]
pub fn default_render_endpoint_id() -> Result<String, String> {
    let device = sys::get_default_render_device()?;
    let id = unsafe { device.GetId() }.map_err(|e| format!("IMMDevice::GetId failed: {}", e))?;
    let wide = unsafe { id.as_wide() };
    let text = String::from_utf16_lossy(wide);
    unsafe {
        windows::Win32::System::Com::CoTaskMemFree(Some(id.as_ptr() as *const std::ffi::c_void))
    };
    Ok(text)
}

fn capture_pump(
    stream_key: &str,
    target_pid: Option<u32>,
    stop: &AtomicBool,
    channel: Channel<Response>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = stream_key;
        sys::init_com_mta()?;

        // Global desktop audio = process-EXCLUSION loopback (no self-feedback).
        // Per-app streams = process-INCLUSION loopback for the target PID.
        let audio_client = sys::activate_process_loopback_client(target_pid)?;

        // Use the loopback mix format, then convert to the 48 kHz f32 wire format.
        let mut mix_format: *mut sys::WaveFormatT = std::ptr::null_mut();
        unsafe { audio_client.GetMixFormat(&mut mix_format) }
            .map_err(|e| format!("GetMixFormat failed: {}", e))?;
        if mix_format.is_null() {
            return Err("GetMixFormat returned no format.".to_string());
        }
        let info = sys::parse_wave_format(unsafe { &*mix_format });

        // NOTE: process-loopback clients must Initialize with ZERO buffer duration and
        // must NOT set AUDCLNT_STREAMFLAGS_LOOPBACK (the activation params select loopback).
        let init = unsafe {
            audio_client.Initialize(
                sys::ShareMode,
                sys::zero_stream_flags(),
                0,
                0,
                mix_format,
                None,
            )
        };
        sys::free_wave_format(mix_format);
        init.map_err(|e| format!("IAudioClient Initialize failed: {}", e))?;

        let capture_client: sys::CaptureClientT = unsafe { audio_client.GetService() }
            .map_err(|e| format!("GetService(IAudioCaptureClient) failed: {}", e))?;

        let mut converter = StreamConverter::new();
        converter.configure(&info);

        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let mut next_frames: u32 = 0;
            if unsafe { capture_client.GetNextPacketSize(&mut next_frames) }.is_err() {
                break;
            }
            while next_frames > 0 {
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags = sys::zero_buffer_flags();
                let mut timestamp: u64 = 0;
                let mut qpc_position: u64 = 0;
                let got = unsafe {
                    capture_client.GetBuffer(
                        &mut data,
                        &mut frames,
                        &mut flags,
                        Some(&mut timestamp),
                        Some(&mut qpc_position),
                    )
                };
                if got.is_err() {
                    break;
                }

                let silent = (flags.0 & sys::FlagSilent.0) != 0;
                let bytes = if silent {
                    converter.silence(frames)
                } else if !data.is_null() {
                    let len =
                        frames as usize * info.channels as usize * (info.bits / 8).max(1) as usize;
                    // SAFETY: GetBuffer guarantees `frames` valid frames at `data`.
                    let slice = unsafe { std::slice::from_raw_parts(data, len) };
                    converter.convert(slice, frames)
                } else {
                    converter.silence(frames)
                };

                let _ = unsafe { capture_client.ReleaseBuffer() };

                if !bytes.is_empty() && channel.send(Response::new(bytes)).is_err() {
                    // Frontend dropped the channel — stop this stream cleanly.
                    return Ok(());
                }

                if unsafe { capture_client.GetNextPacketSize(&mut next_frames) }.is_err() {
                    break;
                }
            }

            thread::sleep(std::time::Duration::from_millis(8));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (stream_key, target_pid, channel, stop);
        Err("Desktop audio capture requires Windows.".to_string())
    }
}

// ---------------------------------------------------------------------------
// Raw output pump
// ---------------------------------------------------------------------------

fn raw_output_pump(stop: &AtomicBool, queue: mpsc::Receiver<Vec<u8>>) -> Result<(), String> {
    #[cfg(windows)]
    {
        sys::init_com_mta()?;

        let audio_client: sys::AudioClientT = {
            let device = sys::get_default_render_device()?;
            unsafe { device.Activate(sys::CLSCTX_ALL, None) }
                .map_err(|e| format!("IAudioClient activation failed: {}", e))?
        };

        let format = sys::target_wave_format();
        let buffer_duration_100ns: i64 = 2_000_000; // 200 ms
        unsafe {
            audio_client.Initialize(
                sys::ShareMode,
                sys::render_stream_flags(),
                buffer_duration_100ns,
                0,
                &format,
                None,
            )
        }
        .map_err(|e| format!("Raw output Initialize failed: {}", e))?;

        let render_client: sys::RenderClientT = unsafe { audio_client.GetService() }
            .map_err(|e| format!("GetService(IAudioRenderClient) failed: {}", e))?;

        let mut buffer_frames: u32 = 0;
        unsafe { audio_client.GetBufferSize(&mut buffer_frames) }
            .map_err(|e| format!("GetBufferSize failed: {}", e))?;

        // Pre-fill the whole buffer with silence so playback starts primed.
        if let Ok(ptr) = (unsafe { render_client.GetBuffer(buffer_frames) }) {
            if !ptr.is_null() {
                unsafe {
                    std::ptr::write_bytes(ptr, 0, buffer_frames as usize * 8);
                    let _ = render_client.ReleaseBuffer(buffer_frames, sys::zero_buffer_flags());
                }
            }
        }

        // Each pushed block is 480 frames (10 ms); fill whenever ≥ 20 ms is available.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            while let Ok(block) = queue.try_recv() {
                pending.extend_from_slice(&block);
                // Bound the backlog defensively (≈1 s of audio).
                if pending.len() > 48_000 * 8 {
                    pending.drain(..pending.len() - 48_000 * 8);
                }
            }

            let mut padding: u32 = 0;
            if unsafe { audio_client.GetCurrentPadding(&mut padding) }.is_err() {
                break;
            }
            let available = buffer_frames.saturating_sub(padding);
            if available >= 960 {
                if let Ok(ptr) = (unsafe { render_client.GetBuffer(available) }) {
                    if !ptr.is_null() {
                        let needed = available as usize * 8;
                        if pending.len() >= needed {
                            unsafe {
                                std::ptr::copy_nonoverlapping(pending.as_ptr(), ptr, needed);
                                let _ = render_client
                                    .ReleaseBuffer(available, sys::zero_buffer_flags());
                            }
                            pending.drain(..needed);
                        } else {
                            unsafe {
                                std::ptr::write_bytes(ptr, 0, needed);
                                let take = pending.len().min(needed);
                                if take > 0 {
                                    std::ptr::copy_nonoverlapping(pending.as_ptr(), ptr, take);
                                }
                                let _ = render_client
                                    .ReleaseBuffer(available, sys::zero_buffer_flags());
                            }
                            pending.clear();
                        }
                    }
                }
            }

            thread::sleep(std::time::Duration::from_millis(8));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (stop, queue);
        Err("Raw WASAPI output requires Windows.".to_string())
    }
}
