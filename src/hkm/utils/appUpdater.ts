import { isDesktopApp } from './appApi.ts';
import { diagError, diagInfo, diagWarn } from './diagnosticsLog.ts';

/** Live throughput telemetry for an in-app update download. */
export interface UpdateDownloadStats {
  downloadedBytes: number;
  totalBytes: number; // 0 when the server did not report a content length
  bytesPerSecond: number; // exponential moving average
}

export type UpdateProgressCallback = (percent: number, stats?: UpdateDownloadStats) => void;
export type UpdateInstallFn = (onProgress?: UpdateProgressCallback) => Promise<void>;

export interface UpdateStatus {
  checking: boolean;
  updateAvailable: boolean;
  version?: string;
  notes?: string;
  error?: string;
  downloadProgress?: number; // 0 - 100
  downloading?: boolean;
  readyToRestart?: boolean;
}

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  assets?: GithubReleaseAsset[];
}

const GITHUB_RELEASES_API =
  'https://api.github.com/repos/abazion372/HKM-MASTER-AUDIO-CONSOLE/releases/latest';

function compareSemver(a: string, b: string): number {
  const clean = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a0 = 0, a1 = 0, a2 = 0] = clean(a);
  const [b0 = 0, b1 = 0, b2 = 0] = clean(b);
  if (a0 !== b0) return a0 - b0;
  if (a1 !== b1) return a1 - b1;
  return a2 - b2;
}

