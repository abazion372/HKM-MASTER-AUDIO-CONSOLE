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
//
// v1.1: honours the console-selected render endpoint (falls back to the default
// device on hot-unplug) and supports N-channel WAVEFORMATEXTENSIBLE streams so
// a 5.1/7.1/pro card can be addressed per discrete jack pair (see
// docs/DISCRETE-JACK-ROUTING.md). The bundled web worklet pushes stereo or
// N-channel blocks matching the armed channel count.
//
// v2 (exclusive WASAPI per-jack path): `exclusive = true` opens the endpoint
// in AUDCLNT_SHAREMODE_EXCLUSIVE with an event-driven stream — bit-perfect
// per-jack delivery, no shared-mixer/APO interference, pro-grade latency.
// Endpoints without float support in exclusive mode fall back to 16-bit PCM
// (converted from the f32 worklet wire format).
// ---------------------------------------------------------------------------

struct RawOutputWorker {
    stop: std::sync::Arc<AtomicBool>,
    queue: mpsc::SyncSender<Vec<u8>>,
    join: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct RawOutputEngine {
    worker: Mutex<Option<RawOutputWorker>>,
    /// Live stream status surfaced through `desktop_audio_status`:
    /// None = off, `"shared …"` / `"exclusive …"` = running,
    /// `"…-error: …"` = last failure (set by the pump thread).
    status: std::sync::Arc<Mutex<Option<String>>>,
}

impl RawOutputEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(
        &self,
        endpoint_id: Option<String>,
        channels: u16,
        exclusive: bool,
    ) -> Result<(), String> {
        let mut guard = self.worker.lock().map_err(|e| e.to_string())?;
        stop_worker(&mut guard);
        if let Ok(mut s) = self.status.lock() {
            *s = None;
        }
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(256);
        let thread_stop = stop.clone();
        let status_handle = self.status.clone();
        let mode = if exclusive { "exclusive" } else { "shared" };
        let join = thread::Builder::new()
            .name("hkm-raw-output".to_string())
            .spawn(move || {
                if let Err(err) =
                    raw_output_pump(&thread_stop, rx, endpoint_id, channels, exclusive, status_handle.clone())
                {
                    eprintln!("[hkm-audio] raw output stream failed: {}", err);
                    if let Ok(mut s) = status_handle.lock() {
                        *s = Some(format!("{}-error: {}", mode, err));
                    }
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
        if let Ok(mut s) = self.status.lock() {
            *s = None;
        }
    }

    /// Current raw-output stream status (mode, channel/bit format, or error).
    pub fn current_status(&self) -> Option<String> {
        self.status.lock().ok().and_then(|s| s.clone())
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

    use windows::core::{GUID, Interface, PCSTR, PCWSTR};
    use windows::Win32::Foundation::{BOOL, CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE, AUDCLNT_SHAREMODE_EXCLUSIVE,
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        DEVICE_STATE_ACTIVE, IAudioCaptureClient, IAudioClient, IAudioRenderClient, IConnector,
        IDeviceTopology, IKsJackDescription, IMMDevice, IMMDeviceCollection,
        IMMDeviceEnumerator, IPart, KSJACK_DESCRIPTION, MMDeviceEnumerator, WAVEFORMATEX,
        WAVEFORMATEXTENSIBLE, eConsole, eRender,
    };
    use windows::Win32::Media::Multimedia::{WAVE_FORMAT_IEEE_FLOAT, WAVE_FORMAT_PCM};
    use windows::Win32::System::Com::{
        CLSCTX, CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    };
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, WaitForSingleObject};

    const WAVE_FORMAT_EXTENSIBLE: u32 = 0xFFFE;

    // ----------------------------- GUIDs / constants ------------------------

    const IID_IUNKNOWN: GUID = GUID::from_u128(0x0000_0000_0000_0000_C000_0000_0000_0046);
    const IID_IAUDIO_CLIENT: GUID = GUID::from_u128(0x1CB9_AD4C_DBFA_4C32_B178_C2F5_68A7_033B);
    const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_u128(0x0000_0003_0000_0010_8000_00AA_0038_9B71);
    const SUBTYPE_PCM: GUID = GUID::from_u128(0x0000_0001_0000_0010_8000_00AA_0038_9B71);

    const E_NOINTERFACE: i32 = 0x8000_4002u32 as i32;
    const S_OK: i32 = 0;
    /// RPC_E_CHANGED_MODE — the thread already joined an apartment; calls still work.
    const RPC_E_CHANGED_MODE: i32 = 0x8001_0106u32 as i32;

    /// AUDCLNT_E_UNSUPPORTED_FORMAT — the endpoint refuses this format in the
    /// requested mode (exclusive negotiation falls back to 16-bit PCM).
    pub(super) const AUDCLNT_E_UNSUPPORTED_FORMAT: u32 = 0x8889_0008;
    /// AUDCLNT_E_DEVICE_IN_USE — another application holds the endpoint
    /// exclusively (classic DAW / pro player conflict).
    pub(super) const AUDCLNT_E_DEVICE_IN_USE: u32 = 0x8889_000A;
    /// AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED — exclusive-mode streams must have a
    /// buffer that is an integral number of periods; re-init with the aligned size.
    pub(super) const AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED: u32 = 0x8889_0019;

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

    #[repr(C)]
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
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|e| format!("MMDevice enumerator unavailable: {}", e))?;
        unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|e| format!("No default render endpoint available: {}", e))
    }

