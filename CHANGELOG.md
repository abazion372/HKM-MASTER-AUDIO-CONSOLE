# Changelog

All notable changes to HKM Audio System are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
