import type { AudioSourceSimulation, SpeakerZone } from '../types/audio.ts';
import { isDesktopApp } from '../utils/appApi.ts';
import { pushRawOutputPcm, startRawOutput, stopRawOutput } from '../utils/nativeDesktopAudio.ts';
import {
  SIM_PIE_8OUT_DEVICE_ID,
  orderedJackSlots,
  parseJackId,
  slotChannelIndices,
  type OutputJackSlot,
} from '../utils/jackTopology.ts';
import { clamp, dbToLinear } from './audioUtils.ts';
import {
  INITIAL_DESKTOP_BRIDGE_STATE,
  evaluateDesktopLoopbackSafety,
  type LoopbackSafetyResult,
  type SystemAudioBridgeState,
  type SystemAudioCaptureMethod,
} from './systemAudioBridge.ts';

interface JackZoneDspChain {
  filterA: BiquadFilterNode;
  filterB: BiquadFilterNode;
  gain: GainNode;
  delay: DelayNode;
  splitter: ChannelSplitterNode;
  centerLfeSubFilterA?: BiquadFilterNode;
  centerLfeSubFilterB?: BiquadFilterNode;
  centerLfeSubGain?: GainNode;
  centerLfeSubDelay?: DelayNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}

interface AuxZoneHardwareSink {
  deviceId: string;
  filterA: BiquadFilterNode;
  filterB: BiquadFilterNode;
  delay: DelayNode;
  gain: GainNode;
  dest: MediaStreamAudioDestinationNode;
  audioEl: HTMLAudioElement;
}

/**
 * Manages all Console Outputs + Desktop Audio Self-Loopback Firewall:
 *   1. Main Monitor / PA Output (`monitorGain -> paZoneDelayNode -> paZoneGainNode -> ctx.destination`)
 *      — upgraded with the DISCRETE JACK ROUTER: when the active sink is a
 *      5.1/7.1 PCIe or onboard card (or configured in discrete jack mode), each
 *      physical jack pair (FL/FR Green, FC/LFE Orange, BL/BR Black, SL/SR Grey,
 *      plus generated AUX pairs for channels 8+ on pro cards)
 *      receives its own independent zone signal with per-zone Linkwitz-Riley /
 *      Butterworth crossover filtering, delay alignment, polarity, and trim!
 *      Furthermore, on the Orange `center-lfe` jack (channels 2 & 3), if both a
 *      `center` zone and a `sub` zone exist, Channel 2 (FC) carries the high-passed
 *      Center mono vocal feed while Channel 3 (LFE) carries the low-passed Subwoofer feed!
 *   2. Simultaneous Multi-Device Zone Outputs (`auxZoneSinks`):
 *      Any unmuted `SpeakerZone` assigned to a `hardwareOutputId` different from
 *      the primary `ctx.destination` device automatically renders in parallel
 *      through its own DSP chain (`monitorGain -> filter -> delay -> gain -> MediaStreamDestination -> Audio.setSinkId`),
 *      allowing multiple physical audio outputs (PCIe card + USB interface + HDMI + Headphones)
 *      to be turned on at the exact same time!
 *   3. Dedicated Stream / OBS Output (`streamOutputGain -> MediaStreamDestination -> Audio.setSinkId`)
 *      — independent of `MON`, always active when engine is running and a stream device is selected.
 *   4. Native Windows WASAPI RAW / MFX Output Tap (`rawTapNode -> pushRawOutputPcm`)
 */
export class OutputRouter {
  private ctx: AudioContext | null = null;
  private postAnalyser: AnalyserNode | null = null;

  private monitorGain: GainNode | null = null;
  private paZoneFilterA: BiquadFilterNode | null = null;
  private paZoneFilterB: BiquadFilterNode | null = null;
  private paZoneDelayNode: DelayNode | null = null;
  private paZoneGainNode: GainNode | null = null;
  private lastZones: SpeakerZone[] = [];

  private streamOutputGain: GainNode | null = null;
  private streamMediaDest: MediaStreamAudioDestinationNode | null = null;
  private streamAudioEl: HTMLAudioElement | null = null;

  // ---- Simultaneous Multi-Device Zone Sinks (Zone -> distinct physical output device) ----
  private auxZoneSinks = new Map<string, AuxZoneHardwareSink>();

  // ---- Discrete jack router (5.1/7.1/N-channel channel-pair zone routing) ----
  private jackMerger: ChannelMergerNode | null = null;
  private jackZoneChains = new Map<OutputJackSlot, JackZoneDspChain>();
  private jackLayoutChannels = 0; // 0 = legacy stereo path, else 6/8/10..32
  private jackSlotZones = new Map<OutputJackSlot, string>(); // slot -> zoneId (active patch)
  private jackSinkDeviceId: string | null = null;
  private jackSimulated = false;
  private jackDeviceChannelCount = 0;
  private simJackDeviceId: string | null = null;
  private knownDeviceChannels = new Map<string, number>();

  private rawTapNode: AudioWorkletNode | null = null;
  private rawTapSilentSink: GainNode | null = null;
  private rawWorkletPromise: Promise<void> | null = null;
  private rawWorkletCtx: AudioContext | null = null;

  // Gain & routing state
  private monitorAudible = false;
  private monitorLevelDb = -9;
  private talkbackActive = false;
  private emergencyMuted = false;
  private rawOutputActive = false;
  private rawOutputEndpointId: string | undefined = undefined;
  /** v2 native per-jack engine: armed channel count + share mode. */
  private rawOutputExclusive = false;
  private rawOutputChannels = 2;
  /** Which graph feeds the raw tap: 'master' (post-DSP stereo) or 'jack' (per-jack merger). */
  private rawTapFeed: 'master' | 'jack' | null = null;
  private preferredOutputDeviceId: string | undefined = undefined;
  private preferredStreamOutputDeviceId: string | undefined = undefined;
  private onOutputFallbackCb: ((staleDeviceId: string, reason: string) => void) | null = null;

  // Desktop Audio Bridge safety tracking
  private bridgeState: SystemAudioBridgeState = { ...INITIAL_DESKTOP_BRIDGE_STATE };
  private desktopCaptureMethod: SystemAudioCaptureMethod = isDesktopApp()
    ? 'native-wasapi'
    : 'display-media';
  private specializedDesktopDeviceId: string | null = null;
  private specializedDesktopLabel: string | null = null;
  private specializedDesktopGroupId: string | null = null;
  private tauriSourceIsolationActive = false;
  private outputDeviceMetaCache: MediaDeviceInfo[] = [];
  private bridgeListeners = new Set<(state: SystemAudioBridgeState) => void>();