    #[allow(dead_code)]
    pub(super) fn get_render_device_by_id(endpoint_id: &str) -> Result<IMMDevice, String> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|e| format!("MMDevice enumerator unavailable: {}", e))?;
        let wide: Vec<u16> = endpoint_id.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }
            .map_err(|e| format!("Render endpoint '{}' not found: {}", endpoint_id, e))
    }

    /// Activate an [`IAudioClient`] on the console-selected render endpoint,
    /// falling back to the default device on hot-unplug so the show keeps
    /// running (shared by the shared-mode and exclusive-mode output pumps).
    pub(super) fn activate_render_client(
        endpoint_id: Option<&str>,
    ) -> Result<IAudioClient, String> {
        let device = match endpoint_id {
            Some(id) if !id.is_empty() => get_render_device_by_id(id).or_else(|err| {
                eprintln!(
                    "[hkm-audio] selected render endpoint '{}' unavailable ({}); falling back to the default device.",
                    id, err
                );
                get_default_render_device()
            }),
            _ => get_default_render_device(),
        }?;
        unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|e| format!("IAudioClient activation failed: {}", e))
    }

    pub(super) fn parse_wave_format(wfx: &WAVEFORMATEX) -> FormatInfo {
        let format_tag = wfx.wFormatTag as u32;
        let cb_size = wfx.cbSize;
        let mut is_float = format_tag == WAVE_FORMAT_IEEE_FLOAT;
        if format_tag == WAVE_FORMAT_EXTENSIBLE && cb_size >= 22 {
            // SAFETY: extensible formats guarantee cbSize >= 22.
            let ext = unsafe { &*(wfx as *const WAVEFORMATEX as *const WAVEFORMATEXTENSIBLE) };
            let sub_format = ext.SubFormat;
            if sub_format == SUBTYPE_IEEE_FLOAT {
                is_float = true;
            } else if sub_format == SUBTYPE_PCM {
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
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
            nChannels: 2,
            nSamplesPerSec: 48_000,
            wBitsPerSample: 32,
            nBlockAlign: 8,
            nAvgBytesPerSec: 48_000 * 8,
            cbSize: 0,
        }
    }

    /// N-channel variant of [`target_wave_format`]: >2 channels request a
    /// WAVEFORMATEXTENSIBLE stream with the standard speaker channel mask so a
    /// 5.1/7.1/pro card is addressed jack-pair by jack-pair (1:1 channel
    /// mapping, no OS down-mix — see docs/DISCRETE-JACK-ROUTING.md).
    pub(super) fn target_wave_format_channels(channels: u16) -> WAVEFORMATEXTENSIBLE {
        let block_align = channels.saturating_mul(4);
        WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
                nChannels: channels,
                nSamplesPerSec: 48_000,
                wBitsPerSample: 32,
                nBlockAlign: block_align,
                nAvgBytesPerSec: 48_000 * block_align as u32,
                cbSize: 22,
            },
            wValidBitsPerSample: 32,
            dwChannelMask: channel_mask_for(channels),
            SubFormat: SUBTYPE_IEEE_FLOAT,
        }
    }

    /// Standard WAVEFORMATEXTENSIBLE speaker masks (0 = driver default layout).
    pub(super) fn channel_mask_for(channels: u16) -> u32 {
        match channels {
            4 => 0x0000_0033, // quad: FL|FR|BL|BR
            6 => 0x0000_003F, // 5.1: FL|FR|FC|LFE|BL|BR
            8 => 0x0000_063F, // 7.1: 5.1 + SL|SR
            _ => 0,
        }
    }

    /// 48 kHz interleaved 16-bit PCM stereo request format — the integer
    /// fallback for endpoints whose exclusive mode exposes no float support
    /// (typical onboard HDA codecs).
    pub(super) fn target_wave_format_pcm16() -> WAVEFORMATEX {
        WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: 2,
            nSamplesPerSec: 48_000,
            wBitsPerSample: 16,
            nBlockAlign: 4,
            nAvgBytesPerSec: 48_000 * 4,
            cbSize: 0,
        }
    }

    /// N-channel 16-bit PCM variant of [`target_wave_format_pcm16`] for the
    /// exclusive-mode integer fallback on 5.1/7.1/pro cards.
    pub(super) fn target_wave_format_channels_pcm16(channels: u16) -> WAVEFORMATEXTENSIBLE {
        let block_align = channels.saturating_mul(2);
        WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
                nChannels: channels,
                nSamplesPerSec: 48_000,
                wBitsPerSample: 16,
                nBlockAlign: block_align,
                nAvgBytesPerSec: 48_000 * block_align as u32,
                cbSize: 22,
            },
            wValidBitsPerSample: 16,
            dwChannelMask: channel_mask_for(channels),
            SubFormat: SUBTYPE_PCM,
        }
    }

    // ------------------------- Jack descriptions ----------------------------

    /// Friendly name of a render endpoint from the MMDevices registry key
    /// (PKEY_Device_FriendlyName) — mirrors the apo.rs reader and avoids an
    /// IPropertyStore dependency.
    fn render_endpoint_friendly_name(endpoint_id: &str) -> String {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
        use winreg::RegKey;
        let path = format!(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\{}\Properties",
            endpoint_id
        );
        RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(&path, KEY_READ)
            .ok()
            .and_then(|props| {
                props
                    .get_value::<String, _>(r"{a45c254e-df1c-4efd-8020-67d146a850e0},2")
                    .ok()
            })
            .unwrap_or_else(|| "Audio Endpoint".to_string())
    }

    /// First WAVEFORMATEXTENSIBLE channel position carried by the jack (lowest
    /// set SPEAKER_* bit); -1 when the driver reports no channel mapping.
    fn first_speaker_bit(mask: u32) -> i32 {
        if mask == 0 {
            -1
        } else {
            mask.trailing_zeros() as i32
        }
    }

    /// Human-readable EPcxConnectionType hint (devicetopology.h enum values).
    fn connector_type_name(code: i32) -> String {
        match code {
            0 => "unknown",
            1 => "analog-jack-3.5mm",
            2 => "integrated-device",
            3 => "integrated-and-jack",
            0x100 => "unknown-digital",
            0x101 => "hdmi",
            0x102 => "optical",
            0x103 => "digital-other",
            _ => "other",
        }
        .to_string()
    }

    /// Human-readable EGeoLocation hint (devicetopology.h enum values).
    fn geo_location_name(code: i32) -> String {
        match code {
            1 => "rear",
            2 => "front",
            3 => "left",
            4 => "right",
            5 => "top",
            6 => "bottom",
            7 => "rear-panel",
            8 => "rear-mobile",
            9 => "front-mobile",
            10 => "bottom-mobile",
            _ => "other",
        }
        .to_string()
    }

    /// Physical jack metadata for every active render endpoint, read through
    /// the Windows Device Topology API (IKsJackDescription). This is the OS
    /// truth behind the HDA colour-code silkscreen: real colour, connector
    /// type, chassis location, channel mapping and plug-presence state. The web
    /// layer merges these hints onto the probed discrete jack endpoints
    /// (`src/hkm/store/useHardwareManager.ts`).
    pub(super) fn list_jack_descriptions() -> Vec<crate::DesktopJackDescription> {
        let mut out = Vec::new();
        if init_com_mta().is_err() {
            return out;
        }

        let enumerator: IMMDeviceEnumerator =
            match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
                Ok(e) => e,
                Err(_) => return out,
            };
        let collection: IMMDeviceCollection =
            match unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) } {
                Ok(c) => c,
                Err(_) => return out,
            };

        let count = unsafe { collection.GetCount() }.unwrap_or(0);
        for i in 0..count {
            let device: IMMDevice = match unsafe { collection.Item(i) } {
                Ok(d) => d,
                Err(_) => continue,
            };

            // Owned MMDevice ID string — copy then CoTaskMemFree (same pattern
            // as default_render_endpoint_id above).
            let endpoint_id = match unsafe { device.GetId() } {
                Ok(pw) => {
                    let text = String::from_utf16_lossy(unsafe { pw.as_wide() });
                    unsafe { CoTaskMemFree(Some(pw.as_ptr() as *const std::ffi::c_void)) };
                    text
                }
                Err(_) => continue,
            };
            if endpoint_id.is_empty() {
                continue;
            }
            let friendly_name = render_endpoint_friendly_name(&endpoint_id);

            // Activate the device-topology view and walk its connectors: the
            // jack description lives on the internal-side (connected-to)
            // connector/part of each device-top pin.
            let topology: IDeviceTopology =
                match unsafe { device.Activate(CLSCTX_ALL, None) } {
                    Ok(t) => t,
                    Err(_) => continue,
                };

            let connector_count = unsafe { topology.GetConnectorCount() }.unwrap_or(0);
            for c in 0..connector_count {
                let connected = match unsafe { topology.GetConnector(c) }.and_then(|conn| unsafe { conn.GetConnectedTo() }) {
                    Ok(inner) => inner,
                    Err(_) => continue,
                };

                // Try the connected connector first, then its IPart facet —
                // both are plain QueryInterfaces and may expose jacks.
                let jacks: Option<IKsJackDescription> = connected
                    .cast::<IKsJackDescription>()
                    .ok()
                    .or_else(|| {
                        connected
                            .cast::<IPart>()
                            .ok()
                            .and_then(|part| part.cast::<IKsJackDescription>().ok())
                    });
                let jacks = match jacks {
                    Some(j) => j,
                    None => continue,
                };

                let jack_count = unsafe { jacks.GetJackCount() }.unwrap_or(0);
                for j in 0..jack_count {
                    // SAFETY: KSJACK_DESCRIPTION is a plain C struct of integer
                    // fields; zero-initialization is the documented empty state.
                    let mut desc: KSJACK_DESCRIPTION = unsafe { std::mem::zeroed() };
                    if unsafe { jacks.GetJackDescription(j, &mut desc) }.is_err() {
                        continue;
                    }
                    out.push(crate::DesktopJackDescription {
                        endpoint_id: endpoint_id.clone(),
                        friendly_name: friendly_name.clone(),
                        jack_index: j,
                        color_rgb: desc.Color & 0x00FF_FFFF,
                        channel: first_speaker_bit(desc.ChannelMapping),
                        is_connected: desc.IsConnected.as_bool(),
                        connector_type: connector_type_name(desc.ConnectionType.0),
                        location: geo_location_name(desc.GeoLocation.0),
                    });
                }
            }
        }
        out
    }

    pub(super) fn zero_stream_flags() -> u32 {
        0
    }

    pub(super) fn zero_buffer_flags() -> u32 {
        0
    }

    pub(super) fn render_stream_flags() -> u32 {
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
    }

    pub(super) fn share_mode_shared() -> AUDCLNT_SHAREMODE {
        AUDCLNT_SHAREMODE_SHARED
    }

    pub(super) fn share_mode_exclusive() -> AUDCLNT_SHAREMODE {
        AUDCLNT_SHAREMODE_EXCLUSIVE
    }

    /// Exclusive event-driven streams are woken by the audio engine once per
    /// period instead of polling (lowest latency, no busy-wait).
    pub(super) fn event_stream_flags() -> u32 {
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK
    }

    pub(super) fn flag_silent_mask() -> u32 {
        AUDCLNT_BUFFERFLAGS_SILENT.0 as u32
    }

    pub(super) fn clsctx_all() -> CLSCTX {
        CLSCTX_ALL
    }

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
#[allow(dead_code)]
pub fn render_device_by_id(endpoint_id: &str) -> Result<windows::Win32::Media::Audio::IMMDevice, String> {
    sys::get_render_device_by_id(endpoint_id)
}

