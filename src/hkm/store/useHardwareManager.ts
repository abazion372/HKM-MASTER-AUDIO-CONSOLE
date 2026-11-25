import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuditAuthority,
  DetectedHardwareEndpoint,
  DriverBackend,
  HardwareDevice,
  PlatformTarget,
} from '../types/audio.ts';
import {
  buildJackEndpoints,
  nativeColorToHda,
  SIM_PIE_8OUT_DEVICE_ID,
  SIM_PIE_8OUT_LABEL,
  type OutputJackEndpoint,
} from '../utils/jackTopology.ts';
import {
  buildEndpointSignature,
  clearCachedHardwareEndpoints,
  loadCachedHardwareEndpoints,
  saveDetectedHardwareEndpoints,
} from '../utils/hardwareCacheDb.ts';
import { scanBrowserMediaDevices } from '../utils/hardwareRecognition.ts';
import {
  enumerateAudioInputs,
  enumerateAudioOutputs,
  liveAudioEngine,
  subscribeHardwareChanges,
} from '../audio/liveAudioEngine.ts';
import {
  enumerateSpecializedDesktopInterfaces,
  type SpecializedDesktopInterface,
} from '../audio/systemAudioBridge.ts';
import { appFetch, isDesktopApp } from '../utils/appApi.ts';
import {
  listDesktopAudioSessions,
  listDesktopJackDescriptions,
  NATIVE_DESKTOP_AUDIO_ID,
  getApoStatus,
  getDesktopAudioStatus,
  installSystemApo,
  setApoDrySuppression,
  uninstallSystemApo,
  type ApoSystemStatus,
  type DesktopAudioSession,
  type DesktopAudioStatus,
} from '../utils/nativeDesktopAudio.ts';

interface UseHardwareManagerProps {
  activeDevice: HardwareDevice;
  platform: PlatformTarget;
  devices: HardwareDevice[];
  onRegisterDevices: (devices: HardwareDevice[]) => void;
  onSelectDevice: (device: HardwareDevice, overrideDriver?: DriverBackend) => Promise<void>;
  logAudit: (action: string, detail: string, authority?: AuditAuthority) => void;
  hydrated?: boolean;
  onSyncLiveInputsToChannels?: (liveInputs: MediaDeviceInfo[], isStartupSync: boolean) => void;
}

function buildDeviceListSignature(devs: MediaDeviceInfo[]): string {
  return devs
    .map((d) => `${d.deviceId || ''}::${d.label || ''}`)
    .sort()
    .join('|');
}

function migrateLegacyOutputStorage(): { outputId: string; streamOutputId: string } {
  try {
    const cleanedFlag = window.localStorage.getItem('church_audio_v0228_io_clean');
    const rawOut = window.localStorage.getItem('church_audio_output_device_id') || '';
    const cleanOut = rawOut.split('::')[0];
    if (rawOut !== cleanOut) {
      window.localStorage.setItem('church_audio_output_device_id', cleanOut);
    }

    let streamOut = window.localStorage.getItem('church_audio_stream_output_device_id') || '';
    if (!cleanedFlag) {
      // One-time cleanup: clear prior auto-hijacked VB-Audio stream output to eliminate default loopback
      window.localStorage.removeItem('church_audio_stream_output_device_id');
      window.localStorage.setItem('church_audio_v0228_io_clean', '1');
      streamOut = '';
    } else if (streamOut.includes('::')) {
      streamOut = streamOut.split('::')[0];
      window.localStorage.setItem('church_audio_stream_output_device_id', streamOut);
    }
    return { outputId: cleanOut, streamOutputId: streamOut };
  } catch {
    return { outputId: '', streamOutputId: '' };
  }
}

