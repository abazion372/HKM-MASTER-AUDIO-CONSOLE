# Discrete Output Jack Routing — Research & Design

How HKM separates the FRONT / REAR / CENTER-SUB / SIDE jack ports of a PC
sound card (PCIe or onboard 5.1/7.1) into independent console outputs,
exactly as professional installations do.

---

## 1. The real-world problem

A multi-channel Windows sound card (Realtek HD Audio onboard, ASUS Xonar,
Creative Sound Blaster PCIe, etc.) does **not** expose each physical jack as
a separate audio endpoint. Windows enumerates **one render endpoint** —
"Speakers (Realtek(R) Audio)" — whose stream carries **6 or 8 interleaved
channels**. The physical jacks are fixed **channel positions** inside that
single stream, following the WAVEFORMATEXTENSIBLE channel order every
Windows driver uses:

| Channel index | Position | Physical jack (HD Audio colour code) |
| --- | --- | --- |
| 0 / 1 | FL / FR | **GREEN** — Front L/R |
| 2 / 3 | FC / LFE | **ORANGE** — Center / Sub |
| 4 / 5 | BL / BR | **BLACK** — Rear L/R |
| 6 / 7 | SL / SR | **GREY** — Side L/R (7.1 only) |

So "treating rear, front and centre as separate outputs" means: open the
endpoint in **discrete multi-channel mode** and route an independent mix
onto each channel pair. That is exactly what matrixed zone-output cards and
installed-church DSPs (Behringer X32 matrix outs, Biamp, QSC Core) do.

## 2. Professional separation methods (compared)

| Method | How it separates jacks | Conflict behaviour | HKM status |
| --- | --- | --- | --- |
| **WASAPI shared, discrete channel pairs** | One 6/8-ch stream; app writes each pair | Windows mixes concurrent apps silently; in-app one-zone-per-jack interlock needed | **Implemented** (browser engine) |
| **WASAPI exclusive** | App owns the device at a fixed format | One app at a time; blocks system sounds | Reserved for native v2 (`win_audio.rs`) |
| **ASIO (pro PCIe cards: RME, Focusrite, M-Audio Delta)** | Every jack pair is an individual ASIO output stream | Zero OS mixing — the true pro path | Reserved for native v2 (cpal/ASIO) |
| **Device Topology API (`IKsJackDescription`)** | Jack metadata: colour, connector, front/rear panel | Read-only metadata | **Implemented** — label/colour hints via the Rust shell (`list_jack_descriptions` command) |

## 3. Requirements for conflict-free separation

1. **Windows Speaker Configuration must be 5.1 / 7.1** for the device (Sound
   Control Panel → device → Configure). Otherwise the driver folds all
   channels onto the front pair. HKM shows a "WIN SOUND" shortcut (desktop
   app) next to the jack bay.
2. **Exactly one zone per jack slot.** Enforced twice:
   - UI: selecting a zone onto an occupied jack automatically swaps the
     previous zone off (conflict-free swap, no double-routing).
   - Engine: `OutputRouter.reconcileJackGraph()` applies a first-wins
     interlock and ignores later duplicates.
3. **Discrete channel addressing.** The engine addresses the
   `AudioDestinationNode` with `channelInterpretation: 'discrete'`, so the
   browser performs no speaker down-mix and channels map 1:1 onto the jack
   conductors.
4. **Zone processing per jack.** Each jack pair carries its own zone chain
   (level trim, delay up to 500 ms, polarity invert, mute) — so a rear-fill
   or overflow feed gets its own physical output with its own alignment,
   derived from the same master mix, exactly like auxiliary zone amps fed
   from a matrix bus.

## 4. HKM implementation map

| Piece | File |
| --- | --- |
| Jack topology model (slots, colours, channel indices, conflict helpers, auto-assign) | `src/hkm/utils/jackTopology.ts` |
| Zone ↔ jack persistence (`SpeakerZone.outputJackId`) | `src/hkm/types/audio.ts` + `db/hkm-state.json` via `/api/state` |
| Discrete jack router (ChannelMerger per pair, zone chains, interlock, meters) | `src/hkm/audio/outputRouter.ts` |
| Output layout probing (`destination.maxChannelCount` per device, 30-day cache) | `src/hkm/store/useHardwareManager.ts` |
| Discrete Jack Bay UI (per-jack zone selects, live meters, auto-assign, Windows settings) | `src/hkm/components/ConsoleLeftPanel.tsx` (Outputs tab) |
| Training card toggle ("Simulated 7.1 PCIe Jack Card") | `src/hkm/components/TopBar.tsx` (TOOLS popover) |

### Default church-install patch (AUTO-ASSIGN)

| Zone role | Jack | Colour |
| --- | --- | --- |
| Main PA (main-lr) | FRONT L/R | Green |
| Subwoofer (sub) | CENTER/SUB | Orange |
| Overflow / Rear fill | REAR L/R | Black |
| Stage monitor | SIDE L/R | Grey |

When a 5.1/7.1 card becomes the Master PA sink and no jack patch exists,
Main PA lands on the green front jack automatically.

### Detection: `PROBE DISCRETE JACKS`

Each enumerated output endpoint is probed by opening a throwaway
`AudioContext` on it (`{ sinkId }`) and reading
`destination.maxChannelCount` (capped at 32 channels). Devices reporting
≥ 4 channels are exploded into jack endpoints: 5.1 → 3 jacks, 7.1 → 4
jacks, and >8-channel pro cards (RME, M-Audio Delta 1010, Dante 16-ch
virtual soundcards) keep the four named slots at their 7.1 positions plus
one generated `AUX n L/R` pair per complete channel pair from channel 8 up
(aux-1 = 8/9, aux-2 = 10/11, …; a trailing odd channel is skipped). Odd
aux jacks are teal, even aux jacks violet. Results are cached per device
(label-matched, 30-day TTL); the probe button forces a refresh. On the
desktop app the probe also folds in native `IKsJackDescription` colour
hints (`list_jack_descriptions`) to refine the bay's silkscreen colours.

### Training mode: Simulated 7.1 PCIe Jack Card

For rehearsal without hardware (volunteer training, offline config), the
TOOLS popover can inject a simulated 7.1 card. Its jack routing logic is
identical to a real card; on a physical stereo device the front pair stays
audible while the other jacks remain metered — mirroring real behaviour
where unpatched jacks simply carry nothing.

## 5. Native (desktop v2) roadmap

The bundled Rust shell already speaks WASAPI (`src-tauri/src/win_audio.rs`).
The reserved next steps for pro PCIe cards:

- ~~Extend `target_wave_format()` beyond stereo and honour the selected
  endpoint in `raw_output_pump`~~ — **implemented**: `target_wave_format_channels()`
  requests a WAVEFORMATEXTENSIBLE speaker-mask stream for 3..=32 channels and
  the raw render pump honours the console-selected endpoint (default-device
  fallback on hot-unplug). The bundled web worklet still pushes stereo blocks;
  >2 channels are armed for the v2 multichannel worklet.
- Parse `WAVEFORMATEXTENSIBLE.dwChannelMask` for exact jack layout —
  **in progress** (multichannel WAVEFORMATEXTENSIBLE output for
  >8-channel pro cards).
- `IKsJackDescription` jack hints (colour, connector, panel location) —
  **implemented**: the `list_jack_descriptions` Rust command feeds real
  silkscreen colours/labels into the Discrete Jack Bay.
- Optional ASIO path (cpal `asio` feature) for per-jack exclusive streams —
  the zero-conflict professional route for RME/Focusrite-class cards.