  public setOnOutputFallback(cb: ((staleDeviceId: string, reason: string) => void) | null): void {
    this.onOutputFallbackCb = cb;
  }

  /** Register probed or native WASAPI channel counts per output device ID. */
  public setKnownDeviceChannelCounts(counts: Record<string, number>): void {
    this.knownDeviceChannels.clear();
    for (const [id, count] of Object.entries(counts)) {
      if (count >= 2) {
        this.knownDeviceChannels.set(id, count);
      }
    }
    if (this.ctx && this.lastZones.length > 0) {
      this.applySpeakerZones(this.lastZones);
    }
  }

  public attachGraph(ctx: AudioContext, postAnalyser: AnalyserNode): void {
    this.teardownAuxZoneSinks();
    this.ctx = ctx;
    this.postAnalyser = postAnalyser;

    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.monitorGain.channelCount = 2;
    this.monitorGain.channelCountMode = 'explicit';
    this.monitorGain.channelInterpretation = 'speakers';

    this.paZoneFilterA = ctx.createBiquadFilter();
    this.paZoneFilterA.type = 'allpass';
    this.paZoneFilterB = ctx.createBiquadFilter();
    this.paZoneFilterB.type = 'allpass';

    this.paZoneDelayNode = ctx.createDelay(0.5);
    this.paZoneDelayNode.delayTime.value = 0;

    this.paZoneGainNode = ctx.createGain();
    this.paZoneGainNode.gain.value = 1;
    this.paZoneGainNode.channelCount = 2;
    this.paZoneGainNode.channelCountMode = 'explicit';
    this.paZoneGainNode.channelInterpretation = 'speakers';

    this.streamOutputGain = ctx.createGain();
    this.streamOutputGain.gain.value = 0;
    this.streamOutputGain.channelCount = 2;
    this.streamOutputGain.channelCountMode = 'explicit';
    this.streamOutputGain.channelInterpretation = 'speakers';

    this.streamMediaDest = ctx.createMediaStreamDestination();

    // Wire Post-DSP output to PA Monitor + PA Zone Crossover/Delay/Trim -> Speakers, plus isolated Stream/OBS bus
    this.postAnalyser.connect(this.monitorGain);
    this.monitorGain.connect(this.paZoneFilterA);
    this.paZoneFilterA.connect(this.paZoneFilterB);
    this.paZoneFilterB.connect(this.paZoneDelayNode);
    this.paZoneDelayNode.connect(this.paZoneGainNode);
    this.paZoneGainNode.connect(ctx.destination);

    this.postAnalyser.connect(this.streamOutputGain);
    this.streamOutputGain.connect(this.streamMediaDest);

    this.jackMerger = null;
    this.jackZoneChains.clear();
    this.jackSlotZones.clear();
    this.jackLayoutChannels = 0;

    if (this.lastZones.length > 0) {
      this.applySpeakerZones(this.lastZones);
    }

    if (this.preferredStreamOutputDeviceId) {
      void this.setStreamOutputDevice(this.preferredStreamOutputDeviceId);
    }
  }

  private configureZoneCrossoverFilters(
    filterA: BiquadFilterNode,
    filterB: BiquadFilterNode,
    zone: SpeakerZone,
    now: number
  ): void {
    const fc = clamp(zone.crossoverHz || 80, 35, 400);
    if (zone.role === 'sub') {
      // Subwoofer role ALWAYS low-passes at crossoverHz (24 dB/oct Linkwitz-Riley cascade)
      filterA.type = 'lowpass';
      filterB.type = 'lowpass';
      filterA.frequency.setTargetAtTime(fc, now, 0.015);
      filterB.frequency.setTargetAtTime(fc, now, 0.015);
      filterA.Q.setTargetAtTime(0.7071, now, 0.015);
      filterB.Q.setTargetAtTime(0.7071, now, 0.015);
    } else if (zone.crossoverSlope && zone.crossoverSlope !== 'None') {
      // Main / Center / Rear / Stage Monitor high-passed above subwoofer crossover
      filterA.type = 'highpass';
      filterB.type = zone.crossoverSlope === 'LR24' ? 'highpass' : 'allpass';
      filterA.frequency.setTargetAtTime(fc, now, 0.015);
      filterB.frequency.setTargetAtTime(fc, now, 0.015);
      filterA.Q.setTargetAtTime(0.7071, now, 0.015);
      filterB.Q.setTargetAtTime(0.7071, now, 0.015);
    } else {
      // Full-range transparent pass-through
      filterA.type = 'lowpass';
      filterB.type = 'lowpass';
      filterA.frequency.setTargetAtTime(20000, now, 0.015);
      filterB.frequency.setTargetAtTime(20000, now, 0.015);
      filterA.Q.setTargetAtTime(0.7071, now, 0.015);
      filterB.Q.setTargetAtTime(0.7071, now, 0.015);
    }
  }

  public applySpeakerZones(zones: SpeakerZone[]): void {
    this.lastZones = zones;
    if (!this.ctx || !this.paZoneDelayNode || !this.paZoneGainNode || zones.length === 0) return;

    // 1. Sync simultaneous auxiliary hardware output sinks (zones routed to a distinct physical output device)
    this.syncAuxZoneHardwareSinks(zones);

    // 2. Discrete PCIe jack path: rebuild graph if the slot->zone patch changed
    if (this.reconcileJackGraph(zones)) {
      this.applyZoneValuesToJackChains(zones);
      return;
    }

    // 3. Primary stereo PA path on ctx.destination: drive from main-lr zone (or first zone on the primary device)
    const activeSinkId = this.resolveEffectiveSinkDeviceId();
    const mainZone =
      zones.find(
        (z) =>
          z.role === 'main-lr' &&
          (!z.hardwareOutputId || z.hardwareOutputId === activeSinkId)
      ) ??
      zones.find((z) => !z.hardwareOutputId || z.hardwareOutputId === activeSinkId) ??
      zones[0];
    if (!mainZone) return;

    const now = this.ctx.currentTime;
    const delaySec = clamp((mainZone.delayMs || 0) / 1000, 0, 0.5);
    const sign = mainZone.polarityInverted ? -1 : 1;
    const gainLinear = mainZone.mute ? 0 : dbToLinear(clamp(mainZone.levelDb ?? 0, -48, 12)) * sign;

    if (this.paZoneFilterA && this.paZoneFilterB) {
      this.configureZoneCrossoverFilters(this.paZoneFilterA, this.paZoneFilterB, mainZone, now);
    }
    this.paZoneDelayNode.delayTime.setTargetAtTime(delaySec, now, 0.015);
    this.paZoneGainNode.gain.setTargetAtTime(gainLinear, now, 0.015);
  }

