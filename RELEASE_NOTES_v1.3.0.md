# v1.3.0 — The Bolted Deck & the Reference Bay: a physical console

## The center panel is now a bolted DECK
- Machined border rail + a **unique near-black brushed-metal background** (specular top edge, vertical brush lines) + deep drop shadow — a surface clearly distinct from the two side panels.
- **Four recessed Phillips screws** at the deck corners — the master section is bolted in.

## The Input Bay, rebuilt to the reference console panel
- The redundant **channel tab rail is gone** — the bay rows are the single focus surface (click a row to load that channel into the central INPUT CONDITIONING card, X32-style).
- Every row is a real channel strip: **number badge + solo/mute LEDs · name + live RMS readout · twin thin vertical segmented LED ladders (RMS green→amber→red, PEAK cyan) · machined preamp-gain position knob (ring = MIC/LINE/INST domain) · mix-bus assign LEDs · beveled M / S keys**.
- Zero instruction text: `OPEN SLOT — tap to assign…` is now an `OPEN SLOT · PATCH` key (sentence on hover); per-row source/mode/gain text moved into tooltips.

## A physical-hardware kit, applied console-wide
`hw-deck` · `hw-screw` · `hw-engraved` silkscreen labels · `hw-led-track`/`hw-led-seg` discrete LED ladders · `hw-knob-face` brushed-metal knobs with specular highlights · `hw-fader-cap` glossy 3D caps with center guide lines riding in `hw-fader-slot` milled tracks · `hw-key` beveled keycaps · `hw-lcd` recessed readout wells · `hw-lamp` LED jewels.

- Main faders and channel strips: **glossy caps in milled slots**. Smooth meter bars everywhere: **discrete LED segment ladders**. Flat buttons: **beveled keycaps**. Labels: **engraved silkscreen**.
- Light themes get matched overrides; `prefers-reduced-motion` kills all lamp transitions.

## Every module swept again — text is for labelling only (strict)
All 16 dashboards plus every drawer, dock, modal and bar re-audited:
- Instructional sentences → operation keys / LED chips with the full text on hover
- Advisory paragraphs → engraved chips (`DIST 10–15 CM · HPF 110–130 HZ · RF HW PAIRED`)
- AI quick-questions → silkscreen keys (`MIC CLARITY`, `BASS HUM`…) that still send the full question
- Empty-state prose → LED states (`NO EVENTS`, `NO INPUTS · RESCAN`, `NO OUTPUTS · RESCAN`)
- Long card headers → console silkscreen (`DSP LOAD`, `HEADROOM`, `ENGINE`, `BUS MATRIX · PATCHBAY`)

## The chrome, same treatment
Top-bar tagline → nameplate (`HKM MASTER CONSOLE`); TOOLS BPM readout moved into the popover's TAP tool; LOCK pill → **latching LOCK key with LED** (no more UNLOCKED/LOCKED swap); preset recall shows short names with the full name on hover.

## The Help Desk moved to the menu only
The manual nav tab is gone — it lives under **Help → Help Desk — Operation Manual…** in the menu bar (and via every dashboard's SETUP GUIDE / GUIDE / WORKFLOW deep-link keys). The module itself is unchanged.

## Functionality preserved
Design/layout only — every handler, state machine and data flow is untouched. Verified: ESLint **0 errors**, TypeScript **0 errors**, and a full browser sweep of all 16 modules + both side panels + tabs + drawers (no layout breakage, no console errors, label-only text everywhere).
