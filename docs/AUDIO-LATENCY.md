# Audio Latency in HKM Audio System — What to Expect and How to Reach the Floor

This guide explains every millisecond between "sound exists digitally" and
"sound leaves your speakers", what HKM has already squeezed out, and what only
kernel-mode audio (ASIO-class drivers) could remove. It exists so you can
verify you are on the floor — and know when a delay you hear is intentional
(zone alignment) rather than a bug.

## The short version

| Path | Typical total | Floor |
|---|---|---|
| Desktop audio → speakers (shared mode) | ≈ 18 ms | Windows engine + 5 ms adaptive cushion |
| Desktop audio → speakers (exclusive mode, 5 ms-capable DAC) | ≈ 8–13 ms | One exclusive period + worklet cadence |
| Mic/line → speakers | ≈ 8 ms shared / 1–6 ms exclusive | **plus** the browser's own input buffer (~10–20 ms, Chrome-governed) |
| Video lips on the same screen | will always look ~20–50 ms early | physics: the video decoder adds its own delay — do **not** judge sync by lip movement |

For live-sound sync judgement: clap in front of the live microphone and listen
to the PA, or compare against an acoustic source. That is the loop your
congregation hears.

## Where the milliseconds went (full ledger)

1. **The source application's own output buffer** — 0–30 ms+. A browser
   playing YouTube, a video player, a DAW: all buffer audio before it ever
   reaches Windows. No downstream app can remove this.
2. **Loopback capture cushion — 4–10 ms, adaptive.** Windows delivers
   loopback packets on its ~10 ms render cadence, so capture starts with a
   cadence-matched 10 ms cushion; after the feed proves healthy it decays
   frame-by-frame toward a 4 ms floor, and if the machine ever starves the
   buffer it regrows (15 ms ceiling) so a weak machine self-heals instead of
   stuttering.
3. **Web Audio worklet quantum — 2.7 ms.** The AudioWorklet specification
   fixes the render quantum at 128 frames at 48 kHz. This is the grain size
   of all JS-side processing; it cannot be smaller.
4. **IPC handoff — ~0.1–0.5 ms.** Raw bytes over a Tauri channel. Negligible.
5. **Console DSP — one quantum.** EQ/comp/limiting runs in-place inside the
   same 128-frame callback; it adds zero additional buffering.
6. **Shared-mode writer cushion — 5 ms, adaptive.** The WASAPI writer holds a
   small padding target (240 frames) so a ~5 ms browser/IPC hiccup cannot
   cause an underrun. If your machine proves jittery, it grows in 5 ms steps
   and stays grown — that is a deliberate trade of a few ms for zero glitches.
7. **The Windows shared audio engine — ~10 ms.** The shared-mode mixer's own
   scheduling quantum. This is why exclusive mode exists.
8. **Exclusive-mode period — 5 ms on pro DACs, 10 ms default.** One period is
   always queued in the endpoint. HKM tries 5 ms first and falls back
   automatically (10 → 20 ms, then PCM16 variants) per device capability.
9. **DAC/analogue group delay — ~1 ms.** Hardware.

## How to reach the floor

1. **Arm exclusive mode** on your output device (per-jack routing view).
   On a DAC that accepts a 5 ms period this removes the shared engine and
   roughly halves total latency. If the device rejects 5 ms, HKM silently
   falls back to 10 ms — the status line shows which period was armed
   (e.g. `exclusive 2ch/32bit · 5ms f32 (240 frames/period)`).
2. **Close other audio apps** while arming exclusive — only one app can hold
   an endpoint in exclusive mode.
3. **Check zone alignment delays are 0** unless you placed speakers far apart
   on purpose (Speaker Zones module). Since v1.1.3 every alignment delay
   ships at 0 — any delay you hear there is one you configured.
4. **Wired headphones directly on the interface** remove room/speaker path
   delay when testing.

## What "zero latency" means here

True zero does not exist in digital audio — even one 128-frame worklet
quantum is 2.7 ms, and Windows itself adds at least its engine quantum in
shared mode. HKM's controllable chain is now at its floor: every remaining
millisecond is either (a) a structural Windows/WebKit constant, (b) an
adaptive cushion that exists to prevent audible glitches, or (c) a delay you
configured deliberately. If you measure more than the table above, run
Hardware Diagnostics → it logs underrun/starvation events and the cushion
levels the environment settled at, which pinpoints which cushion your machine
needed to grow.

The full stage-by-stage engineering ledger lives in
`src-tauri/src/win_audio.rs` (module documentation).
