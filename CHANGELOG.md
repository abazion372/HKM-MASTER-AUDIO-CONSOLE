# Changelog

All notable changes to HKM Audio System are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Real-world instrument input (guitar/bass) — MIC / LINE / INST input source switch**: every channel strip now carries the physical console input section exactly like an Allen & Heath ZED or interface Hi-Z "INST" engagement. Each strip's Row 0 is a 3-segment MIC/LINE/INST selector plus 48V / PAD / Ø hardware buttons with true interlock semantics:
  - **MIC** (+48V capable): mic preamp gain +0..+60 dB, phantom power available.
  - **LINE**: line trim −12..+12 dB around unity (jack domain, phantom locked out).
  - **INST (Hi-Z ≥1MΩ)**: instrument gain +8..+55 dB for guitar/bass pickups — phantom **hard-locked and auto-disengaged** on switch (48V into an instrument or unprotected DI destroys it, exactly the interlock smart consoles implement).
  - Switching modes auto-rescales the stored preamp gain into the new mode's silkscreen range; PAD (−20 dB) and polarity Ø apply to the real DSP chain in every mode.
- **Instrument Rig Checklist**: when the focused channel runs INST, the Phase 1 · Stage Preamp deck shows the real-world guitar rig checklist (Hi-Z/INST jack or DI, phantom warning, −6 dBFS strum target, ground-lift hum discipline, PAD for hot pedalboards).
- **Electric Guitar (Worship Rig) instrument profile** in the Band module: Hi-Z source type, amp-mud/fizz EQ hints, single-coil level expectations, and DI ground-lift diagnostics.

### Changed

- **Gain Staging Assistant is input-mode aware**: INST channels stage to the −16 dBFS instrument domain (others follow the console nominal target), verdict guidance speaks instrument language (single-coil quietness, transient headroom, pedalboard clipping), and Auto-Stage clamps into each mode's gain range.
- **Phase 1 · Stage Preamp**: header now carries the input-mode domain chip (MIC · 48V READY / LINE · ±12 dB / INST · Hi-Z 1MΩ), the preamp knob re-labels and re-ranges per mode, and +48V is interlocked off non-mic domains.

## [0.2.37] - 2026-11-24

### Added

- **Signed in-app silent updates**: `bundle.createUpdaterArtifacts` is now enabled, so every release ships `latest.json` plus minisign `.sig` signatures. Installed apps auto-detect new versions, download, cryptographically verify against the embedded public key, and update themselves in place — no browser download needed anymore.

### Changed

- **Channel fader bay moved into the left input panel**: the center console deck no longer carries the full-width 285px motorized fader bank at the bottom — the phase processing rack (Preamp, HPF & Gate, PEQ, Comp, GEQ, Xover, Matrix) now owns the full center height. Each left-panel channel strip is now a complete console strip: calibrated dB scale, precision vertical fader (-48..+10 dB), 10-segment LED meter, preamp gain trim, Mute/Solo, and MAIN/STRM/SUB bus assign keys — selection, metering, level, gain and routing all in one place. Left panel widened 214px → 272px (300px at 2xl) to host the strips.

## [0.2.36] - 2026-11-24

### Fixed

- **Console phase tabs fully labeled**: the 7 signal-flow tabs (PREAMP, HPF & GATE, 4-BAND PEQ, VCA COMP, 31-BAND GEQ, 3-WAY XOVER, MATRIX & PA) previously truncated to ellipses ("1. P…", "2. HP…") and hid their live value readouts below XL screen width. They are now two-line hardware strips — full processor name on top, live value below — that stretch evenly on wide screens and scroll on narrow ones instead of clipping, readable from across the room. Added full tooltips and `aria-current` for accessibility.

## [0.2.2] - 2026-11-24

### Fixed (24/7 quiet-operation resource audit)

- **OBS write amplification**: volatile OBS telemetry (bitrate, dropped frames, CPU %, timecode) no longer flows into the persisted session state. A connected OBS previously caused a full ~250KB state PUT + JSON store rewrite every ~2 seconds around the clock (~10GB/day of disk writes on always-on machines)
- **JSON store writes**: compact serialization (~35% fewer bytes per write) plus a skip-when-identical guard; remote token/permission changes still persist immediately via a dedicated non-deduplicated path
- **State sync**: the client now skips `/api/state/sync` PUTs when the persistable payload is unchanged, so React state identity churn never reaches the disk
- **WebSocket service**: telemetry frames are no longer serialized when no mobile companion is attached; desktop consoles receive a trimmed `state:full` (remoteAccess only, ~280B instead of ~256KB); `state:sync` broadcasts are no longer echoed to desktop clients that ignore them
- **Spectrum churn**: silent inputs no longer commit new spectrum Float32Array objects at 5Hz
- **Render load**: `TopBar` is memoized with stabilized callback props, preventing full shell re-renders at telemetry cadence
- **State growth**: in-memory configuration snapshots capped at 30

## [0.2.1] - 2026-11-24

### Added
- Tauri 2 desktop shell (`src-tauri/`) with NSIS bundling, `currentUser` install mode, and WebView2 bootstrapper
- Full icon set (Windows Store logos, standard PNG sizes, Android mipmaps) generated via `scripts/make-icons.mjs`
- `scripts/fetch-bun-server.mjs` — downloads the official Bun windows-x64 runtime and installs it as `src-tauri/binaries/hkm-server.exe` for a self-contained desktop server
- `scripts/prepare-desktop.mjs` — pre-bundle verification (standalone server, binaries dir, runtime fetch with `--skip-bun` escape hatch)
- Desktop npm scripts: `desktop:dev`, `desktop:build`, `desktop:fetch-server`, `desktop:icons`
- Documentation suite: README, CHANGELOG, CONTRIBUTING, SECURITY, LICENSE, GitHub issue/PR templates, CI workflow
- `.gitattributes` and `.editorconfig` for consistent line endings across Windows builds

### Changed
- Package metadata aligned with the product (name, description, repository, license)

## [0.2.0] - 2026-11-24

### Added
- Live patchbay with input-source and output-destination drawers
- Console left panel: channel strips, metering, and gain-staging intelligence
- Audio naming utilities for endpoint labeling
- WebSocket remote-companion mini-service (`mini-services/audio-ws`, port 3030) with desktop/mobile roles, pairing tokens, and internal control endpoints
- REST API namespaces: `ai`, `architecture`, `audit`, `automations`, `hardware`, `health`, `keyboard-shortcuts`, `midi-mappings`, `network`, `presets`, `remote`, `state`, `venue`, `versions`
- Build/dev tooling under `.zscripts/`

## [0.1.0] - 2026-11-24

### Added
- Initial project scaffold: Next.js 16 (App Router) + TypeScript + Tailwind CSS 4 + shadcn/ui
- HKM console application module (`src/hkm/`): audio engine, components, hardware catalog, MIDI, plugins, services, stores, types, utils
- JSON state store with in-process caching (`src/lib/hkm-store.ts`)
- Prisma schema (User/Post scaffold models) with SQLite datasource
- Hardware endpoint recognition utilities

[Unreleased]: https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/abazion372/HKM-MASTER-AUDIO-CONSOLE/releases/tag/v0.1.0
