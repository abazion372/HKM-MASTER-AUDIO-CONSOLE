# Task 2b — >8-Channel Discrete Jack Topology + Native Jack Hints

Status: COMPLETE. All quality gates pass (`bun run lint` clean, `bunx tsc --noEmit` clean, dev server hot-reloads with no compile errors).

## Scope / ownership respected

Only these files were modified:
- `src/hkm/utils/jackTopology.ts`
- `src/hkm/audio/outputRouter.ts`
- `src/hkm/store/useHardwareManager.ts`
- `src/hkm/components/ConsoleLeftPanel.tsx`
- `src/hkm/utils/nativeDesktopAudio.ts`
- `docs/DISCRETE-JACK-ROUTING.md`

Nothing under `mini-services/**`, `src/app/api/state/sync/route.ts`, `useConsoleSession.ts`, `RemoteCompanionView.tsx`, `App.tsx`, `layout.tsx`, `public/**` was touched.

## What changed

### 1. jackTopology.ts — N-channel slot model
- `NamedJackSlot` (new export) = the 4 named HDA slots; `OutputJackSlot = NamedJackSlot | 'aux-${number}'`.
- Generated aux slots: aux-1 = channels 8/9, aux-2 = 10/11, ... label `AUX n L/R`, odd aux = Teal `#14B8A6`, even aux = Violet `#A78BFA`.
- `buildJackEndpoints`: channelCount <= 8 keeps byte-identical legacy behavior (verified: 6ch -> front/rear/center @5.1 indices, 8ch -> 4 named @7.1). >8: named slots at 7.1 indices + one aux pair per complete channel pair from channel 8 up; trailing odd channel skipped (commented). `layout` widened to `string`: '5.1' | '7.1' or `${channelCount}-CH` ('10-CH', '16-CH', ...).
- New helpers exported: `slotChannelIndices(slot, channelCount): [number, number] | null` (single source of truth; null for side-lr on 5.1 or aux pairs beyond the count) and `orderedJackSlots(channelCount): OutputJackSlot[]` (physical order front, rear, center, side, aux-1..N; drops slots that do not fit).
- `parseJackId` now accepts `aux-N` (regex `^aux-([1-9]\d*)$`, N>=1, no leading zeros). All legacy `${deviceId}::jack::${slot}` ids parse identically — `makeJackId` format unchanged.
- `ZONE_ROLE_DEFAULT_JACK` retyped to `Partial<Record<role, NamedJackSlot>>` (aux = manual-assign only; `buildAutoJackAssignments` verified: aux jacks never auto-taken, manual aux assignments win).
- `findJackConflicts` verified generic for aux ids (keyed by parsed deviceId+slot).
- New export `nativeColorToHda(colorRgb)` — nearest of the 6 HDA silkscreen colours (green/orange/black/grey/teal/violet) by Euclidean RGB distance; returns `{ colorName, colorHex }`.

### 2. outputRouter.ts
- `detectSinkChannelCount`: `Math.min(max, 8)` -> `Math.min(max, 32)` (simulated card still returns 8).
- `buildJackGraph`: hard-coded `layoutIndices` record removed; uses `slotChannelIndices(slot, channels)`. Slot loop now iterates `orderedJackSlots(channels)` (physical order, includes aux pairs) instead of static `OUTPUT_JACK_SLOT_ORDER`.
- `getJackRoutingStatus`: second `layoutIndices` record removed; uses `slotChannelIndices(slot, channels)`.
- `reconcileJackGraph` unchanged apart from working with the widened slot type (Map<OutputJackSlot, string> accepts aux); main-lr -> front-lr default fallback kept.
- Jack metering (`fastJackRms` consumers, `applyZoneValuesToJackChains`, `sampleJackLevels`) keys by slot — generalizes to aux automatically; no slot-keyed records remain.

### 3. useHardwareManager.ts + nativeDesktopAudio.ts
- `probeDeviceChannelCount`: clamp raised to 32.
- Audit log math fixed: endpoints grouped by `parentDeviceId`; M = groups whose first endpoint has channelCount >= 4; message `Probed N outputs — M multi-channel card(s) with discrete jack topology found` (no-jack message unchanged).
- Native jack hints (desktop only): after building endpoints, calls `listDesktopJackDescriptions()` (try/catch), matches each jack endpoint to native jacks by exact `endpointId === parentDeviceId` first, then case-insensitive friendlyName/label substring fallback; if the native jack feeding `channelIndices[0]` has a non-zero `colorRgb`, refines `jackColorName`/`jackColorHex` via `nativeColorToHda`. Best-effort: mismatch keeps probed values.

### TS <-> Rust contract (for the parallel Rust task)
- Command name: `list_jack_descriptions`
- Args: none
- Returns: `DesktopJackDescription[]` with fields:
  - `endpointId: string`, `friendlyName: string`, `jackIndex: number`,
  - `colorRgb: number` (0x00RRGGBB, 0 = unknown), `channel: number` (-1 = unknown),
  - `isConnected: boolean`, `connectorType: string` (e.g. 'eJackConnType3Point5mm'),
  - `location: string` (e.g. 'eGeoLocRear')
- Wrapper: `listDesktopJackDescriptions()` in `src/hkm/utils/nativeDesktopAudio.ts` — feature-detects the desktop shell (`isDesktopApp()` + `window.__TAURI__.core.invoke`); on web or failure returns `[]`, never throws.

### 4. ConsoleLeftPanel.tsx (Jack Bay)
- Bay ordering now derives from the device's own endpoints sorted by `channelIndices[0]` ascending (handles aux automatically; `OUTPUT_JACK_SLOT_ORDER` import removed).
- Layout badge: cyan only for '5.1'; fuchsia for '7.1' and any N-CH layout (label rendered as-is, e.g. '16-CH').
- Footer: standard layouts keep the exact legacy sentence; N-CH layouts render "must be configured for {channelCount} discrete channels (Sound Control Panel or vendor control panel) for 1:1 per-jack routing."
- AUTO-ASSIGN tooltip appended with "Aux jacks are manual-assign only."
- Per-jack rows already generic (label/colorName/colorHex/channelIndices) — no other named-slot assumptions found.

### 5. docs/DISCRETE-JACK-ROUTING.md
- Detection section: 32-channel probe cap, aux slot generation rules, native colour-hint fold-in.
- Comparison table: Device Topology API row now "Implemented — label/colour hints via the Rust shell (`list_jack_descriptions` command)".
- Roadmap: `IKsJackDescription` hints marked implemented; `WAVEFORMATEXTENSIBLE.dwChannelMask` marked in progress.

## Verification notes for follow-up tasks
- `bun run lint` — pass. `bunx tsc --noEmit` — pass (baseline before changes was also clean; zero pre-existing errors).
- Behavioural spot-check run via bun (not committed): legacy <=8 layouts byte-identical; 10ch = 4 named + aux-1; 16ch = 8 jacks (aux-4 violet); 9ch/11ch skip the unpaired channel; aux-0/aux-01/aux-foo rejected; orderedJackSlots(32) = 16 slots.
- `jackTopology` is imported only by the three files listed above, so no other module is affected by the widened types.