export function useHardwareManager({
  activeDevice,
  platform,
  devices,
  onRegisterDevices,
  onSelectDevice,
  logAudit,
  hydrated = false,
  onSyncLiveInputsToChannels,
}: UseHardwareManagerProps) {
  const [detectedEndpoints, setDetectedEndpoints] = useState<DetectedHardwareEndpoint[]>([]);
  const [scanningHardware, setScanningHardware] = useState(false);
  const [hotPlugEndpoint, setHotPlugEndpoint] = useState<DetectedHardwareEndpoint | null>(null);
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [rawOutputDevices, setRawOutputDevices] = useState<MediaDeviceInfo[]>([]);

  // ---- Discrete jack router (5.1/7.1 per-jack outputs) ----
  // Synchronous lazy init from localStorage — MUST be settled before the
  // "sim card disabled while it is the Master PA sink" guard effect runs,
  // otherwise that guard would clear a valid sink on every mount.
  const [simulatedSurroundCard, setSimulatedSurroundCard] = useState(() => {
    try {
      return window.localStorage.getItem('church_audio_sim_71_card') === '1';
    } catch {
      return false;
    }
  });
  const [probedOutputJackEndpoints, setProbedOutputJackEndpoints] = useState<OutputJackEndpoint[]>([]);
  const [jackProbeBusy, setJackProbeBusy] = useState(false);

  const SIM_PIE_8OUT_DEVICE = useMemo(
    () =>
      ({
        deviceId: SIM_PIE_8OUT_DEVICE_ID,
        groupId: 'hkm-sim-pcie-jack-card',
        kind: 'audiooutput' as MediaDeviceKind,
        label: SIM_PIE_8OUT_LABEL,
        toJSON: () => ({}),
      }) as MediaDeviceInfo,
    []
  );

  /** Real outputs + optional training card (composed list used by all UI selects). */
  const outputDevices = useMemo(
    () => (simulatedSurroundCard ? [SIM_PIE_8OUT_DEVICE, ...rawOutputDevices] : rawOutputDevices),
    [rawOutputDevices, simulatedSurroundCard, SIM_PIE_8OUT_DEVICE]
  );

  /** Discrete jack endpoints: probed real 5.1/7.1 cards + the simulated card. */
  const outputJackEndpoints = useMemo(() => {
    if (!simulatedSurroundCard) return probedOutputJackEndpoints;
    return [
      ...buildJackEndpoints({ deviceId: SIM_PIE_8OUT_DEVICE_ID, label: SIM_PIE_8OUT_LABEL }, 8, true),
      ...probedOutputJackEndpoints,
    ];
  }, [probedOutputJackEndpoints, simulatedSurroundCard]);
  const [specializedDesktopInputs, setSpecializedDesktopInputs] = useState<SpecializedDesktopInterface[]>([]);
  const [outputRouteError, setOutputRouteError] = useState<string | null>(null);

  const [{ outputId: initOutId, streamOutputId: initStreamId }] = useState(() =>
    migrateLegacyOutputStorage()
  );
  const [preferredOutputDeviceId, setPreferredOutputDeviceId] = useState<string>(initOutId);
  const [preferredStreamOutputDeviceId, setPreferredStreamOutputDeviceId] =
    useState<string>(initStreamId);
  const [desktopAudioStatus, setDesktopAudioStatus] = useState<DesktopAudioStatus | null>(null);
  const [desktopAudioSessions, setDesktopAudioSessions] = useState<DesktopAudioSession[]>([]);
  const [apoStatus, setApoStatus] = useState<ApoSystemStatus | null>(null);
  const [singleSpeakerMode, setSingleSpeakerMode] = useState<boolean>(false);
  const [apoBusy, setApoBusy] = useState<boolean>(false);
  const [apoMessage, setApoMessage] = useState<{
    tone: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  const desktopSupportedRef = useRef<boolean | null>(null);
  const activeOnBusSignaturesRef = useRef<Set<string>>(new Set());
  const cachedSynthDevicesRef = useRef<HardwareDevice[]>([]);
  const startupSyncedRef = useRef<boolean>(false);
  const scanInFlightRef = useRef<boolean>(false);
  const lastInputSigRef = useRef<string>('');
  const lastOutputSigRef = useRef<string>('');
  const lastSpecializedSigRef = useRef<string>('');
  const onSyncLiveInputsRef = useRef(onSyncLiveInputsToChannels);
  onSyncLiveInputsRef.current = onSyncLiveInputsToChannels;
  const latestRef = useRef({
    activeDevice,
    platform,
    devices,
    onRegisterDevices,
    onSelectDevice,
    logAudit,
  });
  latestRef.current = {
    activeDevice,
    platform,
    devices,
    onRegisterDevices,
    onSelectDevice,
    logAudit,
  };

  // Apply persisted standalone stereo output device selection without enabling loopback
  useEffect(() => {
    if (preferredOutputDeviceId) {
      void liveAudioEngine.setOutputDevice(preferredOutputDeviceId).then((applied) => {
        setOutputRouteError(
          applied
            ? null
            : 'The selected output is not active. Audio is still routed to the previous output.'
        );
      });
    }
  }, [preferredOutputDeviceId]);

  useEffect(() => {
    liveAudioEngine.setOnOutputFallback((staleId, reason) => {
      setPreferredOutputDeviceId('');
      setOutputRouteError(null);
      try {
        window.localStorage.setItem('church_audio_output_device_id', '');
      } catch {
        // ignore storage error
      }
      latestRef.current.logAudit('Recovered Audio Output Routing', `${reason} (Cleared stale ID: ${staleId})`, 'system');
    });
    return () => liveAudioEngine.setOnOutputFallback(null);
  }, []);

  const handleSelectOutputDevice = useCallback(
    async (deviceId: string) => {
      const cleanId = (deviceId || '').split('::')[0];
      setPreferredOutputDeviceId(cleanId);
      try {
        window.localStorage.setItem('church_audio_output_device_id', cleanId);
      } catch {
        // ignore storage error
      }
      const applied = await liveAudioEngine.setOutputDevice(cleanId);
      setOutputRouteError(
        applied
          ? null
          : 'The selected output is not active. Audio is still routed to the previous output.'
      );
      logAudit(
        applied ? 'Audio Output Changed' : 'Audio Output Change Failed',
        applied
          ? cleanId
            ? `Standalone Stereo PA Output: ${cleanId}`
            : 'System Default Stereo Output'
          : `Could not apply output device ${cleanId || '(system default)'}.`,
        'operator'
      );
      return applied;
    },
    [logAudit]
  );

  const handleSelectStreamOutputDevice = useCallback(
    async (deviceId: string) => {
      const cleanId = (deviceId || '').split('::')[0];
      setPreferredStreamOutputDeviceId(cleanId);
      try {
        if (cleanId) {
          window.localStorage.setItem('church_audio_stream_output_device_id', cleanId);
        } else {
          window.localStorage.removeItem('church_audio_stream_output_device_id');
        }
      } catch {
        // ignore storage error
      }
      await liveAudioEngine.setStreamOutputDevice(cleanId);
      logAudit(
        'Dedicated Stream Output Changed',
        cleanId ? `Dedicated stream sink enabled: ${cleanId}` : 'Dedicated stream sink disabled',
        'operator'
      );
    },
    [logAudit]
  );

  // =========================================================================
  //   DISCRETE JACK ROUTER — 5.1/7.1/N-channel output channel layout probing
  //   (Realtek/ASUS/Creative/SB PCIe + onboard surround cards expose ONE
  //   endpoint whose stream carries 6/8 channels; each physical jack pair is
  //   a fixed channel position inside that stream. Pro cards (RME, M-Audio
  //   Delta 1010, Dante virtual soundcards) expose 10-32 channels and gain
  //   generated AUX pairs beyond channel 7. See utils/jackTopology.ts.)
  // =========================================================================

  const JACK_LAYOUT_CACHE_KEY = 'church_audio_jack_layout_cache';
  const JACK_LAYOUT_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

  const loadJackLayoutCache = (): Record<string, { label: string; count: number; ts: number }> => {
    try {
      return JSON.parse(window.localStorage.getItem(JACK_LAYOUT_CACHE_KEY) || '{}');
    } catch {
      return {};
    }
  };

  const saveJackLayoutCache = (cache: Record<string, { label: string; count: number; ts: number }>) => {
    try {
      window.localStorage.setItem(JACK_LAYOUT_CACHE_KEY, JSON.stringify(cache));
    } catch {
      // ignore storage error
    }
  };

  /** Open a throwaway AudioContext on the device and read its true channel count. */
  const probeDeviceChannelCount = async (device: MediaDeviceInfo): Promise<number> => {
    try {
      const Ctor = window.AudioContext;
      if (!Ctor || !device.deviceId || device.deviceId === 'default' || device.deviceId === 'communications') {
        return 2;
      }
      const probeCtx = new Ctor({ sinkId: device.deviceId } as unknown as AudioContextOptions);
      const max = probeCtx.destination?.maxChannelCount || 2;
      void probeCtx.close().catch(() => {});
      return Math.max(2, Math.min(max, 32));
    } catch {
      return 2;
    }
  };

  /**
   * Probe every enumerated output device for a multichannel (5.1/7.1) layout
   * and explode those devices into discrete jack endpoints. Cached per device
   * (label-matched, 30-day TTL); `explicit` forces a fresh probe + busy flag.
   */
  const probeOutputChannelLayouts = useCallback(
    async (devices: MediaDeviceInfo[], explicit = false) => {
      const candidates = devices.filter(
        (d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.deviceId !== SIM_PIE_8OUT_DEVICE_ID
      );
      if (candidates.length === 0) {
        setProbedOutputJackEndpoints([]);
        return;
      }
      if (explicit) setJackProbeBusy(true);
      try {
        const cache = loadJackLayoutCache();
        const endpoints: OutputJackEndpoint[] = [];
        const deviceCounts: Record<string, number> = {};

        // On Windows Desktop, also query native WASAPI endpoint channel counts & PCIe capability
        let nativeEndpoints = apoStatus?.endpoints ?? [];
        if (isDesktopApp() && (explicit || nativeEndpoints.length === 0)) {
          const freshApo = await getApoStatus();
          if (freshApo) {
            setApoStatus(freshApo);
            nativeEndpoints = freshApo.endpoints;
          }
        }

        for (const dev of candidates) {
          let count = 2;
          const hit = cache[dev.deviceId];
          if (!explicit && hit && hit.label === dev.label && Date.now() - hit.ts < JACK_LAYOUT_CACHE_TTL_MS) {
            count = hit.count;
          } else {
            count = await probeDeviceChannelCount(dev);
          }

          // Cross-match with native Windows WASAPI endpoint metadata by label
          const devLabelLower = (dev.label || '').toLowerCase();
          const matchedNative = nativeEndpoints.find((ne) => {
            const neLower = (ne.name || '').toLowerCase();
            return (
              (devLabelLower && neLower && (devLabelLower.includes(neLower) || neLower.includes(devLabelLower))) ||
              (ne.isDefault && candidates.indexOf(dev) === 0)
            );
          });

          if (matchedNative?.channels && matchedNative.channels > count) {
            count = matchedNative.channels;
          }

          // Recognize PCIe / Onboard 5.1 & 7.1 analog speaker cards so their Rear/Center/Front jacks
          // are always available as discrete separated channels rather than a single mixed output
          const isPcieMultiJackCard =
            Boolean(matchedNative?.isMultichannelCapable) ||
            /5\.1|7\.1|surround|xonar|sound blaster|audigy|pci-?e|multi-?channel/i.test(dev.label || '') ||
            (/realtek|high definition audio|hd audio/i.test(dev.label || '') &&
              /speaker|line out|analog|rear/i.test(dev.label || '') &&
              !/headphone|earphone|digital|spdif|optical|hdmi|displayport|nvidia|amd/i.test(dev.label || ''));

          if (count < 6 && isPcieMultiJackCard) {
            count = /7\.1|8-?ch/i.test(dev.label || '') ? 8 : 6;
          }

          cache[dev.deviceId] = { label: dev.label || '', count, ts: Date.now() };
          deviceCounts[dev.deviceId] = count;

          if (count >= 4) {
            endpoints.push(
              ...buildJackEndpoints(
                { deviceId: dev.deviceId, label: dev.label || `Audio Output (${dev.deviceId.slice(0, 6)})` },
                count
              )
            );
          }
        }
        saveJackLayoutCache(cache);
        liveAudioEngine.setKnownDeviceChannelCounts(deviceCounts);

        // Desktop app: refine jack colours with real IKsJackDescription
        // metadata from the Rust shell (list_jack_descriptions) so the bay
        // honours the card's actual silkscreen colours. Best-effort — the
        // browser deviceId may differ from the native endpointId, so match
        // on exact endpointId first, then a case-insensitive friendly-name /
        // label substring fallback; any mismatch keeps the probed values.
        if (isDesktopApp() && endpoints.length > 0) {
          try {
            const nativeJacks = await listDesktopJackDescriptions();
            for (const jack of endpoints) {
              const deviceJacks = nativeJacks.filter((nj) => {
                if (nj.endpointId === jack.parentDeviceId) return true;
                const nativeName = nj.friendlyName.toLowerCase();
                const label = jack.parentDeviceLabel.toLowerCase();
                return Boolean(
                  nativeName && label && (nativeName.includes(label) || label.includes(nativeName))
                );
              });
              const pairJack = deviceJacks.find((nj) => nj.channel === jack.channelIndices[0]);
              if (pairJack && pairJack.colorRgb !== 0) {
                const hda = nativeColorToHda(pairJack.colorRgb);
                jack.jackColorName = hda.colorName;
                jack.jackColorHex = hda.colorHex;
              }
            }
          } catch {
            // Native jack hints unavailable — keep the probed colours.
          }
        }

        setProbedOutputJackEndpoints(endpoints);
        if (explicit) {
          // Count multi-channel CARDS, not jack endpoints: group the exploded
          // jacks by parent device (a 7.1 card yields 4 jacks, a 16-CH pro
          // card yields 8 — endpoint counts are not card counts).
          const cardsByDevice = new Map<string, OutputJackEndpoint[]>();
          for (const ep of endpoints) {
            const list = cardsByDevice.get(ep.parentDeviceId) ?? [];
            list.push(ep);
            cardsByDevice.set(ep.parentDeviceId, list);
          }
          let multiChannelCards = 0;
          for (const group of cardsByDevice.values()) {
            if (group.length > 0 && group[0].channelCount >= 4) multiChannelCards += 1;
          }
          const multi = endpoints.length > 0;
          logAudit(
            'Discrete Jack Probe',
            multi
              ? `Probed ${candidates.length} outputs — ${multiChannelCards} multi-channel card(s) with discrete jack topology found`
              : `Probed ${candidates.length} outputs — no 5.1/7.1 jack topology detected (stereo endpoints only)`,
            'operator'
          );
        }
      } finally {
        if (explicit) setJackProbeBusy(false);
      }
    },
    [logAudit]
  );

  /** Training-mode simulated 7.1 PCIe jack card (demo without hardware). */
  const toggleSimulatedSurroundCard = useCallback(() => {
    setSimulatedSurroundCard((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('church_audio_sim_71_card', next ? '1' : '0');
      } catch {
        // ignore storage error
      }
      liveAudioEngine.setSimulatedJackDeviceId(next ? SIM_PIE_8OUT_DEVICE_ID : null);
      logAudit(
        'Simulated 7.1 Jack Card',
        next
          ? 'Training card enabled — discrete jack routing armed (front/rear/center-sub/side pairs)'
          : 'Training card disabled — standalone stereo outputs restored',
        'operator'
      );
      return next;
    });
  }, [logAudit]);

  // Keep the engine's simulated-card flag in sync (mount + toggles).
  useEffect(() => {
    liveAudioEngine.setSimulatedJackDeviceId(simulatedSurroundCard ? SIM_PIE_8OUT_DEVICE_ID : null);
  }, [simulatedSurroundCard]);

  // If the training card is disabled while it is the Master PA sink, clear it.
  useEffect(() => {
    if (!simulatedSurroundCard && preferredOutputDeviceId === SIM_PIE_8OUT_DEVICE_ID) {
      void handleSelectOutputDevice('');
    }
  }, [simulatedSurroundCard, preferredOutputDeviceId, handleSelectOutputDevice]);

  const refreshDesktopAudioInfo = useCallback(async () => {
    if (!isDesktopApp()) return null;
    const [status, sessions, apo] = await Promise.all([
      getDesktopAudioStatus(),
      listDesktopAudioSessions(),
      getApoStatus(),
    ]);
    desktopSupportedRef.current = status.supported;
    setDesktopAudioStatus(status);
    setDesktopAudioSessions(sessions);
    setApoStatus(apo);
    return { status, sessions, apo };
  }, []);

  const handleToggleSingleSpeakerMode = useCallback(
    async (enabled: boolean, endpointId?: string) => {
      if (!isDesktopApp()) return;
      if (!enabled) {
        setSingleSpeakerMode(false);
        await setApoDrySuppression(false, endpointId);
        await liveAudioEngine.setRawOutputEnabled(false);
        await refreshDesktopAudioInfo();
        setApoMessage({
          tone: 'info',
          text: 'Single-Speaker APO suppression disabled; reverted to standard Engine 1 WASAPI loopback.',
        });
        logAudit(
          'Disabled Single-Speaker APO Mode',
          'APO reverted to 100% passthrough; Engine 1 process loopback active.',
          'operator'
        );
        return;
      }

      const freshApo = await getApoStatus();
      setApoStatus(freshApo);
      if (!freshApo?.apoLoadedInAudiodg) {
        setSingleSpeakerMode(false);
        await setApoDrySuppression(false);
        await liveAudioEngine.setRawOutputEnabled(false);
        setApoMessage({
          tone: 'info',
          text: freshApo?.apoRegisteredAny
            ? 'APO hook is registered, but audiodg.exe has not loaded hkm_audio_apo.dll yet (Windows 11 Protected Audio requires Authenticode/EV trust). Engine 1 remains active seamlessly.'
            : 'Install the APO onto a speaker first (or continue using zero-driver Engine 1 WASAPI loopback).',
        });
        return;
      }

      const targetId = endpointId || freshApo.selectedEndpointId || undefined;
      await setApoDrySuppression(true, targetId);
      const rawOk = await liveAudioEngine.setRawOutputEnabled(true, targetId);
      setSingleSpeakerMode(rawOk);
      if (!rawOk) {
        await setApoDrySuppression(false);
      }
      await refreshDesktopAudioInfo();
      setApoMessage({
        tone: rawOk ? 'success' : 'error',
        text: rawOk
          ? 'Single-Speaker Zero-Doubling active (MFX APO dry suppression + WASAPI RAW output).'
          : 'Could not open WASAPI RAW output stream on selected speaker; staying on Engine 1 loopback.',
      });
      logAudit(
        rawOk ? 'Enabled Single-Speaker APO Mode' : 'Single-Speaker RAW Output Unavailable',
        rawOk
          ? 'APO dry suppression + WASAPI RAW output enabled.'
          : 'Fell back cleanly to Engine 1 process-exclusion loopback.',
        'operator'
      );
    },
    [logAudit, refreshDesktopAudioInfo]
  );

  const handleInstallApo = useCallback(
    async (endpointId: string) => {
      if (!isDesktopApp()) return;
      setApoBusy(true);
      setApoMessage(null);
      try {
        const msg = await installSystemApo(endpointId);
        await refreshDesktopAudioInfo();
        setApoMessage({ tone: 'success', text: msg });
        logAudit('Installed Desktop APO Hook', msg, 'operator');
      } catch (err) {
        setApoMessage({ tone: 'error', text: String(err) });
      } finally {
        setApoBusy(false);
      }
    },
    [logAudit, refreshDesktopAudioInfo]
  );

  const handleUninstallApo = useCallback(
    async (endpointId: string) => {
      if (!isDesktopApp()) return;
      setApoBusy(true);
      setApoMessage(null);
      try {
        setSingleSpeakerMode(false);
        await liveAudioEngine.setRawOutputEnabled(false);
        const msg = await uninstallSystemApo(endpointId);
        await refreshDesktopAudioInfo();
        setApoMessage({ tone: 'info', text: msg });
        logAudit('Uninstalled Desktop APO Hook', msg, 'operator');
      } catch (err) {
        setApoMessage({ tone: 'error', text: String(err) });
      } finally {
        setApoBusy(false);
      }
    },
    [logAudit, refreshDesktopAudioInfo]
  );

  const enumerateCleanPorts = useCallback(
    async (requestPermission = false, refreshNativeInfo = false) => {
      if (
        requestPermission &&
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices?.getUserMedia
      ) {
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach((t) => t.stop());
        } catch {
          // Proceed even if permission prompt dismissed or no microphone exists
        }
      }
      const [inputs, outputs, specialized] = await Promise.all([
        enumerateAudioInputs(),
        enumerateAudioOutputs(),
        enumerateSpecializedDesktopInterfaces(),
      ]);

      liveAudioEngine.updateOutputDeviceMetadata(outputs);
      const specSig = specialized.map((s) => `${s.deviceId}::${s.label}`).join('|');
      if (specSig !== lastSpecializedSigRef.current) {
        lastSpecializedSigRef.current = specSig;
        setSpecializedDesktopInputs(specialized);
      }

      if (isDesktopApp()) {
        let supported = desktopSupportedRef.current;
        if (supported === null || refreshNativeInfo) {
          const info = await refreshDesktopAudioInfo();
          supported = info?.status.supported ?? false;
        }
        if (supported && !inputs.some((d) => d.deviceId === NATIVE_DESKTOP_AUDIO_ID)) {
          const nativeDesktopEntry = {
            deviceId: NATIVE_DESKTOP_AUDIO_ID,
            groupId: 'hkm-native-desktop',
            kind: 'audioinput' as MediaDeviceKind,
            label: 'Desktop Audio (All Apps)',
            toJSON: () => ({}),
          } as MediaDeviceInfo;
          return { inputs: [...inputs, nativeDesktopEntry], outputs };
        }
      }

      return { inputs, outputs };
    },
    [refreshDesktopAudioInfo]
  );

  const refreshAudioDevices = useCallback(
    async (
      requestPermission = true,
      mode: 'slot-new' | 'reset-from-ch1' = 'slot-new'
    ) => {
      const { inputs, outputs } = await enumerateCleanPorts(requestPermission, true);
      lastInputSigRef.current = buildDeviceListSignature(inputs);
      lastOutputSigRef.current = buildDeviceListSignature(outputs);
      setInputDevices(inputs);
      setRawOutputDevices(outputs);
      void probeOutputChannelLayouts(outputs, false);
      onSyncLiveInputsRef.current?.(inputs, mode === 'reset-from-ch1');
      return { inputs, outputs };
    },
    [enumerateCleanPorts, probeOutputChannelLayouts]
  );

  // 1. Wait for persisted session hydration, then occupy CH1..CHN 1-to-1 with all startup live inputs
  useEffect(() => {
    if (!hydrated || startupSyncedRef.current) return;
    startupSyncedRef.current = true;
    let cancelled = false;

    const runStartupDiscovery = async () => {
      let { inputs, outputs } = await enumerateCleanPorts(false, true);
      if (cancelled) return;

      // Unlock labels silently once on desktop startup if labels are still masked
      const needsPermissionUnlock = inputs.length === 0 || inputs.some((d) => !d.label);
      if (needsPermissionUnlock) {
        const unlocked = await enumerateCleanPorts(true, false);
        if (cancelled) return;
        inputs = unlocked.inputs;
        outputs = unlocked.outputs;
      }

      lastInputSigRef.current = buildDeviceListSignature(inputs);
      lastOutputSigRef.current = buildDeviceListSignature(outputs);
      setInputDevices(inputs);
      setRawOutputDevices(outputs);
      void probeOutputChannelLayouts(outputs, false);
      onSyncLiveInputsRef.current?.(inputs, true);
    };

    void runStartupDiscovery();
    return () => {
      cancelled = true;
    };
  }, [enumerateCleanPorts, hydrated]);

  // 2. Post-startup hot-plug auto-scanner (instant devicechange event + 30s visible-only fallback)
  useEffect(() => {
    if (!hydrated) return;
    let active = true;

    const checkHotPlugChanges = async (refreshNative: boolean) => {
      const { inputs, outputs } = await enumerateCleanPorts(false, refreshNative);
      if (!active) return;

      const inSig = buildDeviceListSignature(inputs);
      const outSig = buildDeviceListSignature(outputs);

      if (inSig !== lastInputSigRef.current || outSig !== lastOutputSigRef.current) {
        lastInputSigRef.current = inSig;
        lastOutputSigRef.current = outSig;
        setInputDevices(inputs);
        setRawOutputDevices(outputs);
        void probeOutputChannelLayouts(outputs, false);
        if (startupSyncedRef.current) {
          onSyncLiveInputsRef.current?.(inputs, false);
        }
      }
    };

    const unsub = subscribeHardwareChanges(() => {
      void checkHotPlugChanges(true);
    });
    const pollTimer = window.setInterval(() => {
      if (document.hidden) return;
      void checkHotPlugChanges(false);
    }, 30000);

    return () => {
      active = false;
      unsub();
      window.clearInterval(pollTimer);
    };
  }, [enumerateCleanPorts, hydrated]);

  // Proactive USB, Internal, and LAN Audio endpoint hardware scanner
  const runHardwareScan = useCallback(
    async (requestPermission = false, announceHotPlug = true) => {
      if (scanInFlightRef.current) return;
      scanInFlightRef.current = true;
      setScanningHardware(true);
      try {
        const {
          activeDevice: curDev,
          logAudit: curLogAudit,
          onRegisterDevices: curRegisterDevices,
          platform: curPlatform,
        } = latestRef.current;

        const cachedBeforeScan = await loadCachedHardwareEndpoints();
        if (requestPermission && navigator.mediaDevices?.getUserMedia) {
          try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            tempStream.getTracks().forEach((t) => t.stop());
          } catch {
            // Proceed even if permission prompt dismissed
          }
        }

        const [serverRes, browserEndpoints, specialized] = await Promise.all([
          appFetch('/api/hardware/scan')
            .then((r) => (r.ok ? r.json() : { endpoints: [] }))
            .catch(() => ({ endpoints: [] })),
          scanBrowserMediaDevices(curPlatform),
          enumerateSpecializedDesktopInterfaces(),
        ]);

        const specSig = specialized.map((s) => `${s.deviceId}::${s.label}`).join('|');
        if (specSig !== lastSpecializedSigRef.current) {
          lastSpecializedSigRef.current = specSig;
          setSpecializedDesktopInputs(specialized);
        }

        const osEndpoints: DetectedHardwareEndpoint[] = Array.isArray(serverRes?.endpoints)
          ? serverRes.endpoints
          : [];

        const mergedMap = new Map<string, DetectedHardwareEndpoint>();
        for (const ep of cachedBeforeScan.endpoints) {
          mergedMap.set(buildEndpointSignature(ep), { ...ep, cachedFromIndexedDb: true });
        }
        for (const ep of browserEndpoints) {
          mergedMap.set(buildEndpointSignature(ep), { ...ep, cachedFromIndexedDb: false });
        }
        for (const ep of osEndpoints) {
          const sig = buildEndpointSignature(ep);
          const existing = mergedMap.get(sig);
          mergedMap.set(sig, {
            ...(existing || ep),
            ...ep,
            cachedFromIndexedDb: false,
          });
        }

        const liveEndpoints = Array.from(mergedMap.values());
        const persistedMerged = await saveDetectedHardwareEndpoints(
          liveEndpoints,
          curDev.id
        );
        setDetectedEndpoints(persistedMerged);

        const allSynthDevices = persistedMerged
          .map((ep) => ep.synthesizedDevice)
          .filter((d): d is HardwareDevice => Boolean(d));

        if (allSynthDevices.length > 0) {
          cachedSynthDevicesRef.current = allSynthDevices;
          curRegisterDevices(allSynthDevices);
        }

        if (announceHotPlug) {
          const newlyAdded = liveEndpoints.find((ep) => {
            const sig = buildEndpointSignature(ep);
            return (
              !activeOnBusSignaturesRef.current.has(sig) &&
              ep.matchedDeviceId !== curDev.id &&
              (ep.kind === 'usb-audio' ||
                ep.kind === 'network-console' ||
                ep.kind === 'thunderbolt')
            );
          });
          if (newlyAdded) {
            const wasCached = cachedBeforeScan.endpoints.some(
              (c) => buildEndpointSignature(c) === buildEndpointSignature(newlyAdded)
            );
            setHotPlugEndpoint(newlyAdded);
            curLogAudit(
              wasCached
                ? 'Recognized Remembered Hardware Plug-In'
                : 'Hardware Hot-Plug Detected',
              `${newlyAdded.name} → ${newlyAdded.matchedLabel} (${wasCached ? 'IndexedDB Instant Match' : newlyAdded.confidence})`,
              'system'
            );
          }
        }

        activeOnBusSignaturesRef.current = new Set(
          liveEndpoints.map((ep) => buildEndpointSignature(ep))
        );
      } finally {
        scanInFlightRef.current = false;
        setScanningHardware(false);
      }
    },
    []
  );

  const handleClearHardwareCache = useCallback(async () => {
    await clearCachedHardwareEndpoints();
    activeOnBusSignaturesRef.current.clear();
    await runHardwareScan(false, false);
    latestRef.current.logAudit(
      'Cleared IndexedDB Hardware Cache',
      'Reset locally remembered hardware signatures and re-scanned active endpoints.',
      'operator'
    );
  }, [runHardwareScan]);

  const handleBindDetectedEndpoint = useCallback(
    async (ep: DetectedHardwareEndpoint) => {
      const {
        devices: curDevices,
        onRegisterDevices: curRegisterDevices,
        onSelectDevice: curSelectDevice,
      } = latestRef.current;

      let targetDevice = curDevices.find((d) => d.id === ep.matchedDeviceId);
      if (!targetDevice && ep.synthesizedDevice) {
        targetDevice = ep.synthesizedDevice;
        curRegisterDevices([targetDevice]);
      }
      if (!targetDevice) return;

      if (ep.browserDeviceId) {
        if (/speaker|headphone|earphone|line out|cable in/i.test(ep.name)) {
          void handleSelectOutputDevice(ep.browserDeviceId);
        } else {
          void refreshAudioDevices(false, 'slot-new');
        }
      }
      setHotPlugEndpoint(null);
      await curSelectDevice(targetDevice, ep.recommendedDriver);
    },
    [handleSelectOutputDevice, refreshAudioDevices]
  );

  // Initial IndexedDB hydration (ONCE on mount)
  useEffect(() => {
    let mounted = true;
    void loadCachedHardwareEndpoints().then((cached) => {
      if (!mounted) return;
      if (cached.synthesizedDevices.length > 0) {
        cachedSynthDevicesRef.current = cached.synthesizedDevices;
        latestRef.current.onRegisterDevices(cached.synthesizedDevices);
      }
      if (cached.endpoints.length > 0) {
        setDetectedEndpoints(cached.endpoints);
      }
      void runHardwareScan(false, false);
    });

    const unsubHardware = subscribeHardwareChanges(() => {
      void runHardwareScan(false, true);
    });

    return () => {
      mounted = false;
      unsubHardware();
    };
  }, [runHardwareScan]);

  return {
    detectedEndpoints,
    scanningHardware,
    hotPlugEndpoint,
    inputDevices,
    outputDevices,
    outputJackEndpoints,
    jackProbeBusy,
    simulatedSurroundCard,
    probeOutputChannelLayouts,
    toggleSimulatedSurroundCard,
    specializedDesktopInputs,
    outputRouteError,
    preferredOutputDeviceId,
    preferredStreamOutputDeviceId,
    desktopAudioStatus,
    desktopAudioSessions,
    apoStatus,
    singleSpeakerMode,
    apoBusy,
    apoMessage,
    refreshDesktopAudioInfo,
    handleToggleSingleSpeakerMode,
    handleInstallApo,
    handleUninstallApo,
    refreshAudioDevices,
    handleSelectOutputDevice,
    handleSelectStreamOutputDevice,
    runHardwareScan,
    handleClearHardwareCache,
    handleBindDetectedEndpoint,
    dismissHotPlug: () => setHotPlugEndpoint(null),
    cachedSynthDevicesRef,
  };
}