  // =========================================================================
  //   SIMULTANEOUS MULTI-DEVICE SPEAKER ZONE ROUTING
  //   Allows turning on 2, 3, 4+ distinct physical output devices at once!
  // =========================================================================

  private resolveEffectiveSinkDeviceId(): string {
    if (this.preferredOutputDeviceId) return this.preferredOutputDeviceId;
    const defaultDev =
      this.outputDeviceMetaCache.find((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications') ??
      this.outputDeviceMetaCache[0];
    return defaultDev?.deviceId || '';
  }

  private syncAuxZoneHardwareSinks(zones: SpeakerZone[]): void {
    if (!this.ctx || !this.monitorGain || typeof Audio === 'undefined') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const primarySinkId = this.resolveEffectiveSinkDeviceId();

    const activeZoneIds = new Set<string>();

    for (const zone of zones) {
      const targetDevId = (zone.hardwareOutputId || '').split('::')[0];
      // A zone needs its own parallel HTMLAudioElement sink if:
      // - It has an explicit hardwareOutputId
      // - That hardwareOutputId is not the simulated training card
      // - That hardwareOutputId is different from the primary ctx.destination device
      // - The zone is not currently routed through a discrete jack on the primary PCIe card
      const isOnPrimaryJack = Boolean(
        zone.outputJackId && parseJackId(zone.outputJackId)?.deviceId === primarySinkId
      );
      const needsAuxSink =
        Boolean(targetDevId) &&
        targetDevId !== 'default' &&
        targetDevId !== SIM_PIE_8OUT_DEVICE_ID &&
        targetDevId !== primarySinkId &&
        !isOnPrimaryJack &&
        !zone.mute;

      if (!needsAuxSink) continue;
      activeZoneIds.add(zone.id);

      let sink = this.auxZoneSinks.get(zone.id);
      if (sink && sink.deviceId !== targetDevId) {
        this.disposeAuxSink(sink);
        this.auxZoneSinks.delete(zone.id);
        sink = undefined;
      }

      if (!sink) {
        const filterA = ctx.createBiquadFilter();
        const filterB = ctx.createBiquadFilter();
        const delay = ctx.createDelay(0.5);
        const gain = ctx.createGain();
        const dest = ctx.createMediaStreamDestination();
        const audioEl = new Audio();
        audioEl.autoplay = true;
        audioEl.srcObject = dest.stream;

        this.monitorGain.connect(filterA);
        filterA.connect(filterB);
        filterB.connect(delay);
        delay.connect(gain);
        gain.connect(dest);

        sink = { deviceId: targetDevId, filterA, filterB, delay, gain, dest, audioEl };
        this.auxZoneSinks.set(zone.id, sink);

        void (async () => {
          try {
            const elWithSink = audioEl as unknown as { setSinkId?: (id: string) => Promise<void> };
            if ('setSinkId' in audioEl && typeof elWithSink.setSinkId === 'function') {
              await elWithSink.setSinkId(targetDevId);
            }
            await audioEl.play().catch(() => {});
          } catch (err) {
            console.warn(`Aux zone sink (${zone.name} -> ${targetDevId}) failed:`, err);
          }
        })();
      }

      this.configureZoneCrossoverFilters(sink.filterA, sink.filterB, zone, now);
      const delaySec = clamp((zone.delayMs || 0) / 1000, 0, 0.5);
      const sign = zone.polarityInverted ? -1 : 1;
      const gainLinear = zone.mute ? 0 : dbToLinear(clamp(zone.levelDb ?? 0, -48, 12)) * sign;
      sink.delay.delayTime.setTargetAtTime(delaySec, now, 0.015);
      sink.gain.gain.setTargetAtTime(gainLinear, now, 0.015);

      if (sink.audioEl.paused && this.monitorAudible && !this.emergencyMuted) {
        void sink.audioEl.play().catch(() => {});
      }
    }

    // Tear down any aux sinks for zones that were muted, removed, or moved back to the primary device
    for (const [zoneId, sink] of this.auxZoneSinks.entries()) {
      if (!activeZoneIds.has(zoneId)) {
        this.disposeAuxSink(sink);
        this.auxZoneSinks.delete(zoneId);
      }
    }
  }

  private disposeAuxSink(sink: AuxZoneHardwareSink): void {
    try {
      sink.audioEl.pause();
      sink.audioEl.srcObject = null;
      sink.filterA.disconnect();
      sink.filterB.disconnect();
      sink.delay.disconnect();
      sink.gain.disconnect();
      sink.dest.disconnect();
    } catch {
      // ignore cleanup errors
    }
  }

  private teardownAuxZoneSinks(): void {
    for (const sink of this.auxZoneSinks.values()) {
      this.disposeAuxSink(sink);
    }
    this.auxZoneSinks.clear();
  }

  // =========================================================================
  //   DISCRETE JACK ROUTER — 5.1/7.1/N-channel channel-pair zone routing
  //   One physical jack pair per zone: FL/FR (green), BL/BR (black),
  //   FC/LFE (orange), SL/SR (grey), plus generated AUX n pairs (channels 8+)
  //   on pro cards. Includes per-zone Crossover & FC/LFE split!
  // =========================================================================

  /** Training-mode simulated 7.1 card id (see utils/jackTopology.ts). */
  public setSimulatedJackDeviceId(id: string | null): void {
    this.simJackDeviceId = id;
    if (this.ctx) {
      this.reconcileJackGraph(this.lastZones);
      this.applyZoneValuesToJackChains(this.lastZones);
    }
  }

  /**
   * Resolve the device ID used for discrete jack matching even when the user
   * hasn't explicitly clicked "Set Master PA" (i.e. preferredOutputDeviceId is '' / default).
   */
  private resolveJackSinkDeviceId(zones: SpeakerZone[]): string | null {
    if (this.preferredOutputDeviceId) return this.preferredOutputDeviceId;
    if (this.simJackDeviceId) return this.simJackDeviceId;
    // Check if any zone already has an outputJackId pointing to a known device
    for (const z of zones) {
      const parsed = parseJackId(z.outputJackId);
      if (parsed?.deviceId) return parsed.deviceId;
    }
    const eff = this.resolveEffectiveSinkDeviceId();
    return eff || null;
  }

  /**
   * Channel count of the ACTIVE sink as the router understands it: real
   * device → destination.maxChannelCount (capped at 32 for pro cards);
   * simulated card → 8; known probed/native WASAPI count → 6/8/N.
   */
  private detectSinkChannelCount(sinkDeviceId: string | null): number {
    if (!this.ctx) return 2;
    if (this.simJackDeviceId && sinkDeviceId === this.simJackDeviceId) {
      return 8;
    }
    if (sinkDeviceId && this.knownDeviceChannels.has(sinkDeviceId)) {
      const known = this.knownDeviceChannels.get(sinkDeviceId) || 2;
      if (known >= 4) return Math.min(known, 32);
    }
    try {
      const max = this.ctx.destination.maxChannelCount || 2;
      return max >= 4 ? Math.min(max, 32) : 2;
    } catch {
      return 2;
    }
  }

  /**
   * Derive the slot->zone patch for the active sink. Rebuilds the merger graph
   * whenever the patch or layout changes. Returns true when discrete mode is active.
   */
  private reconcileJackGraph(zones: SpeakerZone[]): boolean {
    if (!this.ctx || !this.monitorGain) return false;

    const sinkDeviceId = this.resolveJackSinkDeviceId(zones);
    const simulated = Boolean(
      this.simJackDeviceId && sinkDeviceId === this.simJackDeviceId && sinkDeviceId !== null
    );
    const channelCount = this.detectSinkChannelCount(sinkDeviceId);

    const nextSlotZones = new Map<OutputJackSlot, string>();
    if (channelCount >= 4 && sinkDeviceId) {
      for (const zone of zones) {
        const parsed = parseJackId(zone.outputJackId);
        if (!parsed || parsed.deviceId !== sinkDeviceId) continue;
        if (!nextSlotZones.has(parsed.slot)) nextSlotZones.set(parsed.slot, zone.id);
      }
      // If the active sink is a multi-channel 5.1/7.1 card and no explicit jack patch exists yet,
      // auto-map the standard church roles to their discrete physical jacks (Front L/R -> Green,
      // Sub/Center -> Orange, Rear Fill -> Black, Stage Monitor -> Grey) so the card immediately
      // outputs discrete separated channels instead of a mixed stereo downmix!
      if (nextSlotZones.size === 0) {
        const frontZone = zones.find((z) => z.role === 'main-lr') ?? zones[0];
        const centerOrSubZone =
          zones.find((z) => z.role === 'sub') ?? zones.find((z) => z.role === 'center');
        const rearZone =
          zones.find((z) => z.role === 'rear-fill') ?? zones.find((z) => z.role === 'overflow');
        const sideZone = zones.find((z) => z.role === 'stage-monitor');

        if (frontZone) nextSlotZones.set('front-lr', frontZone.id);
        if (centerOrSubZone && centerOrSubZone.id !== frontZone?.id) {
          nextSlotZones.set('center-lfe', centerOrSubZone.id);
        }
        if (rearZone && rearZone.id !== frontZone?.id) {
          nextSlotZones.set('rear-lr', rearZone.id);
        }
        if (channelCount >= 8 && sideZone && sideZone.id !== frontZone?.id) {
          nextSlotZones.set('side-lr', sideZone.id);
        }
      }
    }

    const patchChanged =
      this.jackLayoutChannels !== channelCount ||
      this.jackSimulated !== simulated ||
      this.jackSinkDeviceId !== sinkDeviceId ||
      nextSlotZones.size !== this.jackSlotZones.size ||
      Array.from(nextSlotZones.entries()).some(([slot, zoneId]) => this.jackSlotZones.get(slot) !== zoneId);

    if (patchChanged) {
      this.teardownJackGraph();
      this.jackSlotZones = nextSlotZones;
      this.jackLayoutChannels = channelCount;
      this.jackSinkDeviceId = sinkDeviceId;
      this.jackSimulated = simulated;
      this.jackDeviceChannelCount = channelCount;
      if (channelCount >= 4 && nextSlotZones.size > 0) {
        this.buildJackGraph(zones);
      }
    }

    return this.jackMerger !== null;
  }

  /**
   * Build the discrete ChannelMerger + per-jack crossover/delay/gain chains.
   * Special handling for `center-lfe` (Orange jack, channels 2 = FC and 3 = LFE):
   * - If both a `center` zone and a `sub` zone exist, Channel 2 (Tip = FC) carries
   *   the high-passed Center zone and Channel 3 (Ring = LFE) carries the low-passed Subwoofer zone!
   * - Otherwise, the assigned zone feeds both channels of that jack with its role crossover filter applied.
   */
  private buildJackGraph(zones: SpeakerZone[]): void {
    if (!this.ctx || !this.monitorGain || !this.paZoneGainNode) return;
    const ctx = this.ctx;
    const channels = this.jackLayoutChannels;
    if (channels < 4 || this.jackSlotZones.size === 0) return;

    const merger = ctx.createChannelMerger(channels);

    // Iterate every slot of the CURRENT patch in physical order — includes
    // generated aux pairs on >8-channel sinks (the static named-slot order
    // would skip them).
    for (const slot of orderedJackSlots(channels)) {
      const assignedZoneId = this.jackSlotZones.get(slot);
      if (!assignedZoneId) continue;
      const indices = slotChannelIndices(slot, channels);
      if (!indices || indices[1] >= channels) continue;

      const filterA = ctx.createBiquadFilter();
      const filterB = ctx.createBiquadFilter();

      const zoneGain = ctx.createGain();
      zoneGain.gain.value = 1;
      zoneGain.channelCount = 2;
      zoneGain.channelCountMode = 'explicit';
      zoneGain.channelInterpretation = 'speakers';

      const zoneDelay = ctx.createDelay(0.5);
      zoneDelay.delayTime.value = 0;

      const splitter = ctx.createChannelSplitter(2);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;

      this.monitorGain.connect(filterA);
      filterA.connect(filterB);
      filterB.connect(zoneGain);
      zoneGain.connect(zoneDelay);
      zoneDelay.connect(splitter);
      zoneDelay.connect(analyser);

      const chainRecord: JackZoneDspChain = {
        filterA,
        filterB,
        gain: zoneGain,
        delay: zoneDelay,
        splitter,
        analyser,
        buf: new Float32Array(analyser.fftSize) as Float32Array<ArrayBuffer>,
      };

      // On the Orange CENTER/SUB jack (channels 2 = Center FC, 3 = Subwoofer LFE),
      // check if we have both a Center zone and a Subwoofer zone so we can split
      // Center onto Channel 2 and Subwoofer onto Channel 3 independently!
      const assignedZone = zones.find((z) => z.id === assignedZoneId);
      const companionSubZone =
        slot === 'center-lfe' && assignedZone?.role === 'center'
          ? zones.find((z) => z.role === 'sub')
          : slot === 'center-lfe' && assignedZone?.role === 'sub'
            ? zones.find((z) => z.role === 'center')
            : undefined;

      if (slot === 'center-lfe' && assignedZone && companionSubZone) {
        const subFilterA = ctx.createBiquadFilter();
        const subFilterB = ctx.createBiquadFilter();
        const subGain = ctx.createGain();
        const subDelay = ctx.createDelay(0.5);
        const subSplitter = ctx.createChannelSplitter(2);

        this.monitorGain.connect(subFilterA);
        subFilterA.connect(subFilterB);
        subFilterB.connect(subGain);
        subGain.connect(subDelay);
        subDelay.connect(subSplitter);

        if (assignedZone.role === 'center') {
          // assignedZone is Center (Ch 2 FC), companion is Sub (Ch 3 LFE)
          splitter.connect(merger, 0, indices[0]);
          subSplitter.connect(merger, 0, indices[1]);
        } else {
          // assignedZone is Sub (Ch 3 LFE), companion is Center (Ch 2 FC)
          subSplitter.connect(merger, 0, indices[0]);
          splitter.connect(merger, 0, indices[1]);
        }

        chainRecord.centerLfeSubFilterA = subFilterA;
        chainRecord.centerLfeSubFilterB = subFilterB;
        chainRecord.centerLfeSubGain = subGain;
        chainRecord.centerLfeSubDelay = subDelay;
      } else {
        splitter.connect(merger, 0, indices[0]); // L -> jack channel A
        splitter.connect(merger, 1, indices[1]); // R -> jack channel B
      }

      this.jackZoneChains.set(slot, chainRecord);
    }

    if (!this.jackSimulated) {
      try {
        const maxSupported = Math.max(2, ctx.destination.maxChannelCount || 2);
        if (maxSupported >= channels) {
          ctx.destination.channelCount = channels;
          ctx.destination.channelCountMode = 'explicit';
          ctx.destination.channelInterpretation = 'discrete';
        }
      } catch {
        // Device refused the layout — merger still feeds the default layout cleanly.
      }
    }

    try {
      this.paZoneGainNode.disconnect(ctx.destination);
    } catch {
      // not connected
    }
    merger.connect(ctx.destination);
    this.jackMerger = merger;

    // v2 native per-jack engine already armed → hand the fresh merger to the
    // raw tap (bit-perfect shared/exclusive WASAPI) instead of the browser sink.
    if (
      this.rawOutputActive &&
      this.rawTapNode &&
      this.rawOutputChannels >= 4 &&
      !this.jackSimulated
    ) {
      try {
        merger.disconnect(ctx.destination);
      } catch {
        // ignore
      }
      merger.connect(this.rawTapNode);
      this.rawTapFeed = 'jack';
    }
  }

  /** Remove the discrete graph and restore the legacy stereo PA chain. */
  private teardownJackGraph(): void {
    if (this.jackMerger && this.ctx) {
      try {
        this.jackMerger.disconnect();
      } catch {
        // ignore
      }
      if (!this.jackSimulated) {
        try {
          this.ctx.destination.channelCount = 2;
          this.ctx.destination.channelCountMode = 'explicit';
          this.ctx.destination.channelInterpretation = 'speakers';
        } catch {
          // ignore
        }
      }
    }
    for (const chain of this.jackZoneChains.values()) {
      try {
        chain.filterA.disconnect();
        chain.filterB.disconnect();
        chain.gain.disconnect();
        chain.delay.disconnect();
        chain.splitter.disconnect();
        chain.centerLfeSubFilterA?.disconnect();
        chain.centerLfeSubFilterB?.disconnect();
        chain.centerLfeSubGain?.disconnect();
        chain.centerLfeSubDelay?.disconnect();
        chain.analyser.disconnect();
      } catch {
        // ignore
      }
    }
    this.jackZoneChains.clear();
    this.jackMerger = null;
    this.jackSlotZones.clear();
    this.jackLayoutChannels = 0;

    // Native per-jack feed lost its merger — revert the raw tap to the
    // post-DSP master stereo feed so the native stream keeps running.
    if (this.rawTapFeed === 'jack' && this.rawTapNode && this.ctx && this.postAnalyser) {
      try {
        this.postAnalyser.connect(this.rawTapNode);
      } catch {
        // ignore
      }
      this.rawTapFeed = 'master';
    }

    if (
      this.ctx &&
      this.monitorGain &&
      this.paZoneFilterA &&
      this.paZoneFilterB &&
      this.paZoneDelayNode &&
      this.paZoneGainNode
    ) {
      try {
        this.monitorGain.connect(this.paZoneFilterA);
        this.paZoneFilterA.connect(this.paZoneFilterB);
        this.paZoneFilterB.connect(this.paZoneDelayNode);
        this.paZoneDelayNode.connect(this.paZoneGainNode);
        this.paZoneGainNode.connect(this.ctx.destination);
      } catch {
        // ignore
      }
    }
  }

  /** Per-zone crossover/trim/delay/polarity/mute onto the active jack chains. */
  private applyZoneValuesToJackChains(zones: SpeakerZone[]): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [slot, zoneId] of this.jackSlotZones) {
      const chain = this.jackZoneChains.get(slot);
      const zone = zones.find((z) => z.id === zoneId);
      if (!chain || !zone) continue;

      this.configureZoneCrossoverFilters(chain.filterA, chain.filterB, zone, now);
      const delaySec = clamp((zone.delayMs || 0) / 1000, 0, 0.5);
      const sign = zone.polarityInverted ? -1 : 1;
      const gainLinear = zone.mute ? 0 : dbToLinear(clamp(zone.levelDb ?? 0, -48, 12)) * sign;
      chain.delay.delayTime.setTargetAtTime(delaySec, now, 0.015);
      chain.gain.gain.setTargetAtTime(gainLinear, now, 0.015);

      if (
        slot === 'center-lfe' &&
        chain.centerLfeSubFilterA &&
        chain.centerLfeSubFilterB &&
        chain.centerLfeSubGain &&
        chain.centerLfeSubDelay
      ) {
        const companion =
          zone.role === 'center'
            ? zones.find((z) => z.role === 'sub')
            : zones.find((z) => z.role === 'center');
        if (companion) {
          this.configureZoneCrossoverFilters(
            chain.centerLfeSubFilterA,
            chain.centerLfeSubFilterB,
            companion,
            now
          );
          const compDelay = clamp((companion.delayMs || 0) / 1000, 0, 0.5);
          const compSign = companion.polarityInverted ? -1 : 1;
          const compGain = companion.mute
            ? 0
            : dbToLinear(clamp(companion.levelDb ?? 0, -48, 12)) * compSign;
          chain.centerLfeSubDelay.delayTime.setTargetAtTime(compDelay, now, 0.015);
          chain.centerLfeSubGain.gain.setTargetAtTime(compGain, now, 0.015);
        }
      }
    }
  }

