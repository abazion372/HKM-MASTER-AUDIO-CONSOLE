# HKM Audio System

**Church Audio Intelligence & DSP Platform**

A 16-channel virtual sound console with WASAPI process-exclusion loopback, feedback analysis, gain-staging intelligence, and remote companion control — built for church audio teams. Runs as a web app (Next.js) and ships as a native **Windows desktop app** via Tauri 2.

[![CI](https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE/actions/workflows/ci.yml/badge.svg)](https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2B-0078D6?logo=windows)](https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Requirements](#requirements)
- [Quickstart (Web)](#quickstart-web)
- [Commands Reference](#commands-reference)
- [Project Structure](#project-structure)
- [API Surface](#api-surface)
- [Remote Companion (WebSocket Service)](#remote-companion-websocket-service)
- [Windows Desktop Deployment](#windows-desktop-deployment)
- [Environment Variables](#environment-variables)
- [Data & State](#data--state)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Overview

HKM Audio System gives front-of-house (FOH) operators a single console for the entire Sunday-morning audio workflow: capture system audio per process via WASAPI loopback, analyze feedback risk, keep every channel in a healthy gain-staging window, drive outboard/DSP routing through MIDI mappings, and let a phone-wielding companion adjust monitors from the stage — all from one screen.

The application is a standard Next.js web app during development, and the exact same build is wrapped by a Tauri 2 shell that ships as a Windows NSIS installer with a bundled self-contained server runtime.

## Features

| Area | Capabilities |
|---|---|
| **Virtual console** | 16-channel mixer with per-channel fader, mute/solo, metering, and gain-staging intelligence |
| **Audio capture** | WASAPI process-exclusion loopback — capture the stream you want (e.g. media player) and exclude processes you don't |
| **Feedback analysis** | Live feedback detection and risk analysis on captured audio |
| **Routing** | Live patchbay with input-source and output-destination drawers |
| **MIDI** | MIDI mapping editor for outboard gear and DSP control |
| **Hardware recognition** | Audio endpoint recognition/detection helpers for recognized interfaces |
| **Presets & venues** | Preset library with venue-scoped configuration |
| **Automations** | Automation engine for scripted console actions |
| **Remote companion** | FOH desktop ↔ mobile companion pairing over WebSocket with token-based security and kick control |
| **AI assistance** | AI-powered help and analysis endpoints |
| **Operations** | Audit log, health monitoring, version tracking, keyboard shortcuts |

## Architecture

```
                +-----------------------------------------------+
                |              HKM Audio System                  |
                |                                               |
  Browser  ---> |  Next.js 16 App Router (port 3000)            |
  / Tauri       |   ├─ src/hkm/  (console UI, audio, midi,      |
  WebView       |   │             plugins, store)                |
                |   ├─ /api/*    (14 REST namespaces)            |
                |   └─ Prisma + SQLite (scaffold auth models)    |
                |                                               |
                |   JSON store: db/hkm-state.json               |
                |   (single source of truth, shared)            |
                |        ^            ^                         |
                |        |            |                         |
                |  Next.js API   Bun WebSocket mini-service     |
                |                 (port 3030)                   |
                |                 /ws?role=desktop              |
                |                 /ws?role=mobile&token=...     |
                +-----------------------------------------------+

  Windows desktop: Tauri 2 shell (NSIS installer)
   ├─ WebView2 renders the Next.js UI
   └─ Bundled bun runtime (hkm-server.exe) runs the
      Next.js standalone server locally
```

Both the Next.js server and the WebSocket mini-service read/write the same JSON store (`db/hkm-state.json`), so the web API layer and the realtime layer always operate on one source of truth.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript 5 (strict) |
| Styling | Tailwind CSS 4 + shadcn/ui (48 components, New York style) |
| State | Zustand (client), TanStack Query (server) |
| Data | Prisma 6 + SQLite (scaffold), JSON file store (console state) |
| Realtime | Bun WebSocket mini-service (port 3030) |
| Desktop | Tauri 2 (Rust, NSIS bundling, WebView2) |
| Charts / Motion | Recharts, Framer Motion |
| AI | z-ai-web-dev-sdk (server-side only) |
| Package manager | Bun |

## Requirements

**For web development:**
- [Bun](https://bun.sh) 1.1+ (recommended — the WS mini-service requires it)
- Or Node.js 20+ / npm (web-only; WebSocket service needs Bun)

**For Windows desktop builds (additional):**
- Windows 10 or 11 (x64)
- [Rust](https://rustup.rs) toolchain with the `x86_64-pc-windows-msvc` target
- Microsoft C++ Build Tools (linker for Rust/MSVC)
- WebView2 Runtime (installer downloads it automatically if missing)

## Quickstart (Web)

```bash
# 1. Clone
git clone https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE.git
cd HKM-MASTER-AUDIO-CONSOLE

# 2. Install dependencies
bun install

# 3. Configure environment (defaults work out of the box)
cp .env.example .env   # or edit the existing .env

# 4. Set up the database
bun run db:generate
bun run db:push

# 5. Start the app
bun run dev
# → http://localhost:3000
```

To enable **remote companion** (mobile pairing) features, also start the WebSocket service in a second terminal:

```bash
cd mini-services/audio-ws
bun run dev
# → ws://localhost:3030/ws
```

## Commands Reference

| Command | Description |
|---|---|
| `bun run dev` | Start Next.js dev server on port 3000 (logs to `dev.log`) |
| `bun run build` | Production build → `.next/standalone` (self-contained server) |
| `bun run start` | Run the production standalone server with Bun |
| `bun run lint` | ESLint over the whole project |
| `bun run db:push` | Push Prisma schema to SQLite (fast iteration) |
| `bun run db:generate` | Generate the Prisma client |
| `bun run db:migrate` | Create/apply a dev migration |
| `bun run db:reset` | Reset database and re-apply migrations |
| `bun run desktop:dev` | Run the Tauri desktop shell in dev mode |
| `bun run desktop:build` | Build the Windows installer (see below) |
| `bun run desktop:fetch-server` | Download the bundled Bun Windows runtime |
| `bun run desktop:icons` | Regenerate the full icon set from `app-icon.png` |

## Project Structure

```
HKM-MASTER-AUDIO-CONSOLE/
├─ src/
│  ├─ app/
│  │  ├─ page.tsx              # Entry — dynamic-imports the HKM console
│  │  ├─ layout.tsx            # Root layout & metadata
│  │  └─ api/                  # REST API namespaces
│  │     ├─ ai/  architecture/  audit/  automations/
│  │     ├─ hardware/  health/  keyboard-shortcuts/
│  │     ├─ midi-mappings/  network/  presets/
│  │     └─ remote/  state/  venue/  versions/  route.ts
│  ├─ hkm/                     # The console application module
│  │  ├─ App.tsx               # Root console component
│  │  ├─ audio/                # Audio engine & analysis
│  │  ├─ components/           # Console UI (panels, drawers, patchbay)
│  │  ├─ data/                 # Hardware catalog & static data
│  │  ├─ midi/                 # MIDI mapping engine
│  │  ├─ plugins/              # Plugin system
│  │  ├─ services/             # Domain services
│  │  ├─ store/                # Zustand stores
│  │  ├─ types/                # Shared TypeScript types
│  │  └─ utils/                # Helpers (naming, hardware recognition...)
│  ├─ lib/
│  │  ├─ hkm-store.ts          # JSON state store (single source of truth)
│  │  ├─ hkm-relay.ts          # Bridge to the WebSocket mini-service
│  │  ├─ hkm-hardware.ts       # Hardware endpoint detection
│  │  └─ db.ts                 # Prisma client (scaffold models)
│  └─ components/ui/           # shadcn/ui primitives (48 components)
├─ mini-services/
│  └─ audio-ws/                # Bun WebSocket service (port 3030)
├─ src-tauri/                  # Tauri 2 desktop shell
│  ├─ tauri.conf.json          # Bundle config (NSIS, resources, icons)
│  ├─ Cargo.toml               # Rust project
│  ├─ binaries/                # Bundled server runtime (hkm-server.exe)
│  └─ icons/                   # Full Windows + Android icon set
├─ scripts/
│  ├─ fetch-bun-server.mjs     # Download Bun windows-x64 runtime
│  ├─ make-icons.mjs           # Generate icon set
│  └─ prepare-desktop.mjs      # Pre-bundle checks (runs before tauri build)
├─ prisma/schema.prisma        # Data models (User/Post scaffold)
├─ db/                         # custom.db + hkm-state.json (runtime data)
└─ public/                     # Static assets
```

## API Surface

REST namespaces under `/api`:

| Namespace | Domain |
|---|---|
| `/api/state` | Console state read/persist (JSON store) |
| `/api/hardware` | Audio endpoint detection & recognition |
| `/api/presets`, `/api/venue` | Preset library and venue configuration |
| `/api/midi-mappings` | MIDI map CRUD |
| `/api/remote` | Companion pairing, kick, client list |
| `/api/ai` | AI assistance (server-side SDK) |
| `/api/automations` | Automation definitions and runs |
| `/api/audit`, `/api/versions`, `/api/health` | Audit trail, version tracking, health checks |
| `/api/keyboard-shortcuts` | Shortcut configuration |
| `/api/architecture`, `/api/network` | System architecture & network utilities |

## Remote Companion (WebSocket Service)

The FOH remote-companion realtime protocol runs in `mini-services/audio-ws` (Bun, port 3030):

- Desktop consoles connect to `/ws?role=desktop`
- Mobile companions connect to `/ws?role=mobile&token=<pairing token>`
- The Next.js server talks to the service over localhost-only internal endpoints (`/internal/broadcast`, `/internal/clients`, `/internal/kick-mobile`, ...)

Both processes share `db/hkm-state.json` — one source of truth for the whole system.

```bash
cd mini-services/audio-ws
bun run dev      # dev mode with hot reload
bun run start    # production mode
```

## Windows Desktop Deployment

The desktop app is the same Next.js production build, wrapped in a Tauri 2 shell and shipped as an NSIS installer (`currentUser` install — no admin rights required).

### One-time setup

1. Install the [Rust MSVC toolchain](https://rustup.rs) and Microsoft C++ Build Tools.
2. Confirm Tauri CLI is available (bundled as `@tauri-apps/cli` dev dependency).

### Build the installer

```bash
# 1. (Recommended) Bundle the self-contained server runtime
bun run desktop:fetch-server
#    Downloads official Bun windows-x64 → src-tauri/binaries/hkm-server.exe
#    Skip with: node scripts/prepare-desktop.mjs --skip-bun
#    (app then falls back to a system node/bun install at runtime)

# 2. Build
bun run desktop:build
#    Runs: next build → prepare-desktop.mjs → tauri build

# 3. Installer location
#    src-tauri/target/release/bundle/nsis/HKM Audio System_0.2.1_x64-setup.exe
```

### What the installer includes

- The Tauri shell with full icon set and WebView2 bootstrapper (auto-downloads WebView2 if missing)
- The Next.js standalone server (`.next/standalone` → `next-server` resource)
- The bundled Bun runtime (`hkm-server.exe`) so the app runs with **zero external dependencies**

### Development mode

```bash
bun run desktop:dev   # launches the Tauri shell against the dev server
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:../db/custom.db` | SQLite file for Prisma (resolved relative to `prisma/schema.prisma`) |
| `HKM_DATA_DIR` | `<repo>/db` | Directory holding `hkm-state.json` |
| `HKM_WS_SERVICE` | `http://127.0.0.1:3030` | Origin of the WebSocket mini-service |

See [`.env.example`](.env.example) for a template.

## Data & State

- **`db/hkm-state.json`** — the live console state and the single source of truth shared by the Next.js API layer and the WebSocket service.
- **`db/custom.db`** — SQLite database for the Prisma scaffold models (User/Post).

The store is cached in-process and re-read on modification time change (`src/lib/hkm-store.ts`), so both processes always see current state.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` on port 3000 | Another dev server is running — stop it or change the port |
| Remote pairing does nothing | The WebSocket service is not running — `cd mini-services/audio-ws && bun run dev` |
| `bun: command not found` in mini-service | Install Bun — the WS service requires it (Node cannot run it) |
| Desktop build: `link.exe not found` | Install Microsoft C++ Build Tools and reopen the terminal |
| Desktop build: WebView2 errors | Let the NSIS bootstrapper install it, or install the WebView2 Runtime manually |
| Prisma `did not initialize yet` | Run `bun run db:generate` then `bun run db:push` |
| State looks stale | `hkm-state.json` is shared state — restart both the app and the WS service |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and the pull request process.

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE).
