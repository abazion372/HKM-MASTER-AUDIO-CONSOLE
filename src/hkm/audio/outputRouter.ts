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

/**
 * Manages all Console Outputs + Desktop Audio Self-Loopback Firewall:
 *   1. Main Monitor / PA Output (`monitorGain -> paZoneDelayNode -> paZoneGainNode -> ctx.destination`)
 *      — upgraded with the DISCRETE JACK ROUTER: when the active sink is a
 *      5.1/7.1 device or a >8-channel pro card (probed via
 *      destination.maxChannelCount, or the training simulated card), each
 *      zone renders onto its own physical jack channel pair through a
 *      ChannelMerger with 'discrete' interpretation (FL/FR green, BL/BR
 *      black, FC/LFE orange, SL/SR grey, plus generated AUX pairs for
 *      channels 8+).
 *   2. Dedicated Stream / OBS Output (`streamOutputGain -> MediaStreamDestination -> Audio.setSinkId`)
 *   3. Native Windows WASAPI RAW / MFX Output Tap (`rawTapNode -> pushRawOutputPcm`)
 */
export class OutputRouter {
  private ctx: AudioContext | null = null;
  private postAnalyser: AnalyserNode | null = null;

  private monitorGain: GainNode | null = null;
  private paZoneDelayNode: DelayNode | null = null;
  private paZoneGainNode: GainNode | null = null;
  private lastZones: SpeakerZone[] = [];

  private streamOutputGain: GainNode | null = null;
  private streamMediaDest: MediaStreamAudioDestinationNode | null = null;
  private streamAudioEl: HTMLAudioElement | null = null;

  // ---- Discrete jack router (5.1/7.1/N-channel channel-pair zone routing) ----
  private jackMerger: ChannelMergerNode | null = null;
  private jackZoneChains = new Map<
    OutputJackSlot,
    { gain: GainNode; delay: DelayNode; splitter: ChannelSplitterNode; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> }
  >();
  private jackLayoutChannels = 0; // 0 = legacy stereo path, else 6/8/10..32
  private jackSlotZones = new Map<OutputJackSlot, string>(); // slot -> zoneId (active patch)
  private jackSinkDeviceId: string | null = null;
  private jackSimulated = false;
  private jackDeviceChannelCount = 0;
  private simJackDeviceId: string | null = null;

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