  /** Live RMS per routed jack (dBFS) for the UI jack bay meters. */
  public sampleJackLevels(): Array<{ slot: OutputJackSlot; zoneId: string; rmsDb: number }> {
    const out: Array<{ slot: OutputJackSlot; zoneId: string; rmsDb: number }> = [];
    for (const [slot, zoneId] of this.jackSlotZones) {
      const chain = this.jackZoneChains.get(slot);
      if (!chain) continue;
      chain.analyser.getFloatTimeDomainData(chain.buf);
      let sum = 0;
      for (let i = 0; i < chain.buf.length; i++) sum += chain.buf[i] * chain.buf[i];
      const rms = Math.sqrt(sum / chain.buf.length);
      out.push({ slot, zoneId, rmsDb: rms > 0 ? 20 * Math.log10(rms) : -96 });
    }
    return out;
  }

  /** Routing snapshot for the UI jack bay. */
  public getJackRoutingStatus(): {
    active: boolean;
    simulated: boolean;
    sinkDeviceId: string | null;
    channelCount: number;
    slots: Array<{ slot: OutputJackSlot; zoneId: string; channelIndices: [number, number] | null }>;
  } {
    const channels = this.jackLayoutChannels;
    return {
      active: this.jackMerger !== null,
      simulated: this.jackSimulated,
      sinkDeviceId: this.jackSinkDeviceId,
      channelCount: this.jackDeviceChannelCount,
      slots: Array.from(this.jackSlotZones.entries()).map(([slot, zoneId]) => ({
        slot,
        zoneId,
        channelIndices: slotChannelIndices(slot, channels),
      })),
    };
  }

