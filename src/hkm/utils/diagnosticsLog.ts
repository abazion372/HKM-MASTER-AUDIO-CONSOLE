import { APP_VERSION } from '../components/AppMenuBar.tsx';

/**
 * In-memory diagnostics ring buffer — the app's flight recorder.
 *
 * Production webviews have no visible console, so async errors captured by the
 * global handlers (and failures the user must know about: persistence loss,
 * engine faults, update errors) are recorded here with timestamps and levels.
 * The buffer is surfaced in Hardware Diagnostics → WATCHDOG → SUPPORT LOG and
 * folded into every "copy diagnostics" payload (crash card + support log).
 *
 * Kept deliberately dependency-free and synchronous: recording a diagnostic
 * must never itself be able to fail.
 */

export type DiagLevel = 'error' | 'warn' | 'info';

export interface DiagEvent {
  /** ISO timestamp of when the event was recorded. */
  ts: string;
  level: DiagLevel;
  /** Short subsystem tag, e.g. `persist`, `engine`, `obs`, `updater`, `ui`. */
  source: string;
  message: string;
}

const MAX_EVENTS = 250;

const events: DiagEvent[] = [];
const listeners = new Set<() => void>();

/** Append `console.*` prefixes so developers keep seeing events in dev tools. */
const consoleFor: Record<DiagLevel, (message: string, ...rest: unknown[]) => void> = {
  error: console.error,
  warn: console.warn,
  info: console.info,
};

export function logDiagEvent(level: DiagLevel, source: string, message: string): void {
  const event: DiagEvent = {
    ts: new Date().toISOString(),
    level,
    source,
    message: message.slice(0, 600),
  };
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  try {
    consoleFor[level](`[HKM:${source}] ${message}`);
  } catch {
    // console access itself failed (exotic embedding) — recording still succeeded.
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken listener must not break the recorder.
    }
  }
}

/** Convenience wrappers so call sites read naturally. */
export const diagError = (source: string, message: string) => logDiagEvent('error', source, message);
export const diagWarn = (source: string, message: string) => logDiagEvent('warn', source, message);
export const diagInfo = (source: string, message: string) => logDiagEvent('info', source, message);

/** Snapshot of the recorded events (oldest first). */
export function getDiagEvents(): readonly DiagEvent[] {
  return events;
}

/** Subscribe to buffer changes (for live log views). Returns an unsubscribe fn. */
export function subscribeDiagEvents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Assemble a full support report: app version, platform, uptime and the
 * recorded event log. Used by the crash card, the Support Log panel and any
 * future export-to-file path.
 */
export function getDiagnosticsReport(contextTitle = 'support log'): string {
  const lines: string[] = [
    `HKM Audio System — ${contextTitle}`,
    `app version: ${APP_VERSION}`,
    `platform: ${getPlatformSummary()}`,
    `generated: ${new Date().toISOString()}`,
    `page uptime: ${Math.round(performance.now() / 1000)}s`,
    `events recorded: ${events.length}`,
    '',
    '--- event log (oldest first) ---',
  ];
  if (events.length === 0) {
    lines.push('(no events recorded this session)');
  } else {
    for (const e of events) {
      lines.push(`${e.ts} [${e.level.toUpperCase()}] ${e.source}: ${e.message}`);
    }
  }
  return lines.join('\n');
}

function getPlatformSummary(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  // Tauri WebView2 on Windows reports "Windows NT 10.0" — keep it short.
  const os = /Windows NT ([\d.]+)/.exec(ua)?.[1]
    ? `Windows NT ${/Windows NT ([\d.]+)/.exec(ua)![1]}`
    : /Android/.exec(ua)?.[0]
      ?? /Mac OS X/.exec(ua)?.[0]
      ?? /Linux/.exec(ua)?.[0]
      ?? 'unknown';
  const tauri = '__TAURI_INTERNALS__' in window ? ' · tauri webview' : ' · browser';
  return `${os}${tauri} · ${ua.slice(0, 120)}`;
}