#[cfg(windows)]
pub fn clsctx_all() -> windows::Win32::System::Com::CLSCTX {
    sys::clsctx_all()
}

/// The default render endpoint's MMDevice ID string (matches the registry key
/// name under HKLM\...\MMDevices\Audio\Render — used by the APO status list).
#[cfg(windows)]
pub fn default_render_endpoint_id() -> Result<String, String> {
    let _ = sys::init_com_mta();
    let device = sys::get_default_render_device()?;
    let id = unsafe { device.GetId() }.map_err(|e| format!("IMMDevice::GetId failed: {}", e))?;
    let wide = unsafe { id.as_wide() };
    let text = String::from_utf16_lossy(wide);
    unsafe {
        windows::Win32::System::Com::CoTaskMemFree(Some(id.as_ptr() as *const std::ffi::c_void))
    };
    Ok(text)
}

/// Physical jack metadata for every active render endpoint (Windows Device
/// Topology API — IKsJackDescription). Empty on non-Windows / when the
/// topology API exposes no jacks (virtual endpoints, HDMI-in-driver-boards).
#[cfg(windows)]
pub fn list_jack_descriptions() -> Vec<crate::DesktopJackDescription> {
    sys::list_jack_descriptions()
}

#[cfg(not(windows))]
pub fn list_jack_descriptions() -> Vec<crate::DesktopJackDescription> {
    Vec::new()
}

