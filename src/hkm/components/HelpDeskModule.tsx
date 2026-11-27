import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, Search, ChevronRight, LifeBuoy, Keyboard } from 'lucide-react';

/* ==========================================================================
   HELP DESK — the console's operation manual.
   Every piece of long-form guidance that used to live on the mixing
   surfaces (setup checklists, method walkthroughs, rig checklists,
   field advice) is organized here, off the operational dashboards,
   the way real consoles keep the manual separate from the surface.
   Dashboards link here through requestHelpTopic() deep links.
   ========================================================================== */

export type HelpTopicId =
  | 'quick-start'
  | 'input-conditioning'
  | 'dsp-chain'
  | 'console-deck'
  | 'feedback'
  | 'acoustics'
  | 'speakers'
  | 'routing'
  | 'microphones'
  | 'instruments'
  | 'virtual-di'
  | 'livestream'
  | 'recorder'
  | 'soundcheck'
  | 'presets'
  | 'ai-engineer'
  | 'hardware-bridge'
  | 'midi'
  | 'shortcuts'
  | 'troubleshooting';

/** Deep-link bus so any dashboard can open the Help Desk on a topic. */
let pendingTopic: HelpTopicId | null = null;
export const requestHelpTopic = (topic: HelpTopicId) => {
  pendingTopic = topic;
};
/** Deep link from any dashboard: raises the navigation event App listens
    for, then hands the topic to the (freshly mounted or live) Help Desk. */
export const openHelpTopic = (topic: HelpTopicId) => {
  pendingTopic = topic;
  window.dispatchEvent(new CustomEvent('hkm-navigate-module', { detail: 'help' }));
  window.dispatchEvent(new CustomEvent('hkm-help-topic'));
};
const takePendingTopic = (): HelpTopicId | null => {
  const t = pendingTopic;
  pendingTopic = null;
  return t;
};

interface HelpBlock {
  kind: 'p' | 'steps' | 'list' | 'table' | 'note';
  text?: string;
  items?: string[];
  rows?: string[][];
  head?: string[];
}

interface HelpTopic {
  id: HelpTopicId;
  title: string;
  subtitle: string;
  blocks: HelpBlock[];
}

interface HelpCategory {
  label: string;
  topics: HelpTopic[];
}

