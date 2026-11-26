# Changelog

All notable changes to HKM Audio System are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.5] - 2026-11-26 — One Input Strip, Zero Duplication: the Channel Bay

### Changed

- **The left input panel no longer repeats the central strip.** The old "super input strip" duplicated the Central DSP Chain's INPUT CONDITIONING card control-for-control (preamp knob, 48V/PAD/Ø, fader, mute) — two places to look, two places to forget. Every per-channel control now lives **exactly once**, in the INPUT CONDITIONING card: the **INPUT SOURCE selector (MIC / LINE / INST)** moved in at the top of the column, joined by the input-domain silkscreen badge (**MIC XLR / LINE TRS / INST 1MΩ**), the mode gain-range note, a **SOLO key beside ACTIVE**, and the **MIX BUS assign keys (MAIN PA / STREAM / SUB)** below the fader. The preamp knob and gain arc are now **mode-aware** — they re-scale to the selected domain's silkscreen range (MIC +0..+60, LINE −12..+12 trim, INST +8..+55), and the arc position follows the mode range instead of a fixed 0..60.

- **The freed left-panel space became the CHANNEL BAY — the whole input bank at a glance.** One live row per channel: channel number chip with mute/solo state LEDs, name + hardware source label, live RMS readout, an animated horizontal meter with peak-hold tick, the input-mode badge, preamp/fader position, and three mix-bus assign LEDs — plus quick per-row **M/S (mute/solo) keys** and click-anywhere-to-focus (the row loads into the central console strip, X32 channel-bay style). A `live/total` counter in the bay header shows how many inputs are flowing. The panel finally answers "what is happening on every input right now" — something the single-channel strip never could.

### Fixed

- **+48V now carries the mic-domain hardware interlock everywhere.** Switching a channel out of MIC mode auto-disengages phantom power (exactly like smart consoles — sending +48V into a guitar or unprotected DI can destroy it), and the 48V key is physically locked out on LINE and INST with an explanatory tooltip. Previously the central card allowed engaging phantom on any mode.
- **Open-slot guidance is now actionable**: the identity header's "OPEN SLOT" note is a one-tap button that opens the hardware input patch tray directly below, instead of passive text. The patch tray now starts collapsed so the Channel Bay owns the panel space until patching is needed.
- **Mix-bus keys stay on one line** and the fader cap at its minimum position no longer grazes the bus keys — measured 8 px clearance at 1366×768 and 1600×900, with zero card overflow at both sizes.

## [1.1.4] - 2026-11-26 — Unmistakable Mute States & the 5 ms Exclusive Floor

### Fixed

- **A muted input no longer looks "engaged".** The channel MUTE pill in the Central DSP Chain (INPUT CONDITIONING column) rendered its MUTED state as a **cyan glowing pill** — the same colour family the console uses for *active/selected*, so a silenced channel read as highlighted. Muted is now unmissable by hardware-console convention: a **solid red pill** with speaker-X icon, diagonal "red-tape" stripes (the way engineers physically tape over muted faders), a steady breathing glow, a red **MUTED** badge beside *Selected CH#* in the column header, an **INPUT MUTED** readout in the gain arc, a **red routing seam** under the column, and a dimmed preamp/fader so the whole column reads as a dead channel. ACTIVE stays green; OPEN SLOT stays gray.
- **The left-console channel strip now tells the same story**: the MUTE key latches red with the icon + stripes, the channel identity header tints red with a pulsing speaker-X status, the super fader goes dark (a muted channel is a dead channel — like real consoles), and the channel tab in the rail carries a red strike-through and base bar so muted channels are identifiable at a glance from the tab rail alone.
- **Footer MUTE ALL and BYPASS DSP are now persistent latching console switches** instead of popping buttons: constant silkscreen labels (no more MUTE ALL ↔ UNMUTE ALL or BYPASS DSP ↔ DSP BYPASSED text swaps), hardware state LEDs (dark = live, glowing = engaged), fixed label widths (measured 140/156 px in both states — zero layout shift), smooth 200 ms transitions and a calm breathing glow when engaged. The same pattern is applied to SAFE MUTE in the top bar, the Master Preview dock, the right telemetry panel and the DSP engine module, so every master-mute control in the app behaves identically.
- **Every state toggle is now a first-class switch for assistive tech**: `aria-pressed` plus descriptive labels ("Channel 1 mute — currently MUTED (click to unmute)") on the chain pill, strip MUTE key, channel tabs and all master-mute buttons; the breathing glow is disabled under `prefers-reduced-motion`.
- **Pre-existing lint blocker removed**: the session store's state-sync retry closure captured its own `useCallback` binding (react-hooks/immutability). Rewritten as a local attempt function — retry semantics unchanged.

