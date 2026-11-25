//! System-level helpers: Windows Sound settings launcher and OS-wide CPU usage.

/// Opens the Windows Sound settings page (`apps-volume` = per-app volume mixer).
/// Returns false when not running on Windows or when the launch failed.
#[cfg(windows)]
pub fn open_windows_sound_settings(page: &str) -> bool {
    use std::os::windows::process::CommandExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    if page == "mmsys" || page == "speaker-config" {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if std::process::Command::new("control.exe")
            .arg("mmsys.cpl,,0")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok()
        {
            return true;
        }
    }

    let target = match page {
        "sound" | "mmsys" | "speaker-config" => "ms-settings:sound",
        _ => "ms-settings:apps-volume",
    };
    let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let verb: Vec<u16> = "open\0".encode_utf16().collect();

    // ShellExecuteW returns a value > 32 on success. First param is an optional owner HWND.
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(wide.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    result.0 as usize > 32
}

#[cfg(not(windows))]
pub fn open_windows_sound_settings(_page: &str) -> bool {
    false
}

#[derive(Default, Clone, Copy)]
struct CpuSample {
    idle: u64,
    kernel: u64,
    user: u64,
}

static LAST_CPU_SAMPLE: std::sync::Mutex<Option<(CpuSample, std::time::Instant)>> =
    std::sync::Mutex::new(None);

/// OS-wide CPU utilization percentage (0-100), sampled against the previous call.
/// Returns `None` when the platform reading is unavailable.
#[cfg(windows)]
pub fn system_cpu_usage() -> Option<f64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetSystemTimes;

    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();

    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.ok()?;
    let to_u64 = |ft: &FILETIME| ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    let sample = CpuSample {
        idle: to_u64(&idle),
        kernel: to_u64(&kernel),
        user: to_u64(&user),
    };
    Some(evaluate_sample(sample))
}

#[cfg(not(windows))]
pub fn system_cpu_usage() -> Option<f64> {
    // /proc/stat first line: cpu  user nice system idle iowait irq softirq steal ...
    let raw = std::fs::read_to_string("/proc/stat").ok()?;
    let line = raw.lines().next()?;
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse::<u64>().ok())
        .collect();
    if fields.len() < 5 {
        return None;
    }
    let idle = fields[3] + fields.get(4).copied().unwrap_or(0);
    let total: u64 = fields.iter().sum();
    // Encode total in `kernel` so the shared evaluator works unchanged.
    let sample = CpuSample {
        idle,
        kernel: total,
        user: 0,
    };
    Some(evaluate_sample(sample))
}

fn evaluate_sample(sample: CpuSample) -> f64 {
    let now = std::time::Instant::now();
    let mut guard = LAST_CPU_SAMPLE.lock().ok();
    let previous = guard.as_mut().and_then(|g| g.replace((sample, now)));
    match previous {
        Some((prev, _)) => {
            let idle_delta = sample.idle.saturating_sub(prev.idle);
            let total_delta = (sample.kernel + sample.user).saturating_sub(prev.kernel + prev.user);
            if total_delta == 0 {
                0.0
            } else {
                let busy = total_delta.saturating_sub(idle_delta) as f64;
                (busy / total_delta as f64 * 100.0).clamp(0.0, 100.0)
            }
        }
        None => 0.0,
    }
}