  public getDesktopBridgeState(): SystemAudioBridgeState {
    return this.bridgeState;
  }

  public getDesktopCaptureMethod(): SystemAudioCaptureMethod {
    return this.desktopCaptureMethod;
  }

  public getSpecializedDesktopDevice(): {
    deviceId: string | null;
    label: string | null;
    groupId: string | null;
  } {
    return {
      deviceId: this.specializedDesktopDeviceId,
      label: this.specializedDesktopLabel,
      groupId: this.specializedDesktopGroupId,
    };
  }

  public subscribeDesktopBridge(cb: (state: SystemAudioBridgeState) => void): () => void {
    this.bridgeListeners.add(cb);
    cb(this.bridgeState);
    return () => {
      this.bridgeListeners.delete(cb);
    };
  }

  private emitBridgeState(): void {
    for (const cb of this.bridgeListeners) {
      try {
        cb(this.bridgeState);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  public setDesktopCaptureMethod(method: SystemAudioCaptureMethod): void {
    this.desktopCaptureMethod = method;
  }

  public setSpecializedDesktopDevice(device: {
    deviceId: string | null;
    label?: string | null;
    groupId?: string | null;
  }): void {
    this.specializedDesktopDeviceId = device.deviceId || null;
    this.specializedDesktopLabel = device.label || null;
    this.specializedDesktopGroupId = device.groupId || null;
    if (device.deviceId) {
      this.desktopCaptureMethod =
        device.deviceId === 'native-desktop-audio' ? 'native-wasapi' : 'specialized-interface';
    }
  }

  public setTauriSourceIsolationActive(active: boolean): void {
    this.tauriSourceIsolationActive = active;
  }

  public updateOutputDeviceMetadata(devices: MediaDeviceInfo[]): void {
    this.outputDeviceMetaCache = devices;
  }

  private findOutputMeta(deviceId?: string): MediaDeviceInfo | undefined {
    if (!deviceId) return undefined;
    return this.outputDeviceMetaCache.find((d) => d.deviceId === deviceId);
  }

  public refreshBridgeSafety(params: {
    isRunning: boolean;
    sourceMode: AudioSourceSimulation;
    displaySurface: string | null;
    suppressLocalPlayback: boolean;
    inputLabel: string | null;
    sampleRate: number;
  }): LoopbackSafetyResult {
    const defaultMeta =
      this.outputDeviceMetaCache.find((d) => d.deviceId === 'default') ??
      this.outputDeviceMetaCache[0];
    const preferredOutMeta = this.findOutputMeta(this.preferredOutputDeviceId);
    const preferredStreamMeta = this.findOutputMeta(this.preferredStreamOutputDeviceId);

    const isDesktopActive = params.isRunning && params.sourceMode === 'desktop-audio';
    const safety = evaluateDesktopLoopbackSafety({
      active: isDesktopActive,
      method: this.desktopCaptureMethod,
      displaySurface: params.displaySurface,
      suppressLocalAudioPlayback: params.suppressLocalPlayback,
      specializedDeviceId: this.specializedDesktopDeviceId,
      specializedInputLabel: this.specializedDesktopLabel,
      specializedInputGroupId: this.specializedDesktopGroupId,
      preferredOutputDeviceId: this.preferredOutputDeviceId,
      preferredOutputLabel: preferredOutMeta?.label,
      preferredOutputGroupId: preferredOutMeta?.groupId,
      defaultOutputDeviceId: defaultMeta?.deviceId,
      defaultOutputGroupId: defaultMeta?.groupId,
      defaultOutputLabel: defaultMeta?.label,
      preferredStreamOutputDeviceId: this.preferredStreamOutputDeviceId,
      preferredStreamOutputLabel: preferredStreamMeta?.label,
      preferredStreamOutputGroupId: preferredStreamMeta?.groupId,
      tauriSourceIsolationActive: this.tauriSourceIsolationActive,
      tauriRawOutputActive: this.rawOutputActive,
    });

    const nextState: SystemAudioBridgeState = {
      active: isDesktopActive,
      method: this.desktopCaptureMethod,
      displaySurface: isDesktopActive ? params.displaySurface : null,
      inputLabel: isDesktopActive ? params.inputLabel : null,
      specializedDeviceId: this.specializedDesktopDeviceId,
      loopbackRisk: safety.loopbackRisk,
      selfLoopbackBlocked: safety.selfLoopbackBlocked,
      streamLoopbackBlocked: safety.streamLoopbackBlocked,
      safetyReason: safety.safetyReason,
      sampleRate: isDesktopActive ? params.sampleRate : null,
    };

    const changed =
      nextState.active !== this.bridgeState.active ||
      nextState.method !== this.bridgeState.method ||
      nextState.displaySurface !== this.bridgeState.displaySurface ||
      nextState.inputLabel !== this.bridgeState.inputLabel ||
      nextState.specializedDeviceId !== this.bridgeState.specializedDeviceId ||
      nextState.loopbackRisk !== this.bridgeState.loopbackRisk ||
      nextState.selfLoopbackBlocked !== this.bridgeState.selfLoopbackBlocked ||
      nextState.streamLoopbackBlocked !== this.bridgeState.streamLoopbackBlocked ||
      nextState.safetyReason !== this.bridgeState.safetyReason ||
      nextState.sampleRate !== this.bridgeState.sampleRate;

    this.bridgeState = nextState;
    if (changed) {
      this.emitBridgeState();
    }
    return safety;
  }

  public syncOutputGains(params: {
    isRunning: boolean;
    sourceMode: AudioSourceSimulation;
    displaySurface: string | null;
    suppressLocalPlayback: boolean;
    inputLabel: string | null;
    sampleRate: number;
  }): void {
    const safety = this.refreshBridgeSafety(params);
    if (!this.ctx) return;

    const monBlocked = params.sourceMode === 'desktop-audio' && safety.selfLoopbackBlocked;
    const streamBlocked = params.sourceMode === 'desktop-audio' && safety.streamLoopbackBlocked;

    // IMPORTANT FOR LOW-SPEC PC STABILITY & MULTICHANNEL PCIe ROUTING:
    // Normal desktop playback uses WebView2's native C++ audio render thread (`ctx.destination`),
    // which has zero JS-to-Rust IPC overhead and preserves full 5.1/7.1 discrete channel separation.
    // `win_sessions.rs` protects the entire `hkm-audio-system.exe` + `msedgewebview2.exe` process tree
    // from being muted, so OBS Application Audio Capture captures WebView2 natively.
    if (this.monitorGain) {
      const baseLinear = dbToLinear(this.monitorLevelDb);
      const tbFactor = this.talkbackActive ? 0.2 : 1.0; // -14 dB cue dim during Talkback
      const target =
        this.monitorAudible &&
        !this.emergencyMuted &&
        !this.rawOutputActive &&
        !monBlocked
          ? baseLinear * tbFactor
          : 0;
      this.monitorGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }

    if (this.streamOutputGain) {
      const streamActive =
        Boolean(this.preferredStreamOutputDeviceId) &&
        !this.emergencyMuted &&
        params.isRunning &&
        !streamBlocked;
      this.streamOutputGain.gain.setTargetAtTime(streamActive ? 1 : 0, this.ctx.currentTime, 0.02);

      if (streamActive && this.streamAudioEl) {
        if (!this.streamAudioEl.srcObject && this.streamMediaDest) {
          this.streamAudioEl.srcObject = this.streamMediaDest.stream;
        }
        if (this.streamAudioEl.paused) {
          void this.streamAudioEl.play().catch(() => {});
        }
      }
    }
  }

  public setMonitorAudible(audible: boolean): void {
    this.monitorAudible = audible;
  }

  public isMonitorAudible(): boolean {
    return this.monitorAudible;
  }

  public setMonitorLevelDb(db: number): void {
    this.monitorLevelDb = clamp(db, -48, 6);
  }

  public setTalkbackActive(active: boolean): void {
    this.talkbackActive = active;
  }

  public setEmergencyMute(muted: boolean): void {
    this.emergencyMuted = muted;
  }

  public getPreferredOutputDeviceId(): string {
    return this.preferredOutputDeviceId || '';
  }

  public getPreferredStreamOutputDeviceId(): string {
    return this.preferredStreamOutputDeviceId || '';
  }

  public isRawOutputActive(): boolean {
    return this.rawOutputActive;
  }

  /** v2 native engine snapshot for the Discrete Jack Bay UI. */
  public getRawOutputEngineStatus(): {
    active: boolean;
    exclusive: boolean;
    channels: number;
    feed: 'master' | 'jack' | null;
  } {
    return {
      active: this.rawOutputActive,
      exclusive: this.rawOutputExclusive,
      channels: this.rawOutputChannels,
      feed: this.rawTapFeed,
    };
  }

  public getRawOutputEndpointId(): string | undefined {
    return this.rawOutputEndpointId;
  }

  public async setOutputDevice(
    deviceId?: string,
    options?: { allowFallbackToDefault?: boolean }
  ): Promise<boolean> {
    const cleanId = (deviceId || '').split('::')[0];
    this.preferredOutputDeviceId = cleanId || undefined;
    if (!this.ctx) return true;

    if (cleanId === SIM_PIE_8OUT_DEVICE_ID) {
      this.applySpeakerZones(this.lastZones);
      return true;
    }

    const ctxWithSink = this.ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
    const hasSetSinkId = 'setSinkId' in this.ctx && typeof ctxWithSink.setSinkId === 'function';

    if (hasSetSinkId && ctxWithSink.setSinkId) {
      try {
        await ctxWithSink.setSinkId(cleanId || '');
        this.applySpeakerZones(this.lastZones);
        return true;
      } catch (err) {
        console.warn('AudioContext.setSinkId failed:', err);
        if (cleanId && options?.allowFallbackToDefault) {
          this.preferredOutputDeviceId = undefined;
          try {
            await ctxWithSink.setSinkId('');
          } catch {
            // ignore fallback sink reset failure
          }
          this.applySpeakerZones(this.lastZones);
          this.onOutputFallbackCb?.(
            cleanId,
            'Saved audio output device is unavailable; routed safely to System Default Output.'
          );
          return true;
        }
        return false;
      }
    }

    if (!cleanId || cleanId === 'default') return true;

    if (options?.allowFallbackToDefault) {
      this.preferredOutputDeviceId = undefined;
      this.onOutputFallbackCb?.(
        cleanId,
        'AudioContext output selection is unsupported in this browser; using System Default Output.'
      );
      return true;
    }

    return false;
  }

  public async setStreamOutputDevice(deviceId?: string): Promise<boolean> {
    const cleanId = (deviceId || '').split('::')[0];
    this.preferredStreamOutputDeviceId = cleanId || undefined;
    if (!cleanId) {
      if (this.streamAudioEl) {
        this.streamAudioEl.pause();
        this.streamAudioEl.srcObject = null;
      }
      return true;
    }
    if (!this.ctx || !this.streamMediaDest) {
      return true;
    }
    try {
      if (!this.streamAudioEl && typeof Audio !== 'undefined') {
        this.streamAudioEl = new Audio();
        this.streamAudioEl.autoplay = true;
      }
      if (this.streamAudioEl) {
        this.streamAudioEl.srcObject = this.streamMediaDest.stream;
        if (
          'setSinkId' in this.streamAudioEl &&
          typeof (this.streamAudioEl as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId ===
            'function'
        ) {
          await (this.streamAudioEl as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(
            cleanId
          );
        }
        await this.streamAudioEl.play().catch(() => {});
      }
      return true;
    } catch (err) {
      console.warn('Stream output setSinkId failed:', err);
      return false;
    }
  }

  private async ensureRawTapWorklet(): Promise<void> {
    if (!this.ctx) throw new Error('AudioContext not initialized');
    if (this.rawWorkletCtx !== this.ctx || !this.rawWorkletPromise) {
      this.rawWorkletCtx = this.ctx;
      this.rawWorkletPromise = this.ctx.audioWorklet.addModule('/raw-output-tap-worklet.js');
    }
    await this.rawWorkletPromise;
  }

  public teardownRawTap(): void {
    if (this.rawTapNode) {
      try {
        this.rawTapNode.port.onmessage = null;
        this.rawTapNode.disconnect();
      } catch {
        // ignore
      }
      this.rawTapNode = null;
    }
    if (this.rawTapSilentSink) {
      try {
        this.rawTapSilentSink.disconnect();
      } catch {
        // ignore
      }
      this.rawTapSilentSink = null;
    }
    // Native per-jack path was carrying the jack graph — hand the merger back
    // to the Web Audio destination so audio keeps flowing after teardown.
    if (this.rawTapFeed === 'jack' && this.jackMerger && this.ctx) {
      try {
        this.jackMerger.connect(this.ctx.destination);
      } catch {
        // ignore
      }
    }
    this.rawTapFeed = null;
  }

  public async setRawOutputEnabled(
    enabled: boolean,
    isRunning: boolean,
    endpointId?: string,
    options?: { channels?: number; exclusive?: boolean }
  ): Promise<boolean> {
    if (endpointId !== undefined) {
      this.rawOutputEndpointId = endpointId || undefined;
    }
    const channels = Math.max(2, Math.min(32, Math.round(options?.channels ?? 2)));
    const exclusive = options?.exclusive === true;
    if (!enabled) {
      this.rawOutputActive = false;
      this.teardownRawTap();
      await stopRawOutput();
      return true;
    }

    if (!isRunning || !this.ctx || !this.postAnalyser) {
      this.rawOutputActive = true;
      return true;
    }

    try {
      // Arm the native WASAPI stream (shared or exclusive) with the requested
      // channel layout — the Rust shell opens the endpoint and the worklet
      // below feeds it interleaved 48 kHz f32 blocks of the same width.
      this.rawOutputChannels = channels;
      this.rawOutputExclusive = exclusive;
      const armed = await startRawOutput(this.rawOutputEndpointId, channels, exclusive);
      if (!armed) {
        throw new Error('Native WASAPI stream could not be opened on this endpoint.');
      }
      await this.ensureRawTapWorklet();
      if (!this.ctx || !this.postAnalyser || !isRunning) {
        await stopRawOutput();
        return false;
      }

      this.teardownRawTap();
      const tapNode = new AudioWorkletNode(this.ctx, 'raw-output-tap-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: channels,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        outputChannelCount: [channels],
        processorOptions: { channels },
      });
      const silentSink = this.ctx.createGain();
      silentSink.gain.value = 0;

      tapNode.port.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer && !this.emergencyMuted && this.monitorAudible) {
          void pushRawOutputPcm(ev.data);
        }
      };

      // Feed choice: a discrete jack graph (≥4 channels, real sink) hands its
      // per-jack merger to the native engine — bit-perfect per-jack delivery.
      // Everything else keeps the classic post-DSP master-stereo tap.
      const jackFeed =
        channels >= 4 && this.jackMerger && !this.jackSimulated && this.jackLayoutChannels >= channels;
      if (jackFeed && this.jackMerger) {
        try {
          this.jackMerger.disconnect(this.ctx.destination);
        } catch {
          // not connected
        }
        this.jackMerger.connect(tapNode);
        this.rawTapFeed = 'jack';
      } else {
        this.postAnalyser.connect(tapNode);
        this.rawTapFeed = 'master';
      }
      tapNode.connect(silentSink);
      silentSink.connect(this.ctx.destination);

      this.rawTapNode = tapNode;
      this.rawTapSilentSink = silentSink;
      this.rawOutputActive = true;
      return true;
    } catch (err) {
      console.warn('RAW output activation failed, staying on standard Web Audio output:', err);
      this.rawOutputActive = false;
      this.teardownRawTap();
      await stopRawOutput();
      return false;
    }
  }
}