### Changed

- **Exclusive-mode latency floor 10 ms → 5 ms**: the WASAPI period/format ladder now attempts a 5 ms f32 period first — on DACs that accept it, exclusive mode's queued period (and therefore its latency) is halved. Devices that reject it fall through the existing 10 → 20 ms / PCM16 ladder automatically, and the armed period remains visible in the status line (`exclusive 2ch/32bit · 5ms f32 (240 frames/period)`).
- **Final zero-latency audit — every remaining millisecond accounted for**: the shared-mode adaptive target (5 ms) was re-verified as the true floor (the write-to-target discipline makes playback time independent of poll interval, so only underrun tolerance is at stake — and it is already sized to the measured browser/IPC jitter); the loopback cushion's adaptive start (10 ms → 4 ms floor) was re-verified against the Windows 10 ms packet cadence; the output tap remains at the 128-frame render-quantum spec floor. The complete stage-by-stage ledger is now documented in the `win_audio.rs` module docs.

### Added

- **`docs/AUDIO-LATENCY.md`** — a user-facing guide: the latency table for every path (shared/exclusive, desktop-audio vs mic), where each millisecond lives and why it cannot be lower on Windows, how to reach the floor (exclusive mode, zero alignment delays, direct monitoring), and how to judge sync correctly (clap-and-listen, not video lips — the video decoder adds its own delay that no audio app can match).
- **Crash-recovery, diagnostics and update tooling re-audited** as part of a maturity pass (loopback-only local server, token-gated remote companion, persisted-session recovery and diagnostics export all confirmed in place).

## [1.1.3] - 2026-11-26 — Persistent Ring Indicator, Zero-Default Delays & Crash Containment

### Fixed

