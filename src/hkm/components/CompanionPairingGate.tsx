import React, { useEffect, useState } from 'react';
import { Monitor, Sliders } from 'lucide-react';

interface CompanionPairingGateProps {
  /** Called with the manually entered pairing token (max 16 chars). */
  onConnect: (token: string) => void;
  /** Clears remote mode and returns to the full desktop console. */
  onOpenDesktop: () => void;
  /** Fatal link error (invalid token, session revoked, token rotated). */
  errorMessage?: string | null;
}

/**
 * Landing card shown when a phone opens `?mode=remote` without a valid
 * pairing token (or after a fatal pairing rejection). Keeps phones out of
 * the full desktop console until they are paired with the FOH host.
 */
export const CompanionPairingGate: React.FC<CompanionPairingGateProps> = ({
  onConnect,
  onOpenDesktop,
  errorMessage,
}) => {
  const [tokenInput, setTokenInput] = useState('');

  // Companion-only service worker (PWA installability). The desktop console
  // never mounts this view, so it never registers a SW. Registered here too
  // so the app is installable straight from the pairing screen.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  // Pairing tokens are 16-char base64url strings; strip whitespace only so
  // mixed-case tokens are preserved verbatim (comparison is exact).
  const sanitized = tokenInput.replace(/\s+/g, '');
  const canConnect = sanitized.length >= 8;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConnect) return;
    onConnect(sanitized);
  };

  return (
    <div className="min-h-screen bg-[#080B10] text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="rounded-xl border border-slate-800 bg-[#0E1524] p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <Sliders className="w-5 h-5 text-sky-400" />
            <h1 className="font-display text-lg font-semibold text-white">
              HKM FOH Companion
            </h1>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Scan the pairing QR code shown in the desktop console (Hardware &amp;
            Diagnostics → Remote Access) to link this device, or enter the
            16-character pairing token manually.
          </p>

          {errorMessage && (
            <div
              role="alert"
              className="p-3 rounded-lg border border-red-500/40 bg-red-950/40 text-xs font-mono text-red-200"
            >
              {errorMessage}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <label
              htmlFor="companion-pairing-token"
              className="block font-mono text-[10px] text-slate-400 uppercase"
            >
              Pairing Token
            </label>
            <input
              id="companion-pairing-token"
              name="pairing-token"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              maxLength={16}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value.replace(/\s+/g, ''))}
              placeholder="PAIRING TOKEN"
              className="w-full h-11 px-3 rounded-lg border border-slate-700 bg-[#070A10] font-mono text-center text-sm tracking-widest text-white focus:outline-none focus:border-sky-400"
            />
            <button
              type="submit"
              disabled={!canConnect}
              className="w-full h-11 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:hover:bg-sky-600 text-white font-mono text-xs font-semibold uppercase"
            >
              Connect
            </button>
          </form>
        </div>

        <button
          type="button"
          onClick={onOpenDesktop}
          className="w-full h-11 rounded-lg border border-slate-700 bg-[#0E1524] text-slate-300 font-mono text-xs flex items-center justify-center gap-2"
        >
          <Monitor className="w-4 h-4" />
          <span>Open Desktop Console</span>
        </button>
      </div>
    </div>
  );
};
