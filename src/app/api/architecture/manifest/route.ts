import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    desktopShell: 'Tauri 2 (Rust backend + React/TypeScript UI) — web build served via Next.js',
    targetPlatforms: [
      {
        os: 'Windows 10/11 (x64)',
        status: 'Primary Target',
        audioBackends: ['WASAPI Exclusive', 'WASAPI Shared', 'ASIO 2.3'],
        installer: 'MSI / NSIS Signed',
      },
      {
        os: 'macOS 14+ (Apple Silicon & Intel)',
        status: 'Secondary Target',
        audioBackends: ['CoreAudio', 'AUHAL'],
        installer: 'Universal DMG',
      },
      {
        os: 'Linux (Ubuntu 24.04 / Debian / PipeWire)',
        status: 'Secondary Target',
        audioBackends: ['PipeWire', 'ALSA Direct', 'JACK2'],
        installer: 'AppImage / .deb',
      },
    ],
    dspEngine: 'CamillaDSP v2.x (Supervised sidecar process over WebSocket API)',
    monorepoLayout: [
      'apps/desktop (Tauri 2 + React + Tailwind)',
      'engines/audio-core (Rust WASAPI/ASIO/CoreAudio/ALSA supervisor)',
      'engines/dsp-engine (CamillaDSP config compiler & safety validator)',
      'engines/signal-analysis (4096-pt FFT, RT60, feedback & hum detectors)',
      'engines/intelligence-engine (Deterministic rules + Gemini reasoning)',
      'integrations/hardware-adapters (Yamaha MG/TF/DM3, Behringer XR18/X32, A&H SQ/AHM, Soundcraft MTK, Focusrite, Dante)',
      'integrations/obs-websocket (OBS v5 broadcast sync)',
      'integrations/rew-interop (REW .txt FR & impulse parser)',
    ],
  });
}
