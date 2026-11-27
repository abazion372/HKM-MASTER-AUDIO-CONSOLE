# v1.2.0 — The Help Desk & the De-Texted Console: a real surface, a real manual

## The first strip card got its width back
- Left panel narrowed **272→228 px** (300→256 px @2xl); the DSP chain grid now gives the **INPUT CONDITIONING column a 1.4 fr share (~187 px @1600 px wide)** — the fader keeps real console proportions (full-height, calibrated tick ladder).
- The gain arc now sits **beside the PREAMP knob** — the way consoles pair a gain meter with its trim pot — and the connector badge/range note collapsed into engraved labels with the full text on hover.
- Signal-flow overlay seams re-flowed for the new column geometry (verified landing in the gutters between cards).

## New: HELP DESK — the operation manual, off the surfaces
A comprehensive, searchable field guide is now a module in the menu (nav tab **Help** + the menu bar's **Help → Help Desk — Operation Manual**):
Quick Start · Input Conditioning & Channel Strip · DSP Chain · Console Deck phases · Feedback · Acoustics/REW workflow · Speakers · Routing · Microphones · Band/DI practices · Virtual DI string-scale fundamentals · Livestream/OBS setup · Recorder · Sound Check · Presets/Cues · AI Engineer authority model · System Audio Bridge methods · MIDI control surfaces · Keyboard Shortcuts · Sunday-morning Troubleshooting FAQ.

Dashboards deep-link straight into topics (**SETUP GUIDE**, **WORKFLOW**, **DI GUIDE**, **ROUTE GUIDE**, **HOW-TO**, **SETUP** keys).

## All 16 dashboards de-texted — text is for labelling only
Real consoles are full of operation buttons, not text boxes. Every paragraph, numbered checklist and instructional sentence found in the audit is now operational:
- **LED status chips** with the full text preserved on hover tooltips
- **Engraved capability chips** (`APP CAPTURE · NO VIRTUAL CABLE · MAIN DSP BUS`)
- **Operation keys where text described an action** — e.g. the Virtual DI string-scale advice is now **4-STR / 5-STR keys that actually set the Subsonic HPF (40/32 Hz)** with a live readout
- **Compact LED empty states** instead of placeholder prose
- Live readouts: Presets diff inspector got per-parameter **change LEDs**, Recorder stem lanes got **live 24-segment LED ladders**, the welcome banner is now a **single-line status rail**

## Fixed
- Literal `\n` artifact rendered in the Hardware module's capture-method chips
- Virtual DI canvas label collision (XOVER vs. standby legend)
- `title` prop nullability type error in the Hardware module

## Functionality preserved
Design/layout only — every handler, state machine and data flow is untouched. Verified: ESLint **0 errors**, TypeScript **0 errors**, and a full browser interaction sweep (module nav, deep links, string-scale keys, rig-notes toggle, panel collapse/expand, radio groups, menu bar, responsiveness at 1024/1280/1600 px).
