# Guitar FX Rack — Real-World Research & Implementation Reference

How the HKM per-channel FX rack maps the pedals working guitarists (and worship
musicians in particular) actually use onto a Web Audio pedalboard, and why the
chain is ordered the way it is.

Research sources are listed at the bottom.

---

## 1. Canonical pedal chain order (and why)

The rack fixes the slot order to the industry-standard signal flow:

```
[Channel preamp + HPF/EQ]
 → 1 Noise Gate      — detect on the CLEAN signal; kills hum before every gain stage amplifies it (Boss NS-2 practice)
 → 2 Wah             — filter BEFORE gain so the sweep "drives" the overdrive (the classic vocal quack)
 → 3 Octaver         — pitch tracking wants the cleanest signal (POG sits early on real boards)
 → 4 Compressor      — evens dynamics FEEDING the drives (comp after gain raises the noise floor)
 → 5 Overdrive       — low-gain first (stacks: OD into Dist = saturation)
 → 6 Distortion      — higher gain second (after = would only add loudness)
 → 7 Phaser          — modulation after gain (distortion before mod smears the sweep)
 → 8 Chorus          — the worship default shimmer (Boss CH-1)
 → 9 Flanger
 → 10 Tremolo        — before delay so every repeat is tremulated
 → 11 Delay         — the dotted-eighth worship echo
 → 12 Reverb        — LAST: space wraps the whole tone; anything after muddies it
 → [Strip comp → pan → fader → bus]
```

Canonical citations: the JHS official pedal-order guide
(`Fuzz > Wah > Octave > Comp > Boost > OD > Distortion > Mod > Delay > Reverb`)
and the Worship Tutorials worship rig
(tuner → compressor → Tube-Screamer-style drives → **dotted-eighth** delay → hall reverb —
"the U2 setting, which also doubles as the Modern Worship Guitar setting").

## 2. The twelve pedals — archetype, knobs, defaults

| Slot | Archetype | Knobs (min–max · default) |
|---|---|---|
| **Noise Gate** | Boss NS-2 / ISP Decimator | threshold −90..−10 · −55 dB, floor −80..0 · −40 dB, attack 1..20 · 2 ms, release 20..500 · 120 ms |
| **Wah** | Cry Baby / auto-wah | mode Manual/Auto-LFO/Envelope, position 0..1 · 0.5, sweep 300–1600 Hz, Q 1..12 · 6, LFO rate 0.1..8 · 1.5 Hz, sensitivity 0..1 · 0.6, mix |
| **Octaver** | EHX POG2 | oct-up 0..1 · 0.35, oct-up×2 0, oct-down 0..1 · 0.25, dry 0.8, lowpass 8 kHz |
| **Compressor** | MXR Dyna Comp / Boss CS-3 | threshold −60..0 · −25 dB, ratio 1..20 · 4:1, attack 1..100 · 10 ms, release 30..1000 · 250 ms, makeup 0..24 · 6 dB, blend (parallel "New York" comp) |
| **Overdrive** | Ibanez TS9 / Klon (character switch) | drive 0..1 · 0.35, tone, level, mid-hump 0..8 · 4 dB @ 720 Hz, low-cut 320 Hz (TS "tight low end") |
| **Distortion** | Boss BD-2 / Rat | drive, tone 800..12k · 4.5 kHz, low-cut 100 Hz, level |
| **Phaser** | MXR Phase 90 / Boss PH-3 | stages 4/8, rate 0.05..3 · 0.4 Hz, depth, resonance 0..0.9 · 0.35, mix |
| **Chorus** | Boss CH-1 (stereo) | rate 0.1..6 · 0.8 Hz, depth, delay 5..55 · 25 ms, mix 0.5, tone 6 kHz |
| **Flanger** | Boss BF-3 | rate, depth, feedback 0..0.95 · 0.5, mix |
| **Tremolo** | Boss TR-2 / Fender amp trem | rate 0.3..12 · 4 Hz, depth, wave sine/triangle/square |
| **Delay** | Boss DD-8 (dotted-8th) | mode digital/analog/tape, subdivision 1/4 · 1/8 · **1/8 dotted** · 1/2, tempo 40..240 · 100 BPM (+ **TAP TEMPO**), feedback, mix, tone 3.5 kHz |
| **Reverb** | Boss RV-6 / Strymon BigSky | type room/**hall**/plate/spring, decay 0.2..8 · 2.4 s, predelay 20 ms, mix 0.3, low-cut 140 Hz, high-cut 8 kHz |