export const HELP_CATEGORIES: HelpCategory[] = [
  {
    label: 'Operation Basics',
    topics: [
      {
        id: 'quick-start',
        title: 'Quick Start — First Service',
        subtitle: 'From a dark console to a mixed service in three moves',
        blocks: [
          {
            kind: 'p',
            text: 'This console follows the same law as every digital mixer: pick a live input, start the engine, then mix. Everything else — feedback suppression, room tuning, streaming — rides on top of those three moves.',
          },
          {
            kind: 'steps',
            items: [
              'Pick your input — open the INPUTS panel (left) and assign a live microphone or line source to a channel strip. Unassigned strips stay dark OPEN SLOTS until a hardware input is patched into them.',
              'Start the engine — press START (top-right). The DSP engine begins processing; channel meters and the central signal chain come alive.',
              'Pair the companion (optional) — Hardware → REMOTE ACCESS shows a QR code your phone can scan for mobile FOH control from anywhere in the sanctuary.',
            ],
          },
          {
            kind: 'note',
            text: 'Every change you make is saved automatically — power loss or a crash restores the exact console state on the next launch. You never need to save a show file manually.',
          },
        ],
      },
      {
        id: 'input-conditioning',
        title: 'Input Conditioning & Channel Strip',
        subtitle: 'MIC / LINE / INST domains, 48V, pad, polarity, fader, bus assigns',
        blocks: [
          {
            kind: 'p',
            text: 'The INPUT CONDITIONING card (first card of the DSP signal chain) is the complete channel strip for whichever channel is selected — the same order a physical console uses: source, gain, switches, mute/solo, fader, bus assigns.',
          },
          {
            kind: 'table',
            head: ['Mode', 'Connector', 'Level domain', 'Gain range'],
            rows: [
              ['MIC', 'XLR, balanced', 'Mic level · −56..−29 dBu', 'Up to +60 dB (48V available)'],
              ['LINE', 'TRS jack, balanced', 'Line level · +4 dBu / −10 dBV', '±6 dB trim'],
              ['INST', '¼" Hi-Z, ≥1 MΩ', 'Instrument · −20..0 dBu', 'Up to +30 dB (no 48V)'],
            ],
          },
          {
            kind: 'list',
            items: [
              '+48V — phantom power for condenser microphones. Mic domain only: it is hardware-interlocked and locks out on LINE and INST jacks. Sending phantom into an instrument or unprotected DI can destroy it.',
              '-20 PAD — inserts a 20 dB pad when hot sources clip the preamp (typically during full-band chorus or line-level playback).',
              'Ø — polarity invert. Flip when a DI + mic blend cancels low end, or to align subwoofers.',
              'ACTIVE / SOLO — the channel ON (mute) key and solo-isolate key, sized for a finger the way real console keys are.',
              'Fader — −48..+10 dB with calibrated tick ladder; double-click any fader or knob to snap it back to unity/default.',
              'MAIN PA / STREAM / SUB — mix bus assigns at the bottom of the strip, exactly where consoles put them.',
            ],
          },
        ],
      },
      {
        id: 'dsp-chain',
        title: 'Central DSP Chain',
        subtitle: 'The 7-stage signal path from input conditioning to monitor mixes',
        blocks: [
          {
            kind: 'p',
            text: 'The SIGNAL CHAIN view mirrors a real console’s processing order left to right: INPUT CONDITIONING → AUTOMATIC GAIN CONTROL → EQUALIZATION → COMPRESSION → FEEDBACK-SAFE PROCESSING (FBX + HPF + hum trap) → EFFECTS SENDS → MONITOR MIXES, with MAIN OUTPUTS below. The glowing seams show live signal flow: green = processing active, teal = DSP bypassed, red = muted.',
          },
          {
            kind: 'list',
            items: [
              'Sub-views: 31-BAND GEQ (graphic EQ), 3-WAY XOVER (crossover), ZERO-HUM (clean standby gate), and YAML (generated CamillaDSP pipeline export).',
              'A/B — store snapshots to slot A and B and toggle A↔B to compare two mix states instantly, like console snapshot compare.',
              'Drag knobs vertically or scroll to adjust; double-click resets. The COMPRESSION column shows live gain reduction (GR).',
            ],
          },
        ],
      },
      {
        id: 'console-deck',
        title: 'Console Deck — 7 Processing Phases',
        subtitle: 'Phase-by-phase walk from stage preamp to the matrix',
        blocks: [
          {
            kind: 'p',
            text: 'The CONSOLE module walks the mix through the same phases in signal order: 1 Stage Preamp & Ground Hum Traps, 2 HPF/LPF Filters & Zero-Hum Standby Gate, 3 Parametric EQ, 4 Dynamics (compressor + limiter), 5 31-Band Graphic EQ, 6 3-Way Crossover, 7 Matrix / bus routing.',
          },
          {
            kind: 'list',
            items: [
              'MAINS HUM NOTCH TRAP — OFF / 50 Hz / 60 Hz removes AC ground hum and its harmonics with zero phase smear. Pick the region that matches your wall power (50 Hz Europe/Africa/Asia, 60 Hz Americas).',
              'Subsonic DC protection (18 Hz Butterworth) runs permanently ahead of the fader to keep DC offset and rumble out of the bus.',
              'PFL headroom is +18 dBFS — solo a channel and its meter aligns to the same reference the limiter uses.',
              'INSTRUMENT RIG CHECKLIST (INST mode): 1) confirm the guitar/bass cable runs through Hi-Z or a DI before the strip, 2) keep +48V disengaged (it is locked out automatically), 3) engage the -20 dB pad for hot active pickups, 4) the hum trap stays armed at your mains frequency.',
            ],
          },
        ],
      },
    ],
  },
  {
    label: 'Analysis & Tuning',
    topics: [
      {
        id: 'feedback',
        title: 'Feedback Detection & RTA',
        subtitle: 'Reading the dual-trace FFT and the notch rack',
        blocks: [
          {
            kind: 'p',
            text: 'The FEEDBACK module runs a 4096-point dual-trace FFT with a scrolling frequency waterfall (30-second rolling window) plus an adaptive surgical notch rack. The horizontal axis is a 20 Hz – 20 kHz log scale; a vertical ridge in the waterfall marks transient ringing energy — the signature of a feedback candidate before it blooms.',
          },
          {
            kind: 'list',
            items: [
              'Ring candidates appear as notch proposals with frequency, depth and Q — approve to write them into the DSP EQ chain, or dismiss to keep listening.',
              'The waterfall reads best with the engine running and the PA live: a growing ridge at one frequency is your early warning to cut that band or pull the fader.',
              'Feedback suppression (FBX) lives in the DSP chain’s FEEDBACK-SAFE PROCESSING column — check the LED there to confirm it is armed.',
            ],
          },
        ],
      },
      {
        id: 'acoustics',
        title: 'Acoustic & Room Analyzer',
        subtitle: 'REW workflow, room modes, RT60 targets, UMIK-1 calibration',
        blocks: [
          {
            kind: 'p',
            text: 'The ACOUSTIC module is a REW-style room analyzer for the sanctuary. The measured readouts summarize what the sweep found: axial room mode buildup (typically 63–80 Hz in a hall), low-mid reflection clusters, and RT60 per band. Worship music tolerates RT60 around 1.2–1.5 s at 1 kHz; unassisted speech prefers under 1.0 s.',
          },
          {
            kind: 'steps',
            items: [
              'Measure 4+ sanctuary seating zones (front, center, balcony, platform) — a single measurement point misses the mode nulls.',
              'Verify subwoofer polarity before any EQ: a wrong polarity sub digs a hole exactly where worship needs weight.',
              'Treat early reflections (side walls, stage ceiling) physically before cutting global EQ — absorbers fix what EQ can only hide.',
              'Only then export room-mode cuts: the analyzer can write a −3.5 dB modal cut at the measured peak straight into EQ band 1.',
            ],
          },
          {
            kind: 'note',
            text: 'A miniDSP UMIK-1 with its 90° calibration file active permits room-correction filter export. The measured analysis and next-step recommendations that used to sit on this dashboard now live here — the surface keeps only live readouts.',
          },
        ],
      },
      {
        id: 'speakers',
        title: 'Speaker Management & Zones',
        subtitle: 'Zone health, alignment delay, crossover per zone',
        blocks: [
          {
            kind: 'p',
            text: 'The SPEAKERS module manages every zone as its own processor: front mains, center sub array, rear balcony, platform/foldback, foyer and cry room. Each zone carries its own level, delay and crossover; the zone health LEDs summarize live status per zone — green = delivering signal, amber = limiter active, red = emergency-muted or no route.',
          },
          {
            kind: 'list',
            items: [
              'Alignment math: delay a rear or balcony zone by its distance offset ÷ 343 m/s so wavefronts arrive together with the mains.',
              'LR24 / BW18 matrix — the crossover slopes used by default (Linkwitz-Riley 24 dB/oct for crossovers, Butterworth 18 dB/oct for the sub low-pass).',
              'EMERGENCY MUTE stops all zones at once; the per-zone enable keys remain independent during a service.',
            ],
          },
        ],
      },
    ],
  },
  {
    label: 'Inputs & Sources',
    topics: [
      {
        id: 'microphones',
        title: 'Microphone Intelligence',
        subtitle: 'Polar null geometry, GBF margin, mic fleet profiles',
        blocks: [
          {
            kind: 'p',
            text: 'The MICS module treats microphones as geometry, not just faders. Each mic profile carries its pickup pattern and null angle: a supercardioid pulpit mic nulls around 120–126° off-axis, cardioids null at 180° (directly behind).',
          },
          {
            kind: 'list',
            items: [
              'Aim the null at the loudest problem — for supercardioid wedges, keep floor monitors slightly BEHIND the microphone (off the back axis), since the null is not straight back like a cardioid.',
              'WEDGE ANG knob rotates the monitor wedge direction marker around the live polar plot so you can see exactly where the wedge sits relative to the null.',
              'MIC DIST sets mouth-to-capsule distance; the GBF (gain-before-feedback) margin gauge recalculates live as you change distance and wedge angle.',
              'PREAMP / HPF / COMP THR / DE-ESS knobs preview each profile’s recommended channel strip settings — APPLY writes them to the DSP.',
            ],
          },
        ],
      },
      {
        id: 'instruments',
        title: 'Instrument & Worship Band Intelligence',
        subtitle: 'DI boxes, ground loops, and the frequency masking map',
        blocks: [
          {
            kind: 'p',
            text: 'The BAND module maps the worship team’s frequency real estate. The masking matrix shows each instrument’s lane so instruments don’t pile onto the same octave — the classic mud zone is 200–400 Hz where keys, acoustic guitar and bass all overlap.',
          },
          {
            kind: 'steps',
            items: [
              'Inspect for 50/60 Hz mains hum with the instrument’s volume at zero — if hum persists, it is a ground loop, not the pickup.',
              'If hum persists at zero volume, engage the DI box’s physical GROUND LIFT switch before touching EQ.',
              'Use an ACTIVE DI (or 48V-powered DI) for passive jazz/precision-style pickups — their weak signal needs headroom a passive DI cannot give.',
              'Check the pad (−20 dB) on hot active pickups or modeled instruments when preamps clip during full-band chorus.',
            ],
          },
          {
            kind: 'note',
            text: 'The lane advice engraved on each masking row (HPF points, carve frequencies, vocal pocket 2.5–5.5 kHz) follows standard live-sound practice: keep the vocal pocket clear, carve per instrument, HPF everything that is not a bass or kick.',
          },
        ],
      },
      {
        id: 'virtual-di',
        title: 'Virtual DI & Bass Processor',
        subtitle: 'String-scale fundamentals and the bi-amp low end',
        blocks: [
          {
            kind: 'p',
            text: 'The VIRTUAL DI models an active DI input stage with a 50/60 Hz mains hum suppressor and a bi-amp low comp + harmonic tube drive. String scale sets the subsonic HPF law: a 4-string bass fundamentals reach E1 ≈ 41.2 Hz, a 5-string reaches B0 ≈ 30.9 Hz.',
          },
          {
            kind: 'list',
            items: [
              'Keep the Subsonic HPF at 32–40 Hz — high enough to shed rumble and DC, low enough to keep the fundamental weight the congregation feels.',
              '5-string/low-tuned basses: bias toward 32 Hz so B0 survives; 4-string pop styles can sit at 40 Hz.',
              'Low Comp + Harmonic Tube Drive add the "rig push" — drive raises harmonic saturation exactly like pushing an SVT-style stack.',
            ],
          },
        ],
      },
    ],
  },
  {
    label: 'Broadcast & Capture',
    topics: [
      {
        id: 'livestream',
        title: 'Livestream & OBS Studio',
        subtitle: 'Application Audio Capture — the zero-driver OBS route',
        blocks: [
          {
            kind: 'p',
            text: 'OBS captures HKM’s post-DSP application audio directly using OBS’s built-in Application Audio Capture source — no VB-Audio cable and no extra audio driver is required. The same signal HKM plays through the PA is what OBS receives; the separate broadcast mastering rack below is not inserted into that application audio path.',
          },
          {
            kind: 'steps',
            items: [
              'In OBS Studio 28+ on Windows: Sources → + → Application Audio Capture (BETA).',
              'Select the [hkm-audio-system.exe]: HKM Audio System window and name the source "HKM Processed Audio".',
              'In OBS Settings → Audio, disable global Desktop Audio to prevent a second, unprocessed copy.',
              'Leave the source’s audio monitoring off, add it to the stream scenes, and assign it to the intended stream track.',
            ],
          },
          {
            kind: 'list',
            items: [
              'Connect OBS WebSocket (v5, port 4455, enabled in OBS Studio’s settings) to sync live program scenes, stream controls and dropped-frame telemetry inside HKM.',
              'With WebSocket connected, HKM auto-detects the named processed-audio source and lights SOURCE DETECTED — confirm its OBS meter moves while HKM audio plays.',
              'OBS application capture itself works without WebSocket; WebSocket adds the control surface on top.',
            ],
          },
        ],
      },
      {
        id: 'recorder',
        title: 'Multitrack Service Recorder',
        subtitle: 'Arming stems and capturing the service',
        blocks: [
          {
            kind: 'p',
            text: 'The RECORDER arms any input channel as a stem lane. Each lane shows its live level while armed; pressing REC captures waveform data per armed stem with the master timer running. Stems record pre-fader unless the lane is switched post-fader.',
          },
          {
            kind: 'list',
            items: [
              'ARM toggles a stem lane; REC starts all armed lanes together; ■ stops and finalizes the take.',
              'The status LEDs mirror console transport: red = recording, amber = armed/standby, dark = disarmed.',
            ],
          },
        ],
      },
      {
        id: 'soundcheck',
        title: 'Automated Sound Check',
        subtitle: 'The 4-phase telemetry audit before doors',
        blocks: [
          {
            kind: 'p',
            text: 'SOUNDCHK runs a 4-phase verification sweep of the whole console — reference target, per-channel headroom, noise floor and clip audit — against a nominal −18 dBFS trim target. Each phase reports PASS / WARN / FAIL with per-channel values.',
          },
          {
            kind: 'list',
            items: [
              'Nominal trim is applied through the software DSP chain. When HKM rides on top of an analog mixer, verify that mixer’s physical preamps manually — software cannot reach analog knobs.',
              'The per-channel audit table reads live RMS, noise floor and clip status per strip; STANDBY rows mean the engine has not yet measured that channel.',
              'RESET clears the sequence and re-runs from phase 1 — safe to run as many times as needed before the service.',
            ],
          },
        ],
      },
    ],
  },
  {
    label: 'Show Control',
    topics: [
      {
        id: 'presets',
        title: 'Presets, Cues & Snapshots',
        subtitle: 'Scene memory, the cue sequencer, and the version vault',
        blocks: [
          {
            kind: 'p',
            text: 'PRESETS holds three layers of show control: the SUNDAY SERVICE CUE SEQUENCER (DSP + OBS-linked recall in service order), the 8-slot SCENE MEMORY BANK with per-scene parameter diffs, and the VERSIONED CONFIGURATION VAULT that snapshots full console state with notes for rollback.',
          },
          {
            kind: 'list',
            items: [
              'Click any cue to recall its audio & stream scene instantly — cues fire DSP state + OBS scene together.',
              'DIFF compares a stored scene against the live console parameter-by-parameter (HPF cutoff, comp threshold/ratio, limiter ceiling, stream LUFS target…).',
              'The vault is your undo history: save a baseline before live edits, roll back if a service goes sideways. Snapshot notes like "Sunday Sermon Trim" make rollbacks self-explanatory.',
            ],
          },
        ],
      },
      {
        id: 'ai-engineer',
        title: 'AI Sound Engineer',
        subtitle: 'Authority model and the human-approve workflow',
        blocks: [
          {
            kind: 'p',
            text: 'The AI ENGINEER observes telemetry, diagnoses faults and proposes safe DSP patches — but never touches the console alone. Its workflow is: observe → diagnose → propose → engineer approves & verifies. Findings queue for a human, and every approved patch is logged to the audit trail.',
          },
          {
            kind: 'list',
            items: [
              'HW AUTHORITY — parameters owned by physical knobs on the live audio device (manual adjustment required; software only advises).',
              'SW DSP AUTHORITY — everything CamillaDSP-class processing can reach: PEQ, HPF, dynamics, limiter and stream bus.',
              'The console terminal answers sanctuary questions ("Why is the preacher’s microphone unclear?") and can propose the corresponding patch; approvals still route through the findings queue.',
            ],
          },
        ],
      },
      {
        id: 'routing',
        title: 'Universal Routing & Virtual Patchbay',
        subtitle: 'Bus matrix, cycle-guarded patching, OBS second route',
        blocks: [
          {
            kind: 'p',
            text: 'The MATRIX module is the universal patchbay: 8 input strips × 4 aux/matrix buses × 5 speaker zones with DAG feedback protection (a route that would create an audio cycle is refused instead of howling).',
          },
          {
            kind: 'list',
            items: [
              'PHYSICAL SPEAKER / PA OUTPUT — the built-in/DAC endpoint the PA and zones play through. Selected from the scanned system outputs.',
              'OPTIONAL SECONDARY PLAYBACK DEVICE — an independent second output (e.g. a USB headphone amp for a cry-room feed). This route is a plain playback route: it is not an OBS input and needs no virtual cable.',
              'OBS captures HKM audio separately through Application Audio Capture — see the Livestream topic for the 4-step setup.',
            ],
          },
        ],
      },
    ],
  },
  {
    label: 'System & Hardware',
    topics: [
      {
        id: 'hardware-bridge',
        title: 'System Audio Bridge & Hardware',
        subtitle: 'Both desktop-audio capture methods, explained',
        blocks: [
          {
            kind: 'p',
            text: 'The SYSTEM AUDIO INPUT BRIDGE routes desktop/media/browser audio into the DSP without a loopback howl. It runs one of two methods, guarded by an automatic Self-Loopback Firewall.',
          },
          {
            kind: 'steps',
            items: [
              'METHOD 1 — Web Audio getDisplayMedia (zero driver): pick a browser tab, Spotify, YouTube or OS media audio. The picker enforces selfBrowserSurface: "exclude" so this console can never capture itself, and suppresses local playback so the source is not doubled acoustically.',
              'METHOD 2 — Specialized virtual interface: a VB-Audio Cable, BlackHole, Stereo Mix or VoiceMeeter device shows up as a specialized input with zero picker dialogs and no admin rights. Click Refresh Hardware after installing one, or after enabling Stereo Mix in Windows Sound settings.',
            ],
          },
          {
            kind: 'list',
            items: [
              'AUTO-RECOGNIZED HARDWARE: USB VID/PID fingerprinting profiles interfaces and controllers, internal sound cards are auto-profiled, and LAN OSC consoles are discovered — all with a hot-plug listener.',
              'The Self-Loopback Firewall blocks a capture route the moment it would feed the console its own output — the classic blue-screen-of-hum loopback killer on streaming PCs.',
              'Tier 1–4 mixer/interface support: from stereo-USB mixers (Tier 1) to full networked matrix consoles (Tier 4), with per-tier capability notes shown in the device list.',
            ],
          },
        ],
      },
      {
        id: 'midi',
        title: 'MIDI & Control Surfaces',
        subtitle: 'Templates, MIDI learn, and the binding matrix',
        blocks: [
          {
            kind: 'p',
            text: 'The MIDI module binds physical control surfaces to console parameters. Windows WinMM / Windows MIDI Services enumerate USB class-compliant ports; MIDI Learn maps any fader, encoder or pad to any console control with bidirectional LED feedback.',
          },
          {
            kind: 'list',
            items: [
              'BEHRINGER X-TOUCH COMPACT — motorized faders (CC 1–8), encoders (CC 10–17), mute buttons (Note 0–7), with full factory layout in the template.',
              'KORG NANOCONTROL2 (nanoKONTROL2) — 8 faders/knobs/pods per bank with cycle banks; template maps CCs 0–15 straight to the input strips.',
              'AKAI PROFESSIONAL MIDI MIX — 3 banks of 8 faders (CC 0–23) + mute/solo rows (CCs 48–63); the classic budget FOH sidecar.',
              'VIRTUAL HARDWARE MIDI SURFACE — the built-in test bench: drag its faders and pads to try MIDI Learn without any hardware attached.',
              'No physical ports yet? Connect a controller or use the virtual surface — the ports monitor lights up with activity LEDs the moment WinMM reports a device.',
            ],
          },
        ],
      },
      {
        id: 'shortcuts',
        title: 'Keyboard Shortcuts',
        subtitle: 'Global keys and the shortcut editor',
        blocks: [
          {
            kind: 'p',
            text: 'Shortcuts are editable in the MIDI module’s KEYBOARD SHORTCUTS section and can be scoped to the global console or the active module. The last triggered shortcut and any conflicts surface inline.',
          },
          {
            kind: 'list',
            items: [
              'Typical defaults: engine start/stop, master mute, DSP bypass, preset recall, module jumps, tap tempo — all listed live in the editor.',
              'Click a shortcut’s key chip to rebind; conflicts with an existing binding are flagged immediately.',
            ],
          },
        ],
      },
      {
        id: 'troubleshooting',
        title: 'Troubleshooting & Field FAQ',
        subtitle: 'The calls you get on a Sunday morning',
        blocks: [
          {
            kind: 'list',
            items: [
              'No sound from the PA — check the bottom bar: engine running? Emergency mute dark? Main output device still selected in Hardware?',
              'Hum on one channel — hum trap OFF? Set 50/60 Hz to your mains region; for DI sources check ground lift (see the Band topic).',
              'Mic sounds thin/distant — confirm +48V for condensers, check the strip is not padded, and re-check the input mode is MIC not LINE.',
              'Feedback during service — the FBX column LED armed? Watch the waterfall ridge frequency and pull that band first.',
              'Stream has no HKM audio — OBS Application Audio Capture source still selected? Desktop Audio disabled? See the Livestream topic.',
              'Console state looks wrong after a crash — auto-save restores the last state; use the vault to roll back to a known-good snapshot.',
            ],
          },
        ],
      },
    ],
  },
];