/// Queries the active WASAPI shared-mode mix format channel count (e.g. 2, 6 for 5.1, 8 for 7.1)
/// for a specific Windows render endpoint ID.
#[cfg(windows)]
pub fn query_endpoint_mix_channels(endpoint_id: &str) -> Result<u16, String> {
    sys::init_com_mta()?;
    let device = sys::get_render_device_by_id(endpoint_id)?;
    let audio_client: sys::AudioClientT = unsafe { device.Activate(sys::clsctx_all(), None) }
        .map_err(|e| format!("IAudioClient activation failed: {}", e))?;
    let mix_format: *mut sys::WaveFormatT = unsafe { audio_client.GetMixFormat() }
        .map_err(|e| format!("GetMixFormat failed: {}", e))?;
    if mix_format.is_null() {
        return Ok(2);
    }
    let info = sys::parse_wave_format(unsafe { &*mix_format });
    sys::free_wave_format(mix_format);
    Ok(info.channels.max(2))
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
        let mix_format: *mut sys::WaveFormatT = unsafe { audio_client.GetMixFormat() }
            .map_err(|e| format!("GetMixFormat failed: {}", e))?;
        if mix_format.is_null() {
            return Err("GetMixFormat returned no format.".to_string());
        }
        let info = sys::parse_wave_format(unsafe { &*mix_format });

        // NOTE: process-loopback clients must Initialize with ZERO buffer duration and
        // must NOT set AUDCLNT_STREAMFLAGS_LOOPBACK (the activation params select loopback).
        let init = unsafe {
            audio_client.Initialize(
                sys::share_mode_shared(),
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

        unsafe { audio_client.Start() }.map_err(|e| format!("IAudioClient Start failed: {}", e))?;

        let mut converter = StreamConverter::new();
        converter.configure(&info);

        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let mut next_frames: u32 = match unsafe { capture_client.GetNextPacketSize() } {
                Ok(n) => n,
                Err(_) => break,
            };
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

                let silent = (flags & sys::flag_silent_mask()) != 0;
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

                let _ = unsafe { capture_client.ReleaseBuffer(frames) };

                if !bytes.is_empty() && channel.send(Response::new(bytes)).is_err() {
                    // Frontend dropped the channel — stop this stream cleanly.
                    let _ = unsafe { audio_client.Stop() };
                    return Ok(());
                }

                next_frames = match unsafe { capture_client.GetNextPacketSize() } {
                    Ok(n) => n,
                    Err(_) => break,
                };
            }

            thread::sleep(std::time::Duration::from_millis(8));
        }
        let _ = unsafe { audio_client.Stop() };
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

fn raw_output_pump(
    stop: &AtomicBool,
    queue: mpsc::Receiver<Vec<u8>>,
    endpoint_id: Option<String>,
    channels: u16,
    exclusive: bool,
    status: std::sync::Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    if exclusive {
        raw_output_pump_exclusive(stop, queue, endpoint_id, channels, status)
    } else {
        raw_output_pump_shared(stop, queue, endpoint_id, channels, status)
    }
}

/// Failure info from the exclusive-mode Initialize negotiation (the HRESULT is
/// kept so the caller can decide whether a 16-bit PCM retry makes sense).
#[cfg(windows)]
struct ExclusiveInitFailure {
    unsupported_format: bool,
    message: String,
}

/// Exclusive WASAPI negotiation: event-driven stream, buffer-alignment retry,
/// float32 first with a 16-bit PCM fallback for integer-only endpoints.
/// Returns the armed client plus its period buffer size in frames.
#[cfg(windows)]
fn initialize_exclusive_stream(
    endpoint_id: &Option<String>,
    channels: u16,
    pcm16: bool,
) -> Result<(sys::AudioClientT, u32), ExclusiveInitFailure> {
    let stereo_f32 = sys::target_wave_format();
    let multi_f32 = sys::target_wave_format_channels(channels);
    let stereo_pcm16 = sys::target_wave_format_pcm16();
    let multi_pcm16 = sys::target_wave_format_channels_pcm16(channels);
    let format_ptr: *const WAVEFORMATEX = if channels > 2 {
        if pcm16 {
            &multi_pcm16 as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX
        } else {
            &multi_f32 as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX
        }
    } else if pcm16 {
        &stereo_pcm16 as *const WAVEFORMATEX
    } else {
        &stereo_f32 as *const WAVEFORMATEX
    };

    // Exclusive event-driven streams require hnsPeriodicity == hnsBufferDuration.
    // 30 ms keeps pro-grade latency while leaving the queue a safety margin.
    let mut duration_100ns: i64 = 300_000;
    let mut attempts = 0u8;
    loop {
        attempts += 1;
        let audio_client = sys::activate_render_client(endpoint_id.as_deref())
            .map_err(|e| ExclusiveInitFailure {
                unsupported_format: false,
                message: e,
            })?;
        let init = unsafe {
            audio_client.Initialize(
                sys::share_mode_exclusive(),
                sys::event_stream_flags(),
                duration_100ns,
                duration_100ns,
                format_ptr,
                None,
            )
        };
        match init {
            Ok(()) => {
                let frames = unsafe { audio_client.GetBufferSize() }.map_err(|e| {
                    ExclusiveInitFailure {
                        unsupported_format: false,
                        message: format!("GetBufferSize failed: {}", e),
                    }
                })?;
                return Ok((audio_client, frames));
            }
            Err(e) => {
                let code = e.code().0 as u32;
                if code == sys::AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED && attempts < 3 {
                    // Documented exclusive-mode dance: read the driver-aligned
                    // frame count from the failed client, convert to a duration
                    // and re-initialize a freshly activated client with it.
                    if let Ok(aligned_frames) = unsafe { audio_client.GetBufferSize() } {
                        let aligned =
                            ((aligned_frames as f64) * 10_000_000.0 / 48_000.0).round() as i64;
                        if aligned > 0 {
                            duration_100ns = aligned;
                            continue;
                        }
                    }
                }
                let message = if code == sys::AUDCLNT_E_DEVICE_IN_USE {
                    "another application already holds this endpoint in exclusive mode (or it is disabled). Close other DAW / pro-audio apps using the device, then re-arm".to_string()
                } else if code == sys::AUDCLNT_E_UNSUPPORTED_FORMAT {
                    "the device does not accept this 48 kHz channel layout in exclusive mode. Set the Windows speaker configuration to match the jack layout (Sound Control Panel), or use shared mode".to_string()
                } else {
                    format!("Initialize failed (0x{:08X}): {}", code, e)
                };
                return Err(ExclusiveInitFailure {
                    unsupported_format: code == sys::AUDCLNT_E_UNSUPPORTED_FORMAT,
                    message,
                });
            }
        }
    }
}

/// v2 exclusive per-jack path: bit-perfect event-driven WASAPI stream. The
/// per-jack routing itself happens in the web worklet merger (channel
/// positions); exclusive mode guarantees those channels hit the DAC 1:1 with
/// no shared-mixer/APO interference.
#[cfg(windows)]
fn raw_output_pump_exclusive(
    stop: &AtomicBool,
    queue: mpsc::Receiver<Vec<u8>>,
    endpoint_id: Option<String>,
    channels: u16,
    status: std::sync::Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    sys::init_com_mta()?;

    // Negotiate the exclusive format: 48 kHz float32 first; endpoints whose
    // exclusive mode is integer-only retry once at 16-bit PCM.
    let (audio_client, buffer_frames, bits_per_sample) =
        match initialize_exclusive_stream(&endpoint_id, channels, false) {
            Ok((client, frames)) => (client, frames, 32u16),
            Err(first) => {
                if first.unsupported_format {
                    match initialize_exclusive_stream(&endpoint_id, channels, true) {
                        Ok((client, frames)) => (client, frames, 16u16),
                        Err(second) => {
                            return Err(format!(
                                "Exclusive WASAPI failed — float32: {}; 16-bit PCM: {}.",
                                first.message, second.message
                            ));
                        }
                    }
                } else {
                    return Err(format!("Exclusive WASAPI failed — {}.", first.message));
                }
            }
        };

    let frame_bytes = channels as usize * (bits_per_sample as usize / 8);
    let f32_frame_bytes = channels as usize * 4;

    // Event-driven exclusive stream: the audio engine signals once per period
    // and the ENTIRE buffer is writable each period (no padding bookkeeping).
    let event = unsafe { CreateEventW(None, BOOL(0), BOOL(0), PCWSTR::null()) }
        .map_err(|e| format!("CreateEventW failed: {}", e))?;
    if let Err(e) = unsafe { audio_client.SetEventHandle(event) } {
        let _ = unsafe { CloseHandle(event) };
        return Err(format!("SetEventHandle failed: {}", e));
    }

    let render_client: sys::RenderClientT = unsafe { audio_client.GetService() }
        .map_err(|e| format!("GetService(IAudioRenderClient) failed: {}", e))?;

    // Prime the endpoint with one full silent period so the first event finds
    // the DAC fed (the worklet queue needs one period to arrive).
    if let Ok(ptr) = unsafe { render_client.GetBuffer(buffer_frames) } {
        if !ptr.is_null() {
            unsafe {
                std::ptr::write_bytes(ptr, 0, buffer_frames as usize * frame_bytes);
                let _ = render_client.ReleaseBuffer(buffer_frames, sys::zero_buffer_flags());
            }
        }
    }

    unsafe { audio_client.Start() }.map_err(|e| format!("Raw output Start failed: {}", e))?;
    if let Ok(mut s) = status.lock() {
        *s = Some(format!(
            "exclusive {}ch/{}bit {} frames/period",
            channels, bits_per_sample, buffer_frames
        ));
    }

    let mut pending: Vec<u8> = Vec::new();
    let mut converted: Vec<u8> = Vec::with_capacity(buffer_frames as usize * frame_bytes);
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        // Wake on the audio period; a 200 ms timeout keeps the stop flag
        // responsive even if the endpoint dies silently.
        let wait = unsafe { WaitForSingleObject(event, 200) };
        if wait != WAIT_OBJECT_0 {
            continue;
        }

        while let Ok(block) = queue.try_recv() {
            pending.extend_from_slice(&block);
            // Bound the backlog defensively (≈1 s of audio).
            if pending.len() > 48_000 * f32_frame_bytes {
                pending.drain(..pending.len() - 48_000 * f32_frame_bytes);
            }
        }

        let ptr = match unsafe { render_client.GetBuffer(buffer_frames) } {
            Ok(p) => p,
            Err(_) => break, // endpoint lost
        };
        if ptr.is_null() {
            continue;
        }

        if bits_per_sample == 32 {
            // Device speaks float32 — direct block copy with zero-pad tail.
            let needed = buffer_frames as usize * frame_bytes;
            unsafe {
                let take = pending.len().min(needed);
                if take > 0 {
                    std::ptr::copy_nonoverlapping(pending.as_ptr(), ptr, take);
                    pending.drain(..take);
                }
                if take < needed {
                    std::ptr::write_bytes(ptr.add(take), 0, needed - take);
                }
                let _ = render_client.ReleaseBuffer(buffer_frames, sys::zero_buffer_flags());
            }
        } else {
            // Integer-only endpoint: convert the f32 wire format to 16-bit PCM.
            converted.clear();
            let total_samples = buffer_frames as usize * channels as usize;
            let mut src_idx = 0usize;
            for _ in 0..total_samples {
                if src_idx + 4 <= pending.len() {
                    let sample = f32::from_le_bytes([
                        pending[src_idx],
                        pending[src_idx + 1],
                        pending[src_idx + 2],
                        pending[src_idx + 3],
                    ]);
                    src_idx += 4;
                    let scaled = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
                    converted.extend_from_slice(&scaled.to_le_bytes());
                } else {
                    converted.extend_from_slice(&0i16.to_le_bytes());
                }
            }
            pending.drain(..src_idx);
            unsafe {
                std::ptr::copy_nonoverlapping(converted.as_ptr(), ptr, converted.len());
                let _ = render_client.ReleaseBuffer(buffer_frames, sys::zero_buffer_flags());
            }
        }
    }

    let _ = unsafe { audio_client.Stop() };
    let _ = unsafe { CloseHandle(event) };
    if let Ok(mut s) = status.lock() {
        *s = None;
    }
    Ok(())
}

