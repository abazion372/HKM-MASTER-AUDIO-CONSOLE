//! Embedded Next.js console server management.
//!
//! The HKM web console is a Next.js application whose API routes (state sync, hardware
//! scan, AI engineer, remote companion session, audit trail, presets...) all run on a
//! local HTTP server. The Tauri shell manages that server's lifecycle:
//!
//! - **Dev (`tauri dev`)**: attaches to the bun/next dev server already managed by the
//!   Tauri CLI on http://localhost:3000. No child process is spawned.
//! - **Production**: spawns the bundled standalone Next server (`resources/next-server/server.js`)
//!   using the bundled bun runtime (`resources/binaries/hkm-server.exe`) when present,
//!   falling back to a system `node` / `bun` install. The server binds to 127.0.0.1 on one
//!   of the fixed ports declared in `SERVER_PORTS` (fixed ports keep the remote-IPC
//!   capability allowlist in `capabilities/local-server.json` valid).

use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// Fixed candidate ports for the production console server (see capabilities/local-server.json).
/// IMPORTANT: keep 37741 free so the server normally always binds the SAME
/// port — the WebView2 origin (and therefore any persisted permission state)
/// stays stable across app restarts and installer updates.
pub const SERVER_PORTS: [u16; 3] = [37741, 37742, 37743];
const DEV_BASE: &str = "http://localhost:3000";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL: Duration = Duration::from_millis(150);

pub struct ServerManager {
    child: Mutex<Option<Child>>,
    base: Mutex<String>,
}

impl ServerManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            base: Mutex::new(String::new()),
        }
    }

    pub fn base_url(&self) -> String {
        self.base.lock().map(|b| b.clone()).unwrap_or_default()
    }

    /// Stops the managed server child (if any). Called on app exit.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn pick_free_port() -> Option<u16> {
    for port in SERVER_PORTS {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// Kills any `hkm-server.exe` left behind by a previous instance that crashed
/// or was force-closed: an orphaned sidecar holds BOTH the exe file (breaking
/// NSIS/updater installs with "Error opening file for writing") and the fixed
/// port 37741 (forcing a fallback port = new WebView origin = permission
/// prompts). Safe because the single-instance plugin guarantees this process
/// is the only live HKM console, so any hkm-server.exe found is a stale orphan.
fn kill_stale_server_processes() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", "hkm-server.exe"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

async fn wait_healthy(client: &reqwest::Client, base: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let probe = format!("{}/api/health", base);
        match client.get(&probe).timeout(Duration::from_secs(6)).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Console server did not become healthy within {}s ({}).",
                timeout.as_secs(),
                base
            ));
        }
        std::thread::sleep(HEALTH_POLL);
    }
}

fn spawn_server_process(app: &AppHandle, port: u16) -> Result<Child, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not resolve resource directory: {}", e))?;

    let server_js = resources.join("next-server").join("server.js");
    if !server_js.exists() {
        return Err(format!(
            "Bundled console server not found: {}",
            server_js.display()
        ));
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("db"))
        .unwrap_or_else(|_| resources.join("next-server").join("db"));
    let _ = std::fs::create_dir_all(&data_dir);
    let log_path = data_dir.join("server-boot.log");
    let stdout_file = std::fs::File::create(&log_path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let stderr_file = std::fs::OpenOptions::new()
        .append(true)
        .open(&log_path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());

    // Prefer the bundled bun runtime, then system node, then system bun.
    let bundled_bun = resources.join("binaries").join("hkm-server.exe");
    let (program, args): (String, Vec<String>) = if bundled_bun.exists() {
        (
            bundled_bun.to_string_lossy().to_string(),
            vec!["server.js".to_string()],
        )
    } else {
        let runner = ["node", "bun"]
            .iter()
            .find(|candidate| which_exists(candidate))
            .ok_or_else(|| {
                "Neither the bundled hkm-server.exe nor a system node/bun runtime was found. \
                 Run `bun run desktop:fetch-server` and rebuild."
                    .to_string()
            })?;
        (
            runner.to_string(),
            vec!["server.js".to_string()],
        )
    };

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(resources.join("next-server"))
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("HKM_DATA_DIR", &data_dir)
        .stdout(stdout_file)
        .stderr(stderr_file);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(|e| format!("Failed to start console server ({}): {}", program, e))
}

fn which_exists(program: &str) -> bool {
    #[cfg(windows)]
    {
        // `where` is available on every Windows install since NT.
        std::process::Command::new("where")
            .arg(program)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("which")
            .arg(program)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Ensures the console server is running and returns its base URL.
/// Blocks until the server reports healthy (up to `HEALTH_TIMEOUT` in production).
pub fn ensure_server(app: &AppHandle, manager: &ServerManager, http: &reqwest::Client) -> Result<String, String> {
    let existing = manager.base_url();
    if !existing.is_empty() {
        return Ok(existing);
    }

    // Dev builds attach to the external dev server only when HKM_USE_DEV_SERVER=1 is set
    // or when the bundled next-server/server.js is not present alongside the binary.
    if cfg!(debug_assertions) {
        let has_bundled = app
            .path()
            .resource_dir()
            .ok()
            .map(|r| r.join("next-server").join("server.js").exists())
            .unwrap_or(false);
        if !has_bundled || std::env::var("HKM_USE_DEV_SERVER").as_deref() == Ok("1") {
            let _ = tauri::async_runtime::block_on(wait_healthy(
                http,
                DEV_BASE,
                Duration::from_secs(20),
            ));
            *manager.base.lock().map_err(|e| e.to_string())? = DEV_BASE.to_string();
            return Ok(DEV_BASE.to_string());
        }
    }

    // Clear orphaned sidecars from a crashed previous run before choosing a
    // port (see kill_stale_server_processes). This process has no managed
    // server child yet, so the kill can never hit our own runtime.
    kill_stale_server_processes();

    let port = pick_free_port()
        .ok_or_else(|| "All HKM console server ports (37741-37743) are already in use.".to_string())?;
    let base = format!("http://127.0.0.1:{}", port);

    let child = spawn_server_process(app, port)?;
    *manager.child.lock().map_err(|e| e.to_string())? = Some(child);

    tauri::async_runtime::block_on(wait_healthy(http, &base, HEALTH_TIMEOUT))?;
    *manager.base.lock().map_err(|e| e.to_string())? = base.clone();
    Ok(base)
}