  public attachGraph(ctx: AudioContext, postAnalyser: AnalyserNode): void {
    this.ctx = ctx;
    this.postAnalyser = postAnalyser;

    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.monitorGain.channelCount = 2;
    this.monitorGain.channelCountMode = 'explicit';
    this.monitorGain.channelInterpretation = 'speakers';

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

    // Wire Post-DSP output to PA Monitor + PA Zone Delay/Trim -> Speakers, plus isolated Stream/OBS bus
    this.postAnalyser.connect(this.monitorGain);
    this.monitorGain.connect(this.paZoneDelayNode);
    this.paZoneDelayNode.connect(this.paZoneGainNode);
    this.paZoneGainNode.connect(ctx.destination);

    this.postAnalyser.connect(this.streamOutputGain);
    this.streamOutputGain.connect(this.streamMediaDest);

    // Fresh context: reset the discrete jack router (layout re-derived after
    // the sink is applied; see setOutputDevice / applySpeakerZones).
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

  public applySpeakerZones(zones: SpeakerZone[]): void {
    this.lastZones = zones;
    if (!this.ctx || !this.paZoneDelayNode || !this.paZoneGainNode || zones.length === 0) return;

    // ---- Discrete jack path: rebuild graph if the slot→zone patch changed ----
    if (this.reconcileJackGraph(zones)) {
      this.applyZoneValuesToJackChains(zones);
      return;
    }

    // ---- Legacy stereo path: only the main zone drives the single PA chain ----
    const mainZone = zones.find((z) => z.role === 'main-lr') ?? zones[0];
    if (!mainZone) return;

    const now = this.ctx.currentTime;
    const delaySec = clamp((mainZone.delayMs || 0) / 1000, 0, 0.5);
    const sign = mainZone.polarityInverted ? -1 : 1;
    const gainLinear = mainZone.mute ? 0 : dbToLinear(clamp(mainZone.levelDb ?? 0, -48, 12)) * sign;

    this.paZoneDelayNode.delayTime.setTargetAtTime(delaySec, now, 0.015);
    this.paZoneGainNode.gain.setTargetAtTime(gainLinear, now, 0.015);
  }

  // =========================================================================
  //   DISCRETE JACK ROUTER — 5.1/7.1/N-channel channel-pair zone routing
  //   One physical jack pair per zone: FL/FR (green), BL/BR (black),
  //   FC/LFE (orange), SL/SR (grey), plus generated AUX n pairs (channels
  //   8+) on pro cards. One-zone-per-jack interlock included.
  // =========================================================================

  /** Training-mode simulated 7.1 card id (see utils/jackTopology.ts). */
  public setSimulatedJackDeviceId(id: string | null): void {
    this.simJackDeviceId = id;
    // Re-evaluate routing against the current sink.
    if (this.ctx) this.reconcileJackGraph(this.lastZones);
  }

  /**
   * Channel count of the ACTIVE sink as the router understands it: real
   * device → destination.maxChannelCount (capped at 32 for pro cards);
   * simulated card → 8.
   */
  private detectSinkChannelCount(): number {
    if (!this.ctx) return 2;
    if (this.simJackDeviceId && this.preferredOutputDeviceId === this.simJackDeviceId) {
      return 8;
    }
    try {
      const max = this.ctx.destination.maxChannelCount || 2;
      return max >= 4 ? Math.min(max, 32) : 2;
    } catch {
      return 2;
    }
  }

  /**
   * Derive the slot→zone patch for the active sink (zones whose outputJackId
   * points at the sink device; main-lr defaults onto the green front jack when
   * nothing references the sink yet). Rebuilds the merger graph whenever the
   * patch or layout changes. Returns true when discrete mode is active.
   */
  private reconcileJackGraph(zones: SpeakerZone[]): boolean {
    if (!this.ctx || !this.monitorGain) return false;

    const sinkDeviceId = this.preferredOutputDeviceId || null;
    const simulated = Boolean(
      this.simJackDeviceId && sinkDeviceId === this.simJackDeviceId && sinkDeviceId !== null
    );
    const channelCount = this.detectSinkChannelCount();

    // Slot→zone patch: explicit assignments first (first-wins interlock), then
    // the automatic main-lr → front green jack default for a fresh install.
    const nextSlotZones = new Map<OutputJackSlot, string>();
    if (channelCount >= 4 && sinkDeviceId) {
      for (const zone of zones) {
        const parsed = parseJackId(zone.outputJackId);
        if (!parsed || parsed.deviceId !== sinkDeviceId) continue;
        if (!nextSlotZones.has(parsed.slot)) nextSlotZones.set(parsed.slot, zone.id);
      }
      if (nextSlotZones.size === 0) {
        const mainZone = zones.find((z) => z.role === 'main-lr') ?? zones[0];
        if (mainZone) nextSlotZones.set('front-lr', mainZone.id);
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
        this.buildJackGraph();
      }
    }

    return this.jackMerger !== null;
  }

  /** Build the merger + per-zone chains for the current slot patch. */
  private buildJackGraph(): void {
    if (!this.ctx || !this.monitorGain || !this.paZoneGainNode) return;
    const ctx = this.ctx;
    const channels = this.jackLayoutChannels;
    if (channels < 4 || this.jackSlotZones.size === 0) return;

    const merger = ctx.createChannelMerger(channels);

    // Iterate every slot of the CURRENT patch in physical order — includes
    // generated aux pairs on >8-channel sinks (the static named-slot order
    // would skip them).
    for (const slot of orderedJackSlots(channels)) {
      if (!this.jackSlotZones.has(slot)) continue;
      const indices = slotChannelIndices(slot, channels);
      if (!indices || indices[1] >= channels) continue;

      const zoneGain = ctx.createGain();
      zoneGain.gain.value = 1;
      zoneGain.channelCount = 2;
      zoneGain.channelCountMode = 'explicit';
      zoneGain.channelInterpretation = 'speakers';

      const zoneDelay = ctx.createDelay(0.5);
      zoneDelay.delayTime.value = 0;

      // Split L/R so each jack conductor receives its own channel — a
      // ChannelSplitter's outputs ARE the individual channels (the merger's
      // mono inputs then map them 1:1 onto the jack pair).
      const splitter = ctx.createChannelSplitter(2);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;

      this.monitorGain.connect(zoneGain);
      zoneGain.connect(zoneDelay);
      zoneDelay.connect(splitter);
      splitter.connect(merger, 0, indices[0]); // L → jack channel A
      splitter.connect(merger, 1, indices[1]); // R → jack channel B
      zoneDelay.connect(analyser);

      this.jackZoneChains.set(slot, { gain: zoneGain, delay: zoneDelay, splitter, analyser, buf: new Float32Array(analyser.fftSize) as Float32Array<ArrayBuffer> });
    }

    // Real multichannel devices: address the stream 1:1 with 'discrete'
    // (no browser speaker down-mix). Simulated card: leave the destination in
    // its default mode — the discrete merger output folds naturally so the
    // front pair stays audible on the physical stereo device while the other
    // jacks remain metered (training behaviour).
    if (!this.jackSimulated) {
      try {
        ctx.destination.channelCount = channels;
        ctx.destination.channelCountMode = 'explicit';
        ctx.destination.channelInterpretation = 'discrete';
      } catch {
        // Device refused the layout — merger still feeds the default layout.
      }
    }

    // Take over the destination: legacy PA zone chain goes silent, the
    // per-jack chains render instead.
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
          this.ctx.destination.channelCount = Math.max(2, this.ctx.destination.maxChannelCount || 2);
          this.ctx.destination.channelCountMode = 'explicit';
          this.ctx.destination.channelInterpretation = 'speakers';
        } catch {
          // ignore
        }
      }
    }
    for (const chain of this.jackZoneChains.values()) {
      try {
        chain.gain.disconnect();
        chain.delay.disconnect();
        chain.splitter.disconnect();
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

    if (this.ctx && this.monitorGain && this.paZoneDelayNode && this.paZoneGainNode) {
      // Restore legacy chain wiring.
      try {
        this.monitorGain.connect(this.paZoneDelayNode);
        this.paZoneDelayNode.connect(this.paZoneGainNode);
        this.paZoneGainNode.connect(this.ctx.destination);
      } catch {
        // ignore
      }
    }
  }

  /** Per-zone trim/delay/polarity/mute onto the active jack chains. */
  private applyZoneValuesToJackChains(zones: SpeakerZone[]): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [slot, zoneId] of this.jackSlotZones) {
      const chain = this.jackZoneChains.get(slot);
      const zone = zones.find((z) => z.id === zoneId);
      if (!chain || !zone) continue;
      const delaySec = clamp((zone.delayMs || 0) / 1000, 0, 0.5);
      const sign = zone.polarityInverted ? -1 : 1;
      const gainLinear = zone.mute ? 0 : dbToLinear(clamp(zone.levelDb ?? 0, -48, 12)) * sign;
      chain.delay.delayTime.setTargetAtTime(delaySec, now, 0.015);
      chain.gain.gain.setTargetAtTime(gainLinear, now, 0.015);
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

    // Simulated training card: no physical sink to switch — the discrete jack
    // router drives the layout, audio keeps flowing through the current sink.
    if (cleanId === SIM_PIE_8OUT_DEVICE_ID) {
      this.reconcileJackGraph(this.lastZones);
      this.applyZoneValuesToJackChains(this.lastZones);
      return true;
    }

    const ctxWithSink = this.ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
    const hasSetSinkId = 'setSinkId' in this.ctx && typeof ctxWithSink.setSinkId === 'function';

    if (hasSetSinkId && ctxWithSink.setSinkId) {
      try {
        await ctxWithSink.setSinkId(cleanId || '');
        // Sink switched: channel layout of the destination may have changed —
        // re-derive the discrete jack router against the new device.
        this.reconcileJackGraph(this.lastZones);
        this.applyZoneValuesToJackChains(this.lastZones);
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
          this.reconcileJackGraph(this.lastZones);
          this.applyZoneValuesToJackChains(this.lastZones);
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
      // Stored in preferredStreamOutputDeviceId; attachGraph() will wire it when engine starts
      return true;
    }
    try {
      if (!this.streamAudioEl && typeof Audio !== 'undefined') {
        this.streamAudioEl = new Audio();
        this.streamAudioEl.autoplay = true;
      }
      if (this.streamAudioEl) {
        this.streamAudioEl.srcObject = this.streamMediaDest.stream;
        if ('setSinkId' in this.streamAudioEl && typeof (this.streamAudioEl as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId === 'function') {
          await (this.streamAudioEl as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(cleanId);
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
