import { useState } from 'react';
import {
  ArrowDownCircle,
  RefreshCw,
  X,
  Sparkles,
  CheckCircle2,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import {
  openUpdateDownloadInBrowser,
  type UpdateDownloadStats,
  type UpdateInstallFn,
} from '../utils/appUpdater.ts';

/** Below this sustained in-app throughput the browser fallback is suggested. */
const SLOW_DOWNLOAD_BYTES_PER_SECOND = 256 * 1024; // 250 KB/s

interface UpdateNotificationModalProps {
  version: string;
  notes?: string;
  onInstall: UpdateInstallFn;
  onDismiss: () => void;
}

function formatBytesPerSecond(bps: number): string {
  if (bps <= 0) return '—';
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, '0')}m`;
}

export function UpdateNotificationModal({
  version,
  notes,
  onInstall,
  onDismiss,
}: UpdateNotificationModalProps) {
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stats, setStats] = useState<UpdateDownloadStats | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserOpened, setBrowserOpened] = useState(false);

  const slowDownload =
    !!stats &&
    stats.downloadedBytes > 150 * 1024 &&
    stats.bytesPerSecond > 0 &&
    stats.bytesPerSecond < SLOW_DOWNLOAD_BYTES_PER_SECOND;

  const etaSeconds =
    stats && stats.totalBytes > 0 && stats.bytesPerSecond > 0
      ? (stats.totalBytes - stats.downloadedBytes) / stats.bytesPerSecond
      : Number.NaN;

  const handleStartUpdate = async () => {
    setDownloading(true);
    setProgress(0);
    setStats(null);
    setError(null);
    try {
      await onInstall((pct, s) => {
        setProgress(pct);
        if (s) setStats(s);
      });
      setReady(true);
      setDownloading(false);
    } catch (err) {
      setDownloading(false);
      setError(err instanceof Error ? err.message : 'Failed to download update.');
    }
  };

  const handleOpenInBrowser = async () => {
    setBrowserOpened(true);
    try {
      await openUpdateDownloadInBrowser(version);
    } catch {
      setBrowserOpened(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Software Update"
    >
      <div className="w-full max-w-lg rounded-xl border border-sky-500/50 bg-[#0A0E17] shadow-2xl overflow-hidden font-sans text-slate-100">
        {/* Header */}
        <div className="px-5 py-4 bg-gradient-to-r from-sky-950/80 to-slate-900 border-b border-sky-500/30 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-sky-500/20 text-sky-400 border border-sky-400/30">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm tracking-wide text-white">NEW UPDATE AVAILABLE</h3>
              <p className="text-xs text-sky-300 font-mono">Church Audio Intelligence v{version}</p>
            </div>
          </div>
          {!downloading && (
            <button
              type="button"
              onClick={onDismiss}
              className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition"
              title="Later"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-xs">
          {notes ? (
            <div className="p-3 rounded-lg border border-slate-800 bg-[#06090F] max-h-48 overflow-y-auto space-y-1.5 text-slate-300">
              <p className="font-semibold text-slate-100 uppercase tracking-wider text-[11px]">
                Release Notes
              </p>
              <div className="whitespace-pre-line text-slate-300 font-sans leading-relaxed">
                {notes}
              </div>
            </div>
          ) : (
            <div
              className="flex items-center gap-2 p-3 rounded-lg border border-sky-500/40 bg-sky-950/40 text-sky-200 font-mono text-[11px] font-bold uppercase tracking-wider"
              title="A new verified release is ready with DSP audio optimizations, driver stability improvements, and bug fixes."
            >
              <span
                aria-hidden="true"
                className="hw-lamp"
                data-on="cyan"
                style={{ width: 6, height: 6 }}
              />
              VERIFIED RELEASE · READY
            </div>
          )}

          {error && (
            <div className="p-3 rounded-md bg-red-950/80 border border-red-500/50 text-red-200">
              {error}
            </div>
          )}

          {downloading && (
            <div className="space-y-2">
              <div className="flex justify-between font-mono text-[11px] text-sky-300 uppercase tracking-wider">
                <span>Downloading</span>
                <span>
                  {stats && stats.bytesPerSecond > 0
                    ? `${formatBytesPerSecond(stats.bytesPerSecond)}${
                        Number.isFinite(etaSeconds) ? ` · ETA ${formatEta(etaSeconds)}` : ''
                      }`
                    : `${progress}%`}
                </span>
              </div>
              <div
                className="hw-led-track-h h-2.5 w-full rounded-full"
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Update download progress"
              >
                {Array.from({ length: 20 }).map((_, i) => {
                  const lit = progress >= ((i + 1) / 20) * 100;
                  return (
                    <span
                      key={i}
                      aria-hidden="true"
                      className="hw-led-seg"
                      data-lit={lit ? (i / 20 >= 0.8 ? 'cyan' : 'green') : undefined}
                    />
                  );
                })}
              </div>
              {stats && stats.totalBytes > 0 && (
                <p className="text-[10px] text-slate-500 font-mono tabular-nums">
                  {(stats.downloadedBytes / (1024 * 1024)).toFixed(1)} /{' '}
                  {(stats.totalBytes / (1024 * 1024)).toFixed(1)} MB
                </p>
              )}
            </div>
          )}

          {downloading && slowDownload && (
            <div className="p-3 rounded-lg border border-amber-500/50 bg-amber-950/40 text-amber-200 space-y-2">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p
                  className="leading-relaxed font-mono text-[11px] font-bold uppercase tracking-wider"
                  title={`In-app download is running at ${formatBytesPerSecond(
                    stats?.bytesPerSecond ?? 0
                  )}. Your browser is usually much faster on this network — grab it there instead.`}
                >
                  Slow · {formatBytesPerSecond(stats?.bytesPerSecond ?? 0)} · Browser Faster
                </p>
              </div>
              <button
                type="button"
                onClick={handleOpenInBrowser}
                className="px-3 py-1.5 rounded-lg hw-key !bg-none !bg-amber-600 !border-amber-400/70 !text-white hover:!bg-amber-500 font-semibold text-xs flex items-center gap-2 transition cursor-pointer uppercase tracking-wider"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Download in Browser
              </button>
            </div>
          )}

          {browserOpened && !ready && (
            <div
              className="flex items-center gap-2.5 p-3 rounded-lg border border-sky-500/40 bg-sky-950/40 text-sky-200 font-mono text-[11px] font-bold uppercase tracking-wider"
              title="Opened the installer in your browser. Once it downloads, run the file — the installer replaces the app and relaunches HKM Audio System automatically. You can close this dialog and keep mixing meanwhile."
            >
              <ExternalLink className="w-4 h-4 text-sky-400 shrink-0" />
              <span>Browser Opened · Run Installer</span>
            </div>
          )}

          {ready && (
            <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-950/40 text-emerald-200 flex items-center gap-2.5">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <p
                  className="font-semibold text-emerald-100 font-mono uppercase tracking-wider"
                  title="The updater is replacing the application files and will relaunch HKM Audio System automatically."
                >
                  Installer Launched · v{version}
                </p>
                <p className="text-[11px] font-mono uppercase tracking-wider">
                  Updating · Auto-Relaunch
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-slate-900/60 border-t border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={downloading}
              onClick={onDismiss}
              title={ready ? 'Close' : 'Remind Me Later'}
              className="px-3 py-1.5 rounded-lg border hw-key !bg-none !text-slate-300 hover:!bg-slate-800 text-xs font-medium disabled:opacity-50 transition uppercase tracking-wider"
            >
              {ready ? 'Close' : 'Later'}
            </button>
            {!downloading && !ready && (
              <button
                type="button"
                onClick={handleOpenInBrowser}
                className="px-3 py-1.5 rounded-lg border hw-key !bg-none !border-sky-700/60 !text-sky-300 hover:!bg-sky-950/60 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer uppercase tracking-wider"
                title="Download the installer with your browser instead — usually much faster on restricted networks"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Browser
              </button>
            )}
          </div>

          {!ready ? (
            <button
              type="button"
              disabled={downloading}
              onClick={handleStartUpdate}
              className="px-4 py-1.5 rounded-lg hw-key !bg-none !bg-sky-600 !border-sky-400/70 !text-white hover:!bg-sky-500 font-semibold text-xs flex items-center gap-2 shadow-lg shadow-sky-600/20 disabled:opacity-50 transition cursor-pointer uppercase tracking-wider"
            >
              {downloading ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Downloading
                </>
              ) : (
                <>
                  <ArrowDownCircle className="w-4 h-4" />
                  Download &amp; Install
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const invoke = window.__TAURI__?.core?.invoke;
                if (invoke) {
                  void invoke('restart_app').catch(() => window.location.reload());
                } else {
                  window.location.reload();
                }
              }}
              title="Restart Now"
              className="px-4 py-1.5 rounded-lg hw-key !bg-none !bg-emerald-600 !border-emerald-400/70 !text-white hover:!bg-emerald-500 font-semibold text-xs flex items-center gap-2 shadow-lg shadow-emerald-600/20 transition cursor-pointer uppercase tracking-wider"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Restart
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
