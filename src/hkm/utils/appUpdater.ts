import { isDesktopApp } from './appApi.ts';

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
  downloadAndInstall?: (onProgress?: (percent: number) => void) => Promise<void>;
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
    downloadAndInstall: async (onProgress?: (percent: number) => void) => {
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

/**
 * Checks for new releases against the Tauri signed updater manifest (`latest.json`),
 * falling back to the public GitHub Releases API when unsigned or before keys are configured.
 * Only executes when running inside the Tauri native desktop shell.
 */
export async function checkDesktopUpdate(): Promise<{
  available: boolean;
  version?: string;
  notes?: string;
  downloadAndInstall?: (onProgress?: (percent: number) => void) => Promise<void>;
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

    return {
      available: true,
      version: update.version,
      notes: update.body,
      downloadAndInstall: async (onProgress?: (percent: number) => void) => {
        let downloaded = 0;
        let contentLength = 0;

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
              onProgress?.(0);
              break;
            case 'Progress':
              downloaded += event.data.chunkLength;
              if (contentLength > 0) {
                const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
                onProgress?.(pct);
              }
              break;
            case 'Finished':
              onProgress?.(100);
              break;
          }
        });
      },
    };
  } catch {
    try {
      return await checkGithubLatestReleaseFallback();
    } catch (fallbackErr) {
      const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      return { available: false, error: message };
    }
  }
}