Worship-grounded numbers come from real rig documentation: dotted-eighth delay
feedback 30–40% (ambient swells 62–74% @ 800–1200 ms), reverb low-cut 140 Hz /
high-cut 8 kHz / mix 35%, hall decay 1.8–4 s (swell patches up to 7.5).

## 3. Web Audio implementation recipes

- **Overdrive** — pre-gain (drive → up to +24 dB) → highpass (low-cut) → peaking
  +midHump @ 720 Hz (the TS mid hump) → `WaveShaperNode` with an **asymmetric
  double-tanh diode-clip curve** `f(x) = (tanh(k(x+a)) − tanh(ka)) / (1 − tanh(ka))`
  (a ≈ 0.04 biases the positive lobe → even harmonics, 8192 points, 4×
  oversampling) → tone lowpass (800 Hz–10 kHz exp map) → level. The Klon
  character uses a ≈ 0.01, gentler k and ~1 dB hump.
- **Noise gate** — `AudioWorklet` (`fx-gate-processor`): block envelope +
  hysteresis state machine (attack/hold/release) drives a per-sample VCA ramp
  to the floor gain. Main-thread metering is far too laggy for click-free
  gating, so the whole detector lives on the audio thread.
- **Octaver** — octave-up = full-wave rectifier `|x|` WaveShaper (2f harmonics,
  DC stripped by a 60 Hz highpass); octave-up×2 = bright 900 Hz+ shimmer layer
  of the rectified signal; octave-down = `fx-sub-octave-processor` worklet
  (classic monophonic zero-crossing flip-flop halves the fundamental).
- **Phaser** — 4/8 cascaded `BiquadFilter allpass` at `700·1.7^i` Hz, LFO →
  depth-scaled gain → every allpass `frequency`; feedback loop deliberately
  contains a 2 ms `DelayNode` (a feedback cycle with no node latency mutes the
  graph per spec) capped at 0.7.
- **Chorus (CH-1 stereo)** — splitter → two delays (base 5–55 ms) → merger,
  triangle LFO modulating `delayTime` **in seconds** (±depth·0.004 s), with the
  R-side LFO inverted for antiphase width.
- **Delay** — legal feedback loop (delay → tone lowpass → feedback gain → sum);
  subdivision `timeMs = (60/BPM)·factor` [1, 0.5, 0.75, 2]; analog/tape add
  0.5/0.3 Hz wobble on `delayTime` (±0.3/1 ms) — BBD "wow" on the repeats.
- **Reverb** — predelay → low-cut highpass → `ConvolverNode` with **synthesized
  IRs** (2 decorrelated noise channels × `(1−n/N)^k`; room k=2.2, hall 2.8,
  plate 1.3 + dense early build-up, spring 3.2 + discrete "boing" reflections),
  cached per type/decay at the context sample rate → high-cut lowpass.
- **Every pedal** — wet/dry crossfade engage (15 ms), `setTargetAtTime` for all
  parameter writes (no zipper noise), trails ring-out before node-graph
  disposal, lazy build on first stomp → **zero idle audio-thread cost**.

## 4. Web Audio pitfalls honored

1. `delayTime` is **seconds** and a-rate — LFO depth gains are scaled in
   seconds, never `.value` writes per frame.
2. WaveShaper aliasing — 8192-point curves + `oversample: '4x'`.
3. Feedback loops must contain a `DelayNode`, clamped < 0.95.
4. `ConvolverNode` IR buffers must be created at the context's sampleRate.
5. DynamicsCompressor params are k-rate — smooth UI writes only.
6. Bypass = crossfade, never `disconnect()` mid-audio.
7. `AudioContext` creation/resume inside the engage gesture (autoplay policy).

## 5. Sources

- JHS Pedals — "How to order your pedals": <https://www.jhspedals.info/pages/how-to-order-your-pedals>
- Worship Tutorials — worship guitar rig: <https://worshiptutorials.com/blog/electric-guitar-rig-for-worship-music/>
- Worship Tutorials — ambient swell patch parameters: <https://worshiptutorials.com/gear/helix-faqs-how-to-set-up-an-ambient-swell-sound/>
- Boss product pages (SD-1, BD-2, CS-3, CH-1, PH-3, TR-2, BF-3, DD-8, RV-6, NS-2): <https://www.boss.info/>
- EHX Soul Food (Klon-derived) / POG2: <https://www.ehx.com/>
- MXR Phase 90 / Ten Band EQ: <https://www.jimdunlop.com/>
- W3C Web Audio API spec: <https://webaudio.github.io/web-audio-api/>
- MDN WaveShaperNode / DelayNode / AudioParam best practices: <https://developer.mozilla.org/>
- Google Audio-Input-Effects reference implementation: <https://github.com/cwilso/Audio-Input-Effects>
