//! Embedded Next.js standalone server lifecycle.
//!
//! In development (`cargo tauri dev`), `beforeDevCommand` runs `npm run dev` on
//! `http://localhost:3000` and Tauri points the webview at `devUrl` directly —
//! nothing here spawns.
//!
//! In production, the NSIS installer lays down:
//! - `<resources>/next-server/server.js` (Next.js standalone output + `.next/static` + `public`)
//! - `<resources>/binaries/hkm-server.exe` (self-contained bun runtime, x64-baseline for all CPUs)
//!
//! On startup [`ensure_server`] picks a free loopback port (preferring `37741`),
//! spawns `<runtime> server.js` with `PORT=<port> HOSTNAME=127.0.0.1`, polls the root
//! URL until it responds (up to 60 seconds for slow HDDs / dual-core PCs, while
//! checking `child.try_wait()` so an early crash is detected and retried immediately),
//! starts a background self-healing watchdog thread, and hands the live base URL back.

use std::fs::OpenOptions;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

const DEFAULT_PORT: u16 = 37741;
const DEV_URL: &str = "http://localhost:3000";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);
const HEALTH_POLL: Duration = Duration::from_millis(200);

#[derive(Clone)]
struct ServerSpawnConfig {
    runtime: PathBuf,
    server_js: PathBuf,
    work_dir: PathBuf,
    log_path: PathBuf,
    port: u16,
}

#[derive(Default)]
pub struct ManagedServer {
    child: Arc<Mutex<Option<Child>>>,
    config: Arc<Mutex<Option<ServerSpawnConfig>>>,
    shutting_down: Arc<std::sync::atomic::AtomicBool>,
    base_url: Mutex<Option<String>>,
}

impl ManagedServer {
    pub fn set_base_url(&self, url: String) {
        if let Ok(mut guard) = self.base_url.lock() {
            *guard = Some(url);
        }
    }

    pub fn base_url(&self) -> Option<String> {
        self.base_url.lock().ok().and_then(|g| g.clone())
    }

    pub fn shutdown(&self) {
        self.shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for ManagedServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Ensures the console HTTP server is up and returns its base URL.
pub async fn ensure_server(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<ManagedServer>();

    if cfg!(debug_assertions) {
        if let Ok(url) = std::env::var("HKM_DEV_SERVER_URL") {
            state.set_base_url(url.clone());
            return Ok(url);
        }
        if is_healthy_blocking(DEV_URL) {
            state.set_base_url(DEV_URL.to_string());
            return Ok(DEV_URL.to_string());
        }
    }

    // Kill any leftover orphaned `hkm-server.exe` from a previous crashed session or update
    // before choosing our loopback port, and pause briefly so Windows releases the socket.
    kill_stale_server_processes();

    let server_js = locate_server_js(app).ok_or_else(|| {
        "Console server bundle (next-server/server.js) was not found inside the application \
         resources. Reinstall HKM Audio System using the official Setup installer."
            .to_string()
    })?;
    let work_dir = server_js
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Invalid next-server path.".to_string())?;

    let candidates = locate_runtime_candidates(app);
    if candidates.is_empty() {
        return Err(
            "No JavaScript runtime found to launch the console server. Expected bundled \
             binaries/hkm-server.exe or a system `node`/`bun` installation on PATH."
                .to_string(),
        );
    }

    let port = pick_free_port(DEFAULT_PORT);
    let url = format!("http://127.0.0.1:{}", port);
    let log_path = std::env::temp_dir().join("hkm-audio-system-server-boot.log");

    let mut last_errors: Vec<String> = Vec::new();

    for runtime in candidates {
        let cfg = ServerSpawnConfig {
            runtime: runtime.clone(),
            server_js: server_js.clone(),
            work_dir: work_dir.clone(),
            log_path: log_path.clone(),
            port,
        };

        let mut child = match spawn_server_child(&cfg) {
            Ok(c) => c,
            Err(e) => {
                last_errors.push(format!("{} failed to spawn: {}", runtime.display(), e));
                continue;
            }
        };

        match wait_healthy_with_child(&url, &mut child, HEALTH_TIMEOUT) {
            Ok(()) => {
                if let Ok(mut guard) = state.child.lock() {
                    *guard = Some(child);
                }
                if let Ok(mut cfg_guard) = state.config.lock() {
                    *cfg_guard = Some(cfg);
                }
                state.set_base_url(url.clone());
                start_server_watchdog(
                    state.child.clone(),
                    state.config.clone(),
                    state.shutting_down.clone(),
                    url.clone(),
                );
                return Ok(url);
            }
            Err(reason) => {
                let _ = child.kill();
                let _ = child.wait();
                let boot_log = std::fs::read_to_string(&log_path)
                    .unwrap_or_default()
                    .lines()
                    .rev()
                    .take(10)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ");
                last_errors.push(format!(
                    "{}: {} (log: {})",
                    runtime.display(),
                    reason,
                    if boot_log.is_empty() { "empty" } else { &boot_log }
                ));
            }
        }
    }

    Err(format!(
        "Console server did not become ready on {}. Attempts: {}",
        url,
        last_errors.join(" ; ")
    ))
}

fn spawn_server_child(cfg: &ServerSpawnConfig) -> Result<Child, String> {
    let mut cmd = Command::new(&cfg.runtime);
    cmd.arg(&cfg.server_js)
        .current_dir(&cfg.work_dir)
        .env("NODE_ENV", "production")
        .env("PORT", cfg.port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        // Lower memory ceiling for low-RAM PCs (2GB-4GB RAM systems)
        .env("BUN_JSC_forceRAMSize", "536870912")
        .stdin(Stdio::null());

    if let Ok(log_file) = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&cfg.log_path)
    {
        let err_file = log_file.try_clone().ok();
        cmd.stdout(Stdio::from(log_file));
        if let Some(err) = err_file {
            cmd.stderr(Stdio::from(err));
        } else {
            cmd.stderr(Stdio::null());
        }
    } else {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(|e| e.to_string())
}

/// Self-healing watchdog: if `hkm-server.exe` ever crashes or is killed by Windows low-memory
/// killer on a low-spec PC, automatically respawn it on the exact same loopback port.
fn start_server_watchdog(
    child_arc: Arc<Mutex<Option<Child>>>,
    config_arc: Arc<Mutex<Option<ServerSpawnConfig>>>,
    shutting_down: Arc<std::sync::atomic::AtomicBool>,
    url: String,
) {
    std::thread::Builder::new()
        .name("hkm-server-watchdog".to_string())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(4));
                if shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }

                let mut needs_respawn = false;
                if let Ok(mut guard) = child_arc.lock() {
                    if let Some(child) = guard.as_mut() {
                        if let Ok(Some(_status)) = child.try_wait() {
                            needs_respawn = true;
                            *guard = None;
                        }
                    }
                }

                if needs_respawn && !shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
                    let cfg_opt = config_arc.lock().ok().and_then(|g| g.clone());
                    if let Some(cfg) = cfg_opt {
                        eprintln!(
                            "[hkm-watchdog] Embedded server on {} exited unexpectedly; respawning...",
                            url
                        );
                        if let Ok(new_child) = spawn_server_child(&cfg) {
                            if let Ok(mut guard) = child_arc.lock() {
                                *guard = Some(new_child);
                            }
                        }
                    }
                }
            }
        })
        .ok();
}

