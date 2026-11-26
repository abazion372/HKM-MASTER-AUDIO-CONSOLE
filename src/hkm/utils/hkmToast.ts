/**
 * Unified operator feedback layer.
 *
 * Every module used to improvise its own error surface (inline banners, silent
 * `.catch(() => {})`, console-only logs). This module wraps `sonner` with the
 * console's visual language and a single discipline:
 *
 *   - operator-visible failures (their mix/preset/audit may not be saved)
 *     raise an ERROR toast with a retry affordance,
 *   - degraded-but-recovered states raise a quiet INFO toast,
 *   - everything is mirrored into the diagnostics flight recorder so System
 *     Info → Support Log always has the full story.
 *
 * Storm control: repeated identical failures within the window collapse into
 * one toast instead of a flood (a dead server used to be invisible; it must
 * not become a strobe either).
 */
import { toast } from 'sonner';
import { diagError, diagInfo, diagWarn } from './diagnosticsLog.ts';

const REPEAT_WINDOW_MS = 15_000;
const lastShown = new Map<string, number>();

function shouldShow(key: string): boolean {
  const now = Date.now();
  const last = lastShown.get(key) ?? 0;
  if (now - last < REPEAT_WINDOW_MS) return false;
  lastShown.set(key, now);
  return true;
}

export interface PersistFailureOptions {
  /** What was at stake, e.g. "console state", "preset", "audit trail". */
  what: string;
  /** Stable key for storm control, e.g. `persist:state-sync`. */
  key: string;
  /** Optional retry callback surfaced as a toast action button. */
  retry?: () => void;
}

/**
 * A persistence write failed — the operator must know their change is only in
 * memory. Shows at most once per 15 s per key with a Retry action.
 */
export function toastPersistFailure({ what, key, retry }: PersistFailureOptions): void {
  diagError('persist', `Failed to save ${what} — change lives in memory only until re-saved.`);
  if (!shouldShow(key)) return;
  toast.error(`Could not save ${what}`, {
    description: 'The change is live in this session but was not persisted. Retry before closing the app.',
    duration: 8000,
    action: retry
      ? {
          label: 'Retry',
          onClick: retry,
        }
      : undefined,
  });
}

/** A background task failed without data at stake (worth a note, not a stop). */
export function toastBackgroundWarning(message: string, key: string): void {
  diagWarn('background', message);
  if (!shouldShow(key)) return;
  toast.warning(message, { duration: 6000 });
}

/** Positive confirmation the operator should notice (recovery, import, etc). */
export function toastSuccess(message: string, description?: string): void {
  diagInfo('ui', `Confirmed: ${message}`);
  toast.success(message, { description, duration: 4000 });
}

/** Neutral operator feedback (guidance, state changes worth a beat). */
export function toastInfo(message: string, description?: string): void {
  toast.info(message, { description, duration: 4000 });
}

/** Hard failure the operator must act on (audio engine, updates, hardware). */
export function toastError(message: string, description?: string): void {
  diagError('ui', `${message}${description ? ` — ${description}` : ''}`);
  toast.error(message, { description, duration: 7000 });
}