async function checkGithubLatestReleaseFallback(): Promise<{
  available: boolean;
  version?: string;
  notes?: string;
  downloadAndInstall?: UpdateInstallFn;
  error?: string;
}> {
  let currentVersion = '0.2.35';
  try {
    const appApi = await import('@tauri-apps/api/app');
    currentVersion = await appApi.getVersion();
  } catch {
    // use default fallback version
  }

  const res = await fetch(GITHUB_RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) {
    // No GitHub release published yet — report up-to-date cleanly
    return { available: false };
  }
  if (!res.ok) {
    return { available: false, error: `GitHub Releases returned HTTP ${res.status}` };
  }

  const release = (await res.json()) as GithubReleasePayload;
  const latestVersion = (release.tag_name || release.name || '').replace(/^v/i, '').trim();
  if (!latestVersion || compareSemver(latestVersion, currentVersion) <= 0) {
    return { available: false };
  }

  const installerAsset = (release.assets ?? []).find((a) =>
    /setup\.exe$|\.msi$/i.test(a.name)
  );
  const targetUrl =
    installerAsset?.browser_download_url ||
    release.html_url ||
    'https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE/releases/latest';

  return {
    available: true,
    version: latestVersion,
    notes: release.body,
    downloadAndInstall: async (onProgress?: UpdateProgressCallback) => {
      onProgress?.(50);
      // Prefer the global Tauri opener plugin when available; fall back to window.open.
      let opened = false;
      try {
        const invoke = (window as unknown as { __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__?.core?.invoke;
        if (invoke) {
          await invoke('plugin:opener|open_url', { url: targetUrl });
          opened = true;
        }
      } catch {
        // opener unavailable — fall through to window.open
      }
      if (!opened) {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
      onProgress?.(100);
    },
  };
}

async function openUrlInSystemBrowser(url: string): Promise<boolean> {
  // Prefer the global Tauri opener plugin when available; fall back to window.open.
  try {
    const invoke = (window as unknown as { __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__?.core?.invoke;
    if (invoke) {
      await invoke('plugin:opener|open_url', { url });
      return true;
    }
  } catch {
    // opener unavailable — fall through to window.open
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Resolves the latest release's Windows installer URL and opens it in the system
 * browser — the escape hatch for networks where the in-app Rust downloader is
 * throttled (AV HTTPS inspection / DPI / broken IPv6) while the browser downloads
 * the same artifact from the same CDN at full speed.
 *
 * Tries the GitHub Releases API for the exact asset URL, falling back to the
 * stable `releases/download/v<version>/...` naming convention.
 */
export async function openUpdateDownloadInBrowser(targetVersion?: string): Promise<{
  opened: boolean;
  url?: string;
}> {
  let url: string | undefined;
  try {
    const res = await fetch(GITHUB_RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const release = (await res.json()) as GithubReleasePayload;
      url = (release.assets ?? []).find((a) => /setup\.exe$|\.msi$/i.test(a.name))?.browser_download_url;
    }
  } catch {
    // offline / rate-limited — fall through to the predictable URL below
  }
  if (!url && targetVersion) {
    const v = targetVersion.replace(/^v/i, '').trim();
    url = `https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE/releases/download/v${v}/HKM.Audio.System_${v}_x64-setup.exe`;
  }
  if (!url) {
    url = 'https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE/releases/latest';
  }
  const opened = await openUrlInSystemBrowser(url);
  diagInfo('updater', `Opened update download in system browser: ${url}`);
  return { opened, url };
}

/**
 * Checks for new releases against the Tauri signed updater manifest (`latest.json`),
 * falling back to the public GitHub Releases API when unsigned or before keys are configured.
 * Only executes when running inside the Tauri native desktop shell.
 */
export async function checkDesktopUpdate(): Promise<{
  available: boolean;
  version?: string;
  notes?: string;
  downloadAndInstall?: UpdateInstallFn;
  error?: string;
}> {
  if (!isDesktopApp()) {
    return { available: false, error: 'In-app updates are only available in the desktop app.' };
  }

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();

    if (!update) {
      return { available: false };
    }

    diagInfo('updater', `Update v${update.version} available (signed manifest).`);

    return {
      available: true,
      version: update.version,
      notes: update.body,
      downloadAndInstall: async (onProgress?: UpdateProgressCallback) => {
        let downloaded = 0;
        let contentLength = 0;
        let emaBytesPerSecond = 0;
        let lastTickMs = performance.now();
        let lastTickBytes = 0;

        try {
          const { prepareDesktopForUpdate } = await import('./nativeDesktopAudio.ts');
          await prepareDesktopForUpdate();
        } catch {
          // ignore pre-update hook errors
        }

        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case 'Started':
              contentLength = event.data.contentLength ?? 0;
              lastTickMs = performance.now();
              onProgress?.(0, { downloadedBytes: 0, totalBytes: contentLength, bytesPerSecond: 0 });
              break;
            case 'Progress': {
              downloaded += event.data.chunkLength;
              const now = performance.now();
              const dtMs = now - lastTickMs;
              // Emit throttled progress+speed telemetry (every 250 ms) so the UI can
              // show live throughput without re-rendering per 64 KB chunk.
              if (dtMs >= 250) {
                const instantBps = ((downloaded - lastTickBytes) * 1000) / dtMs;
                emaBytesPerSecond =
                  emaBytesPerSecond === 0
                    ? instantBps
                    : emaBytesPerSecond * 0.3 + instantBps * 0.7;
                lastTickMs = now;
                lastTickBytes = downloaded;
                const pct =
                  contentLength > 0
                    ? Math.min(100, Math.round((downloaded / contentLength) * 100))
                    : 0;
                onProgress?.(pct, {
                  downloadedBytes: downloaded,
                  totalBytes: contentLength,
                  bytesPerSecond: emaBytesPerSecond,
                });
              }
              break;
            }
            case 'Finished':
              onProgress?.(100, {
                downloadedBytes: contentLength || downloaded,
                totalBytes: contentLength,
                bytesPerSecond: emaBytesPerSecond,
              });
              break;
          }
        });

        // On Windows NSIS passive mode (`/P /R`), the installer has now been launched
        // and will automatically relaunch the updated binary once extraction finishes.
        // Exit the current process immediately so it never holds a file lock on
        // hkm-audio-system.exe or loops back into "Restart Now" on the old binary.
        try {
          const { finishDesktopUpdateAndExit } = await import('./nativeDesktopAudio.ts');
          await finishDesktopUpdateAndExit();
        } catch {
          // ignore
        }
      },
    };
  } catch {
    try {
      diagWarn('updater', 'Signed updater check failed — falling back to the GitHub Releases API.');
      return await checkGithubLatestReleaseFallback();
    } catch (fallbackErr) {
      const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      diagError('updater', `Update check failed: ${message}`);
      return { available: false, error: message };
    }
  }
}