#[cfg(not(windows))]
fn raw_output_pump_exclusive(
    stop: &AtomicBool,
    queue: mpsc::Receiver<Vec<u8>>,
    endpoint_id: Option<String>,
    channels: u16,
    status: std::sync::Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    let _ = (stop, queue, endpoint_id, channels, status);
    Err("Exclusive WASAPI output requires Windows.".to_string())
}

fn raw_output_pump_shared(
    stop: &AtomicBool,
    queue: mpsc::Receiver<Vec<u8>>,
    endpoint_id: Option<String>,
    channels: u16,
    status: std::sync::Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        sys::init_com_mta()?;

        let audio_client: sys::AudioClientT = sys::activate_render_client(endpoint_id.as_deref())?;

        // Stereo keeps the plain float format (the classic worklet contract);
        // 3..=32 channels request a WAVEFORMATEXTENSIBLE stream with the
        // standard speaker mask so discrete jack pairs are addressed 1:1.
        let stereo_format = sys::target_wave_format();
        let multi_format = sys::target_wave_format_channels(channels);
        let format_ptr: *const WAVEFORMATEX = if channels > 2 {
            &multi_format as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX
        } else {
            &stereo_format
        };
        let frame_bytes = channels as usize * 4;
        let buffer_duration_100ns: i64 = 2_000_000; // 200 ms
        unsafe {
            audio_client.Initialize(
                sys::share_mode_shared(),
                sys::render_stream_flags(),
                buffer_duration_100ns,
                0,
                format_ptr,
                None,
            )
        }
        .map_err(|e| format!("Raw output Initialize failed: {}", e))?;

        let render_client: sys::RenderClientT = unsafe { audio_client.GetService() }
            .map_err(|e| format!("GetService(IAudioRenderClient) failed: {}", e))?;

        let buffer_frames: u32 = unsafe { audio_client.GetBufferSize() }
            .map_err(|e| format!("GetBufferSize failed: {}", e))?;

        // Pre-fill the whole buffer with silence so playback starts primed.
        if let Ok(ptr) = unsafe { render_client.GetBuffer(buffer_frames) } {
            if !ptr.is_null() {
                unsafe {
                    std::ptr::write_bytes(ptr, 0, buffer_frames as usize * frame_bytes);
                    let _ = render_client.ReleaseBuffer(buffer_frames, sys::zero_buffer_flags());
                }
            }
        }

        unsafe { audio_client.Start() }.map_err(|e| format!("Raw output Start failed: {}", e))?;
        if let Ok(mut s) = status.lock() {
            *s = Some(format!("shared {}ch", channels));
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
                if pending.len() > 48_000 * frame_bytes {
                    pending.drain(..pending.len() - 48_000 * frame_bytes);
                }
            }

            let padding: u32 = match unsafe { audio_client.GetCurrentPadding() } {
                Ok(p) => p,
                Err(_) => break,
            };
            let available = buffer_frames.saturating_sub(padding);
            if available >= 960 {
                if let Ok(ptr) = unsafe { render_client.GetBuffer(available) } {
                    if !ptr.is_null() {
                        let needed = available as usize * frame_bytes;
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
        let _ = unsafe { audio_client.Stop() };
        if let Ok(mut s) = status.lock() {
            *s = None;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (stop, queue, endpoint_id, channels, status);
        Err("Raw WASAPI output requires Windows.".to_string())
    }
}