/// Terminates any lingering `hkm-server.exe` processes from a previous abnormal exit
/// so they never hold file locks or stale ports.
fn kill_stale_server_processes() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Ok(mut child) = Command::new("taskkill")
            .args(["/F", "/T", "/IM", "hkm-server.exe"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            let _ = child.wait();
            // Give the Windows TCP stack 250ms to release TIME_WAIT / bound sockets
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

fn pick_free_port(preferred: u16) -> u16 {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|s| s.local_addr())
        .map(|a| a.port())
        .unwrap_or(preferred)
}

/// Fast synchronous TCP + HTTP probe that does not depend on Tokio worker thread scheduling.
fn is_healthy_blocking(url: &str) -> bool {
    let parsed = match url.strip_prefix("http://") {
        Some(rest) => rest.split('/').next().unwrap_or("127.0.0.1:37741"),
        None => "127.0.0.1:37741",
    };
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    let addr: SocketAddr = match parsed.parse() {
        Ok(a) => a,
        Err(_) => {
            if parsed == "localhost:3000" {
                match "127.0.0.1:3000".parse() {
                    Ok(a) => a,
                    Err(_) => return false,
                }
            } else {
                return false;
            }
        }
    };

    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    let req = format!(
        "HEAD / HTTP/1.0\r\nHost: {}\r\nConnection: close\r\n\r\n",
        parsed
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    match stream.read(&mut buf) {
        Ok(n) if n >= 12 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/1.1 ") || head.starts_with("HTTP/1.0 ")
        }
        _ => false,
    }
}

fn wait_healthy_with_child(
    url: &str,
    child: &mut Child,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if is_healthy_blocking(url) {
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("process exited early with status {}", status));
        }
        std::thread::sleep(HEALTH_POLL);
    }
    Err(format!("timed out after {}s", timeout.as_secs()))
}

fn locate_server_js(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("next-server").join("server.js"));
        candidates.push(res.join(".next").join("standalone").join("server.js"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("next-server").join("server.js"));
            candidates.push(dir.join("resources").join("next-server").join("server.js"));
        }
    }
    // Dev convenience: walk up from current_dir looking for `.next/standalone/server.js`.
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(3) {
            candidates.push(ancestor.join(".next").join("standalone").join("server.js"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Returns ordered list of JS runtime candidates (bundled `hkm-server.exe` first,
/// followed by system `node` or `bun` so even if a machine blocks or lacks support for
/// one runtime, it transparently falls back to the next).
fn locate_runtime_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut bundled: Vec<PathBuf> = Vec::new();
    let exe_name = if cfg!(windows) { "hkm-server.exe" } else { "hkm-server" };

    if let Ok(res) = app.path().resource_dir() {
        bundled.push(res.join("binaries").join(exe_name));
        bundled.push(res.join(exe_name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bundled.push(dir.join("binaries").join(exe_name));
            bundled.push(dir.join("resources").join("binaries").join(exe_name));
            bundled.push(dir.join(exe_name));
        }
    }

    let mut out: Vec<PathBuf> = Vec::new();
    for path in bundled {
        if path.is_file() && !out.contains(&path) {
            out.push(path);
        }
    }

    for bin in ["node", "bun"] {
        let probe = if cfg!(windows) {
            Command::new("where")
                .arg(bin)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
        } else {
            Command::new("which")
                .arg(bin)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
        };
        if let Ok(output) = probe {
            if output.status.success() {
                if let Some(first) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let path = PathBuf::from(first.trim());
                    if path.is_file() && !out.contains(&path) {
                        out.push(path);
                    }
                }
            }
        }
    }
    out
}
