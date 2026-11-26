'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ClipboardCopy, ShieldCheck } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  info: string | null;
  errorCount: number;
  copied: boolean;
}

/**
 * Global crash containment for the console surface. A render crash in any
 * module used to leave a dead white screen mid-service; the boundary keeps the
 * chassis alive, surfaces the failing component stack, and offers one-click
 * recovery (state is persisted by the session store, so a reload restores the
 * mix). Async errors (promise rejections, window.onerror) are captured and
 * logged for diagnostics without taking the console down.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, info: null, errorCount: 0, copied: false };
    this.handleWindowError = this.handleWindowError.bind(this);
    this.handleRejection = this.handleRejection.bind(this);
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Full diagnostics to the console for support extraction.
    console.error('[HKM] Console render crash contained:', error, errorInfo.componentStack);
    this.setState((s) => ({
      info: errorInfo.componentStack ?? null,
      errorCount: s.errorCount + 1,
    }));
  }

  componentDidMount() {
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleRejection);
  }

  componentWillUnmount() {
    window.removeEventListener('error', this.handleWindowError);
    window.removeEventListener('unhandledrejection', this.handleRejection);
  }

  private handleWindowError(event: ErrorEvent) {
    console.error('[HKM] Uncaught error:', event.message, event.error ?? '');
  }

  private handleRejection(event: PromiseRejectionEvent) {
    console.error('[HKM] Unhandled promise rejection:', event.reason ?? '');
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleCopyDiagnostics = async () => {
    const { error, info, errorCount } = this.state;
    const diagnostics = [
      'HKM Audio System — crash diagnostics',
      `version: ${typeof window !== 'undefined' ? window.location.href : 'n/a'}`,
      `occurrences: ${errorCount}`,
      '',
      `error: ${error?.message ?? 'n/a'}`,
      error?.stack ?? '',
      '',
      `component stack:${info ?? ' n/a'}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(diagnostics);
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      console.error(diagnostics);
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const { error, info, copied } = this.state;
    return (
      <div className="min-h-screen bg-[#0A0E15] text-slate-100 flex items-center justify-center p-4">
        <div
          className="w-full max-w-xl rounded-xl border border-amber-500/40 bg-[#0D1219] shadow-2xl overflow-hidden"
          role="alertdialog"
          aria-modal="true"
          aria-label="Console error recovery"
        >
          <div className="px-5 py-4 bg-gradient-to-r from-amber-950/60 to-slate-900 border-b border-amber-500/30 flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-amber-500/15 text-amber-400 border border-amber-400/30">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm tracking-wide text-white">
                CONSOLE MODULE FAULT — RECOVERY AVAILABLE
              </h3>
              <p className="text-xs text-amber-200/80">
                The crash was contained. Your console state is persisted and survives the reload.
              </p>
            </div>
          </div>

          <div className="p-5 space-y-4 text-xs">
            <div className="p-3 rounded-lg border border-slate-800 bg-[#06090F] max-h-48 overflow-y-auto font-mono text-[11px] text-slate-300">
              <p className="text-amber-300 font-semibold mb-1.5">{error.message}</p>
              {info && <pre className="whitespace-pre-wrap text-slate-500">{info}</pre>}
            </div>
            <div className="flex items-start gap-2.5 text-slate-300">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                Reload restores the full console from the persisted session — mixer state, presets,
                zones and DSP settings all come back. If the fault repeats, copy the diagnostics and
                reload; the faulting module can be skipped while the rest of the console runs.
              </p>
            </div>
          </div>

          <div className="px-5 py-3.5 bg-slate-900/60 border-t border-slate-800 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={this.handleCopyDiagnostics}
              className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs font-medium flex items-center gap-2 transition cursor-pointer"
            >
              <ClipboardCopy className="w-3.5 h-3.5" />
              {copied ? 'Copied' : 'Copy Diagnostics'}
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs flex items-center gap-2 transition cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload Console
            </button>
          </div>
        </div>
      </div>
    );
  }
}