- **The red RING badge no longer pops on/off**: it strobed (`animate-pulse`) and vanished/reappeared with every analysis frame that dipped below the detection threshold. Redesigned per alert-UI best practice: a confirmed ring **latches for 8 s** after it stops (steady, readable, keeps its frequency), severity escalates through **CLEAR → WATCH → RING** (gray NO RING → amber resonance-building → solid red) with smooth 500 ms color transitions, and every badge site is a **persistent slot** — always present in the same position, no layout pop-in. Console right panel (both tabs), feedback analyzer header + confidence gauge, sidebar badge and FFT critical-frequency markers all ride the same latched state.
- **Zone/crossover alignment delays no longer ship pre-applied**: sub 4.5 ms, high 0.8 ms, zone-sub 1.2 ms, rear balcony 48.1 ms and foyer 64.1 ms defaults are all now 0 — input and output are 100 % time-aligned out of the box. Alignment delay is strictly opt-in per zone (the distance-based tools remain). These pre-applied defaults were the bulk of the "remaining few ms" listeners could still hear.
- **Loopback worklet cushion is adaptive**: starts at 10 ms (the Windows engine's packet cadence), decays toward a 4 ms floor after sustained clean cycles, and grows +2 ms on starvation up to 15 ms so jittery machines self-heal instead of stuttering. Surge ceiling 50 → 25 ms.

### Added

- **Crash containment (ErrorBoundary)**: a render crash in any console module used to leave a dead white screen mid-service. The app root now catches the fault, keeps a recovery card alive with the failing component stack, and offers one-click reload — the persisted session restores the full mix — plus copy-diagnostics. Global `window.onerror` / `unhandledrejection` capture feeds the support log.

## [1.1.2] - 2026-11-26 — Deep Latency Pass & Fast-Browser Update Path

Second latency pass after 1.1.1's audit: a full stage-by-stage ledger showed the shared path still carried ~40 ms and the exclusive path 20–40 ms by design of the pumps, plus 10 ms of batching in the raw tap. Everything controllable is now at its floor.

### Fixed

- **Shared raw output still sat ~40 ms before the DAC**: the pump kept the 40 ms endpoint buffer topped off eagerly (same disease as the old 200 ms bug, smaller dose). New adaptive writer holds the endpoint at a small padding target (starts ≈5 ms) and writes only what is needed to reach it; on a proven underrun the target grows by 5 ms steps up to half the buffer, so jittery machines self-heal instead of glitching. Startup prefill is the target, not the whole buffer. Poll 3 → 2 ms; pending backlog anchor tightened (cap 40 → 20 ms, watermark 10 → 2 ms).
- **Exclusive WASAPI period 20 ms → 10 ms** (the period is the latency — one period is always queued), with a new period/format ladder that auto-falls back to 20 ms f32 / 10 ms pcm16 / 20 ms pcm16 when a device rejects the floor, so arming can no longer fail on period pickiness. Pending anchor: >2 periods → 1 period (20–40 ms queued) becomes >1.5 periods → half a period (≈5 ms).
- **Raw output tap batching 10 ms → 2.7 ms** (128 frames — one render quantum per post); the PCM queue's worst transient drops from 160 ms to 43 ms.
- Net: output-side controllable latency ~50–90 ms → ~8–15 ms worst case (≈8 ms typical). The remaining floor is structural: the Windows engine's 10 ms packet cadence (the loopback cushion is cadence-matched to it — cutting it causes rhythmic stutter) and the source application's own output latency, which no downstream app can remove.

### Added

- **Update dialog: live speed / ETA / MB progress** — the in-app download now shows real throughput instead of a bare percentage.
- **"Download in Browser (fast)"** — diagnosis showed the fast few-second updates of the v0.2.x/v1.0.x era were actually the browser fallback (BOM'd manifests made the in-app updater no-op); now that manifests are clean the in-app Rust downloader runs, and on networks where non-browser processes are throttled (AV HTTPS inspection / DPI / proxies) it crawls while the browser is fast. The dialog auto-detects sustained slow downloads (<250 KB/s) and offers the browser path, plus an always-available Browser button. Same installer, same signature, same auto-update behaviour.

## [1.1.1] - 2026-11-26 — Zero Unintended Latency & True Whole-DSP Bypass

System audio is now in tight sync with the source everywhere — the only delay left in the signal path is delay you configure on purpose (zone alignment / user delayMs). Full audit of the capture → DSP → render chain removed every buffer that silently added latency by default.

### Fixed

- **End-to-end system audio latency (the "everything is delayed" default)**:
  - Shared raw output kept a **200 ms endpoint buffer permanently topped off** — every block sat ~200 ms before the DAC even at idle. Now a 40 ms buffer with a 10 ms top-up threshold and 3 ms polling: the buffer drains toward the watermark instead of staying full, so steady-state latency is only the watermark.
  - **No drift correction anywhere**: the producer (Web Audio) and consumer (WASAPI) clocks are independent, so jitter accumulated a backlog that persisted up to 1 s (256-deep mpsc queue + 1 s pending caps). Both render pumps now anchor backlog to a small watermark (shared: 10 ms beyond the 40 ms buffer; exclusive: one period beyond two periods) and continuously drain to it, and the PCM queue is 16-deep drop-on-full so a backlog can never persist.
  - Exclusive WASAPI period 30 ms → **20 ms**.
  - Capture pump poll 8 ms → **2 ms** (was adding up to 8 ms jitter per packet).
  - AudioContext `latencyHint` `'balanced'` → **`'interactive'`** (balanced silently added 20–50 ms of graph latency).
  - Desktop loopback worklet surge ceiling 80 ms → **50 ms** (the intentional 10 ms cushion is kept).

### Added

- **True one-button whole-DSP bypass (footer BYPASS DSP)**: previously `dsp.bypassed` only neutralized parameters, so audio still flowed through every biquad and each `DynamicsCompressorNode` (~6 ms lookahead each even at 1:1). Bypass now rewires the console into a genuine pass-through: the master bus sum routes straight to the post analyser and each channel strip gets a dry preamp→panner wire, so bypass is **zero-processing**. Gain, polarity, pan, faders, mute/solo, zone delays and routing keep working while bypassed; intentional zone delays remain exactly where they are configured. Amber button state, the TOTAL SIGNAL BYPASS banner and the RESTORE DSP button wire up automatically.

### Changed

- Repository line endings normalized for `*.bat`/`*.cmd`/`*.ps1` per `.gitattributes` (stored LF, checked out CRLF on Windows) — ends a perpetual phantom-diff on `mobile-app/android/gradlew.bat`.

## [1.1.0] - 2026-11-25 — N-Channel Jacks, Native Jack Metadata, Companion Live-Sync & Android App

Unifies the v1.0.4 stability line with the sandbox engineering track: every v1.0.1–v1.0.4 fix is included (this is a superset of v1.0.4 — no regression), plus the features below.

### Added

- **>8-channel discrete jack topology (Dante / MADI / pro PCIe cards)**: the probe cap rises from 8 to 32 channels. Cards beyond 7.1 explode into the 4 named HDA jacks plus generated `AUX n L/R` pairs (aux-1 = channels 8/9, aux-2 = 10/11, …; odd aux = Teal, even aux = Violet; trailing unpaired channel skipped). Layout badges show `10-CH`, `16-CH`, etc. and the Jack Bay footer instructs setting the card to its full discrete channel count. Aux jacks are manual-assign only (never auto-taken); all legacy ≤8-channel layouts are byte-identical.
- **Real jack metadata from the Windows Device Topology API (`IKsJackDescription`)**: the Rust shell now enumerates physical jack colour / connector type / panel location / connection state per endpoint (`list_jack_descriptions` command). The Discrete Jack Bay folds the card's actual silkscreen colours into the probed jacks (nearest HDA colour mapping), so jacks are labelled the way the card physically prints them.
- **Exclusive WASAPI per-jack output (v2 native engine path)**: `start_raw_output` accepts `exclusive` — the endpoint opens in `AUDCLNT_SHAREMODE_EXCLUSIVE` with an event-driven stream for bit-perfect per-jack delivery (no shared-mixer/APO interference). Endpoints without float support in exclusive mode fall back to 16-bit PCM. The raw output engine also honours the console-selected render endpoint (default-device fallback on hot-unplug) and supports N-channel `WAVEFORMATEXTENSIBLE` streams.
- **Phone companion live-sync (speaker zones)**: new `zone:patch` WebSocket protocol — level, mute, delay and jack assignment changes made on the phone apply to the desktop console in real time and vice versa, with permission enforcement (`allowMuteControl` / `allowMasterTrim` sanitisation server-side). RemoteCompanionView gains per-zone level steppers (−24..+12 dB), zone mutes, delay/jack chips, a ZONES/CHANNELS toggle, wake-lock while connected, haptics, and a connection-health footer.
- **Android companion app — HKM FOH Companion (real APK)**: Capacitor 7 shell (`org.hkmaudio.companion`) bundling an offline pairing screen; after token pairing the WebView drives the console's live companion surface over the LAN (WebSocket relay), so the engineer can walk the venue and run the PA from the phone. Installable APK shipped in `public/downloads/HKM-FOH-Companion.apk` and attached to this release. PWA install (manifest + service worker) also supported for iOS.
- **Companion pairing gate**: opening `/?mode=remote` without a valid token shows a pairing card with manual 16-char token entry; fatal auth errors (revoked session/kicked) are surfaced distinctly from retryable PIN failures.

### Fixed

- **Desktop→companion live sync never fired**: the WebSocket relay's `/internal/*` POST handlers read the request body off an un-awaited `req.json()` Promise, so `state:sync` broadcasts and single-client kicks silently no-op'd since introduction. Fixed (awaited body).
- **`latest.json` BOM broke the in-app updater**: every previous release's updater manifest was hand-uploaded with a UTF-8 BOM + CRLF (PowerShell), which the Tauri updater cannot parse — installed apps therefore never saw updates. Release manifests are now generated by the build pipeline as clean JSON; installed v1.0.x apps will pick up this release and update automatically.
- **Jack probe audit message miscounted cards** (reported jack endpoints as cards); now groups by parent device and reports true multi-channel card count.

### Changed

- `detectSinkChannelCount` caps at 32 (was 8) for both `maxChannelCount` and the known probed/native WASAPI count paths, so >8-channel cards keep their aux jacks when addressed through native metadata.
- ESLint/TSconfig ignore the `mobile-app/` and `src-tauri/` subtrees (self-contained sub-projects).

## [1.0.4] - 2026-11-25

### Fixed

- Windows startup crash (0xC0000409 / `OleInitialize` RPC_E_CHANGED_MODE): the main thread now initialises COM as MTA before the WebView2 OLE layer, so the app opens reliably on every launch and after updates.

## [1.0.3] - 2026-11-25

### Fixed

- NSIS installer preinstall hook now releases the whole previous process tree (app + sidecar) before extracting files — no more file-lock aborts during updates.
- In-app updater restart loop: post-update relaunch is clean and idempotent.

## [1.0.2] - 2026-11-25

### Added

- **Simultaneous multi-output routing**: any zone assigned to a hardware output different from the primary device renders in parallel through its own DSP chain (PCIe card + USB interface + HDMI + headphones all live at once).
- **Discrete PCIe jack crossover separation**: per-jack Linkwitz-Riley/Butterworth crossover filtering, and on the orange CENTER/SUB jack the FC channel carries the high-passed Center feed while LFE carries the low-passed Sub feed when both zones exist.

### Fixed

- Universal PC stability and post-update clean-install hardening.

## [1.0.1] - 2026-11-25

### Fixed

- OBS capture: the WebView2 audio tree is protected from source-isolation mute, and the in-process WASAPI stream renders for OBS capture reliably.

## [1.0.0] - 2026-11-24 — First Verified Stable Release

Full code-quality, crash-risk and 24/7-resource audit passed (lint + strict TypeScript clean, browser-verified zero console errors, metered audio path with effects engaged), plus the fixes below. This is the first release stamped as a verified stable baseline for always-on church consoles.

### Added

- **Guitar FX Rack — real-world pedalboard per input channel (research-grounded)**: every channel strip now carries a 12-slot stompbox rack in canonical pedal order (Gate → Wah → Octaver → Comp → Overdrive → Distortion → Phaser → Chorus → Flanger → Tremolo → Delay → Reverb). Any pedal can be engaged on any input from the channel's strip — the rack reloads with the selected channel tab, exactly like the rest of the super input strip:
  - **Real-world archetypes with professional parameter ranges** (Tube-Screamer/Klon asymmetric tanh diode clip with 720 Hz mid hump, MXR Phase 90 4/8-stage allpass cascade, Boss CH-1 antiphase stereo chorus, Boss DD-8 dotted-eighth delay with **tap tempo**, NS-2-style AudioWorklet noise gate, POG-style octave voices via full-wave rectifier + zero-crossing divider, Boss RV-6 style convolved reverb with synthesized Room/Hall/Plate/Spring impulse responses). Research reference: `docs/GUITAR-FX-RACK.md`.
  - **Zero-idle-cost engineering**: pedals are lazy-built on first stomp, engage/disengage through a 15 ms dry/wet crossfade (never disconnect mid-audio), delay and reverb keep their trails ringing out before the wet node graph is disposed entirely — an unengaged pedal costs zero audio-thread CPU, and a bypassed rack collapses to a unity passthrough.
  - Sound-true implementation details: 8192-point WaveShaper curves with 4× oversampling, `setTargetAtTime` everywhere (no zipper noise), LFO-to-AudioParam modulation in seconds, feedback loops always contain a DelayNode, IRs cached per type/decay at the context sample rate.
  - FX state persists per channel with migration-safe normalization (older sessions default to all-bypassed); mobile companion patches keep working.
- **Single-instance app**: the second launch now focuses the existing window instead of spawning a zombie instance.
- **Native microphone permission grant**: the WebView2 microphone permission is granted natively at the shell level — the Chromium "wants to use your microphones" prompt never appears, not on first run, not after an update, and not when the console server changes port.
- NSIS installer hooks (`src-tauri/windows/installer-hooks.nsh`) covering install and uninstall.

- **Discrete output jack routing — 5.1/7.1 sound cards treated as separate FRONT / REAR / CENTER-SUB / SIDE outputs (PCIe + onboard)**: multi-channel endpoints are exploded into per-jack stereo pairs following the WAVEFORMATEXTENSIBLE channel order and the industry HD Audio jack colour code (green FL/FR, orange FC/LFE, black BL/BR, grey SL/SR). A zone can be assigned to a specific physical jack so the console drives each port as its own independently aligned output — exactly like a matrixed zone-output card:
  - `PROBE DISCRETE JACKS` probes every enumerated output endpoint (`AudioContext` `{sinkId}` → `destination.maxChannelCount`, 30-day label-matched cache) and exposes 5.1/7.1 devices as discrete jacks.
  - **Discrete Jack Bay** on the Outputs tab: per-jack colour-coded rows with live level meters, zone assignment selects with **conflict-free auto-swap** (one zone per jack, enforced again by an engine first-wins interlock), church-install AUTO-ASSIGN (Main PA → green front, Sub → orange center/sub, Overflow/Rear-fill → black rear, Stage monitor → grey side) and a desktop "WIN SOUND" shortcut to set the Windows speaker configuration to 5.1/7.1.
  - Engine: per-jack zone chains (independent trim/delay/polarity/mute) feed a `ChannelMerger` into the destination with `channelInterpretation: 'discrete'` for true 1:1 jack-conductor mapping; legacy stereo routing is restored automatically when the sink is stereo or no jacks are assigned; Main PA auto-lands on the green front jack when a surround card becomes the sink.
  - **Simulated 7.1 PCIe Jack Card** training toggle (TOOLS popover): rehearse discrete jack routing without hardware — front pair stays audible on stereo devices while other jacks remain metered.
  - Research + design reference: `docs/DISCRETE-JACK-ROUTING.md` (WASAPI shared/exclusive vs ASIO separation methods, conflict rules, native v2 roadmap incl. `dwChannelMask` parsing and per-jack ASIO streams).
- **Real-world instrument input (guitar/bass) — MIC / LINE / INST input source switch**: every channel strip now carries the physical console input section exactly like an Allen & Heath ZED or interface Hi-Z "INST" engagement. Each strip's Row 0 is a 3-segment MIC/LINE/INST selector plus 48V / PAD / Ø hardware buttons with true interlock semantics:
  - **MIC** (+48V capable): mic preamp gain +0..+60 dB, phantom power available.
  - **LINE**: line trim −12..+12 dB around unity (jack domain, phantom locked out).
  - **INST (Hi-Z ≥1MΩ)**: instrument gain +8..+55 dB for guitar/bass pickups — phantom **hard-locked and auto-disengaged** on switch (48V into an instrument or unprotected DI destroys it, exactly the interlock smart consoles implement).
  - Switching modes auto-rescales the stored preamp gain into the new mode's silkscreen range; PAD (−20 dB) and polarity Ø apply to the real DSP chain in every mode.
- **Instrument Rig Checklist**: when the focused channel runs INST, the Phase 1 · Stage Preamp deck shows the real-world guitar rig checklist (Hi-Z/INST jack or DI, phantom warning, −6 dBFS strum target, ground-lift hum discipline, PAD for hot pedalboards).
- **Electric Guitar (Worship Rig) instrument profile** in the Band module: Hi-Z source type, amp-mud/fizz EQ hints, single-coil level expectations, and DI ground-lift diagnostics.

### Fixed

- **Installer failure "Error opening file for writing: …\binaries\hkm-server.exe"**: the NSIS installer previously tried to overwrite the console-server sidecar while the previous version's process was still running (Windows file lock → Abort/Retry/Ignore dialog). The installer now force-closes both the app and its sidecar in the PREINSTALL hook before any file is extracted, so updates and reinstalls are silent and conflict-free. The app also kills orphaned `hkm-server.exe` processes at startup before binding its port — a crashed previous run no longer locks the fixed port 37741 (which also kept the WebView permission origin stable).
- **`Extract: binaries\PLACEHOLDER.txt` in the install log**: the repo placeholder file is no longer bundled once the real `hkm-server.exe` runtime is present.
- **Microphone permission re-asked after each install**: root cause was the console server falling back to a different fixed port when a stale sidecar held 37741 — each port is a different WebView2 origin, so the permission prompt returned. Fixed by the stale-sidecar kill + stable primary port + the native permission grant above.
- **24/7 resource audit gaps** (all closed):
  - Multitrack recorder: recorded take blobs were never revoked on delete and grew unbounded (minutes of audio pinned in memory forever); recording continued with the mic held open if the module was unmounted mid-take; the 10 Hz waveform interval was torn down and recreated on every 5 Hz telemetry commit. Takes are now capped at 20 with immediate blob revocation, capture hard-stops on unmount, and the interval reads telemetry through a ref.
  - OBS reconnect logic: a manual disconnect permanently disabled auto-reconnect (OBS restarts overnight were never re-detected); connect-timeouts double-counted reconnect attempts and exhausted the retry budget after ~3 real tries; the 1.8 s status polling continued while the window was hidden. All fixed; polling now pauses when hidden (state transitions still arrive instantly via subscribed events).
  - Desktop/companion WebSocket reconnect now uses exponential backoff (2 s → 10 s cap) instead of fixed 2 s forever.
  - Livestream module meters re-rendered the whole 1k-line tree at ~30 fps with unquantized float state — now quantized to 0.5 dB with equality-guarded setters, matching every other meter loop in the app.
  - WebSocket mini-service touched the JSON store (fs stat + possible re-read) for every 5 Hz telemetry frame before its early-return — the hot path is now handled first, so a running console performs zero store I/O per frame.
  - Telemetry analyzer allocated two fresh Float32Array(2048) spectra per 5 Hz tick (~80 KB/s GC garbage) — now double-buffered with swap.
  - Removed 2.5 k lines of dead `LiveConsoleModule` code (never imported; contained inert 60 fps loops — a maintenance trap).
  - Wall clock timer no longer wakes a hidden window (recomputed on visibilitychange instead).
  - Hardware scan survives `enumerateDevices` rejections instead of surfacing unhandled promise rejections.
  - MIDI learn no longer fires a network POST inside a `setState` updater (impure updater).
  - Removed the hardcoded OBS WebSocket password shipped in the client bundle.

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