const FLAT_TOPICS: { topic: HelpTopic; category: string }[] = HELP_CATEGORIES.flatMap((c) =>
  c.topics.map((topic) => ({ topic, category: c.label }))
);

interface HelpDeskModuleProps {
  panelLocked?: boolean;
}

export const HelpDeskModule: React.FC<HelpDeskModuleProps> = ({ panelLocked = false }) => {
  const deepLink = useMemo(() => takePendingTopic(), []);
  const [activeId, setActiveId] = useState<HelpTopicId>(deepLink ?? 'quick-start');
  const [query, setQuery] = useState('');

  useEffect(() => {
    // Listen for live deep links raised while already mounted.
    const handler = () => {
      const t = takePendingTopic();
      if (t) setActiveId(t);
    };
    window.addEventListener('hkm-help-topic', handler);
    return () => window.removeEventListener('hkm-help-topic', handler);
  }, []);

  const requestLiveTopic = (topic: HelpTopicId) => {
    pendingTopic = topic;
    window.dispatchEvent(new CustomEvent('hkm-help-topic'));
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? FLAT_TOPICS.filter(
        ({ topic }) =>
          topic.title.toLowerCase().includes(q) ||
          topic.subtitle.toLowerCase().includes(q) ||
          topic.blocks.some((b) => (b.text ?? '').toLowerCase().includes(q))
      )
    : FLAT_TOPICS;

  const active = FLAT_TOPICS.find(({ topic }) => topic.id === activeId) ?? FLAT_TOPICS[0];

  const renderBlock = (block: HelpBlock, key: number) => {
    switch (block.kind) {
      case 'p':
        return (
          <p key={key} className="text-[12px] leading-relaxed text-slate-300">
            {block.text}
          </p>
        );
      case 'note':
        return (
          <div
            key={key}
            className="rounded-md border border-emerald-500/30 bg-emerald-950/25 px-3 py-2 text-[11px] leading-relaxed text-emerald-200/90"
          >
            {block.text}
          </div>
        );
      case 'steps':
        return (
          <ol key={key} className="space-y-1.5">
            {block.items?.map((item, i) => (
              <li key={i} className="flex gap-2.5 text-[12px] leading-relaxed text-slate-300">
                <span className="shrink-0 w-5 h-5 rounded border border-teal-500/40 bg-teal-500/10 text-teal-300 font-mono text-[10px] font-bold flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ol>
        );
      case 'list':
        return (
          <ul key={key} className="space-y-1.5">
            {block.items?.map((item, i) => (
              <li key={i} className="flex gap-2.5 text-[12px] leading-relaxed text-slate-300">
                <span className="shrink-0 mt-[7px] w-1.5 h-1.5 rounded-full bg-teal-400/80" />
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        );
      case 'table':
        return (
          <div key={key} className="overflow-x-auto rounded-md border border-[#2A3646]">
            <table className="w-full text-[11px] font-mono">
              {block.head && (
                <thead>
                  <tr className="hw-card-subheader">
                    {block.head.map((h, i) => (
                      <th key={i} className="px-2.5 py-1.5 text-left text-[9px] uppercase tracking-wider text-slate-400 font-bold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {block.rows?.map((row, i) => (
                  <tr key={i} className="border-t border-[#1C2530]">
                    {row.map((cell, j) => (
                      <td key={j} className="px-2.5 py-1.5 text-slate-300 whitespace-nowrap">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 select-none">
      {/* Header — console badge style, one line */}
      <div className="shrink-0 hw-card rounded-md overflow-hidden">
        <div className="hw-card-header h-9 px-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <LifeBuoy className="w-3.5 h-3.5 text-teal-300 shrink-0" />
            <span className="font-mono text-[11px] font-bold tracking-[0.14em] uppercase text-slate-100 truncate">
              Help Desk — Operation Manual &amp; Field Guide
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[#2A3646] bg-[#0A0F16]">
              <Search className="w-3 h-3 text-slate-500 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={panelLocked}
                placeholder="SEARCH MANUAL"
                aria-label="Search help topics"
                className="w-36 bg-transparent outline-none font-mono text-[10px] uppercase tracking-wider text-slate-200 placeholder:text-slate-600"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[240px_1fr] gap-2">
        {/* Topic rail */}
        <nav
          aria-label="Help topics"
          className="min-h-0 hw-card rounded-md overflow-y-auto overflow-x-hidden p-1.5 space-y-2"
        >
          {!q &&
            HELP_CATEGORIES.map((cat) => (
              <div key={cat.label}>
                <div className="px-1.5 pb-1 font-mono text-[8.5px] font-bold uppercase tracking-[0.18em] text-slate-500">
                  {cat.label}
                </div>
                <div className="space-y-0.5">
                  {cat.topics.map((topic) => {
                    const isActive = topic.id === active.topic.id;
                    return (
                      <button
                        key={topic.id}
                        type="button"
                        onClick={() => setActiveId(topic.id)}
                        aria-current={isActive ? 'page' : undefined}
                        className={`w-full text-left px-2 py-1.5 rounded border font-mono text-[10px] leading-tight transition-colors cursor-pointer ${
                          isActive
                            ? 'border-teal-400/60 bg-[#12222A] text-teal-200 font-bold'
                            : 'border-transparent text-slate-400 hover:text-slate-100 hover:bg-[#131A23]'
                        }`}
                      >
                        <span className="block truncate">{topic.title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          {q && (
            <div className="space-y-0.5">
              <div className="px-1.5 pb-1 font-mono text-[8.5px] font-bold uppercase tracking-[0.18em] text-slate-500">
                {filtered.length} match{filtered.length === 1 ? '' : 'es'}
              </div>
              {filtered.map(({ topic }) => (
                <button
                  key={topic.id}
                  type="button"
                  onClick={() => setActiveId(topic.id)}
                  className={`w-full text-left px-2 py-1.5 rounded border font-mono text-[10px] leading-tight transition-colors cursor-pointer ${
                    topic.id === active.topic.id
                      ? 'border-teal-400/60 bg-[#12222A] text-teal-200 font-bold'
                      : 'border-transparent text-slate-400 hover:text-slate-100 hover:bg-[#131A23]'
                  }`}
                >
                  <span className="block truncate">{topic.title}</span>
                  <span className="block text-[8px] text-slate-600 truncate">{topic.subtitle}</span>
                </button>
              ))}
            </div>
          )}
        </nav>

        {/* Topic page */}
        <article className="min-h-0 hw-card rounded-md overflow-y-auto p-4 lg:p-5">
          <div className="max-w-3xl mx-auto space-y-4">
            <header className="border-b border-[#242E3B] pb-3 space-y-1.5">
              <div className="flex items-center gap-2 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-teal-300">
                <BookOpen className="w-3 h-3 shrink-0" />
                <span className="truncate">{active.category}</span>
              </div>
              <h2 className="text-lg font-semibold text-slate-100 leading-tight">{active.topic.title}</h2>
              <p className="font-mono text-[10.5px] text-slate-500">{active.topic.subtitle}</p>
            </header>
            <div className="space-y-4">
              {active.topic.blocks.map((block, i) => renderBlock(block, i))}
            </div>
            <footer className="border-t border-[#242E3B] pt-3 flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-slate-600">
                <Keyboard className="w-3 h-3" />
                <span>HKM Master Audio Console · Manual v1.2</span>
              </div>
              <button
                type="button"
                onClick={() => requestLiveTopic('troubleshooting')}
                className="font-mono text-[9px] uppercase tracking-wider text-teal-400 hover:text-teal-300 cursor-pointer"
              >
                Field FAQ →
              </button>
            </footer>
          </div>
        </article>
      </div>
    </div>
  );
};
