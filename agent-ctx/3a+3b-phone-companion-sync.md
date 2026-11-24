# Task 3a+3b — Phone Companion App + Sync Protocol

Task ID: 3a+3b. Files owned and modified are listed below. Parallel tasks: 2b owns
jackTopology.ts / outputRouter.ts / useHardwareManager.ts / ConsoleLeftPanel.tsx /
nativeDesktopAudio.ts / src-tauri — NOT touched by this task.

## Files changed

| File | Change |
|---|---|
| `mini-services/audio-ws/index.ts` | Added `zone:patch` WS message handler (permission sanitization + store merge + broadcast-except-sender). Fixed PRE-EXISTING bug: `/internal/*` POST body was a non-awaited Promise, so `broadcast` and `kick-client` internal endpoints silently no-op'd (desktop->mobile `state:sync` relays and single-client kick never fired). Handler now `async fetch` + `await req.json()`. |
| `src/app/api/state/sync/route.ts` | Added `zones: state.zones` to the `state:sync` wsBroadcast payload. |
| `src/hkm/store/useConsoleSession.ts` | Desktop WS onmessage now handles `zone:patch` (sourceRole !== 'desktop'): bumps `suppressSyncCountRef`, merges patch via `setZones`. Verified debounced PUT body already includes `zones`; desktop still ignores `state:sync` by design. |
| `src/hkm/components/RemoteCompanionView.tsx` | Major upgrade: speaker-zone control section (level stepper+slider -24..+12 step 0.5, mute, read-only delay chip, jack slot chip parsed from `${deviceId}::jack::${slot}`), ZONES/CHANNELS segmented toggle (default CHANNELS), wake lock while connected, iOS safe-area padding (header top + main bottom), connection-health footer (status dot + "LIVE SYNC · WS" + 250ms last-message age ticker), haptics on zone/channel mute, solo and MUTE PA, companion-only SW registration, footer text fixed to "Synced via FOH companion link", new `onFatalAuthError` prop (fires on WS close 4001/4002/4003 only, never for PIN retries). |
| `src/hkm/components/CompanionPairingGate.tsx` (new) | Pairing landing card for `?mode=remote` without a valid token: title "HKM FOH Companion", QR instructions, manual 16-char token input + CONNECT, "Open Desktop Console" button, fatal-error display, companion-only SW registration. Token input preserves case (real tokens are 16-char base64url, mixed case — uppercasing would break pairing). |
| `src/hkm/App.tsx` | Small surgical edits: new `remoteModeActive` + `companionFatalError` state (initial state block), `useConsoleSession` receives truthy flag while the gate is showing (suppresses desktop hydration/WS/PUT-sync on the phone), `handleExitRemoteCompanion` also clears remote mode, new `handleCompanionConnect` (sets token + history.replaceState URL) and `handleOpenDesktopConsole`, render branch: companion view only when token && !fatalError, else pairing gate when remoteModeActive, `onOpenRemoteCompanion` also activates remote mode. |
| `src/app/layout.tsx` | Added `manifest: '/manifest.webmanifest'`, `appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'HKM FOH Companion' }`, apple icon -> `/companion-icon-192.png`, viewport `themeColor: '#080B10'` + `viewportFit: 'cover'`. |
| `public/manifest.webmanifest` (new) | PWA manifest exactly per spec (standalone, id/start_url `/?mode=remote`, 192+512 maskable icons). |
| `public/sw.js` (new) | Minimal network-first passthrough SW (install skipWaiting, activate clients.claim, fetch passthrough, no caching — companion is always-live). |
| `public/companion-icon-512.png`, `public/companion-icon-192.png` (new) | Generated via z-ai image (dark navy + teal/sky fader bars) and resized with sharp to 512/192. |

## Protocol additions (exact shapes)

Client -> server (mobile or desktop):
```json
{ "type": "zone:patch", "zoneId": "zone-front-main", "patch": { "levelDb": -3.5, "mute": true } }
```

Server -> all clients except sender:
```json
{ "type": "zone:patch", "zoneId": "zone-front-main", "patch": { "levelDb": -3.5, "mute": true }, "sourceRole": "mobile" }
```

`state:sync` (broadcast by PUT /api/state/sync, consumed by mobiles only; desktops skipped by the WS service):
```json
{ "type": "state:sync", "channels": [...], "dsp": {...}, "venue": {...}, "emergencyMuted": false, "zones": [...] }
```
`state:full` for mobiles already includes `zones` (full store object) — verified, unchanged.

Mobile permission enforcement for `zone:patch` (mirrors channel:patch):
- `mute` stripped unless `remoteAccess.allowMuteControl`
- `levelDb`, `delayMs`, `polarityInverted`, `outputJackId` stripped unless `remoteAccess.allowMasterTrim`
- Guards: empty zoneId, empty sanitized patch, or unknown zoneId are no-ops.

## Important bug fix (pre-existing, found during verification)

`mini-services/audio-ws/index.ts` `/internal/*` handler read `body.payload` / `body.clientId`
off an un-awaited `req.json()` Promise. Consequence: `/internal/broadcast` (used by
`wsBroadcast` for `state:sync` and `remote:config`) and `/internal/kick-client` returned
`{ok:true}` without doing anything. Desktop->mobile live state sync and single-client
revocation never worked before this fix. (`kick-mobile` was unaffected — it reads no body.)
Fixed by `async fetch` + `await`. Verified end-to-end with a live two-client smoke test:
PUT /api/state/sync -> mobile receives `state:sync` including `zones` (5 zones).

## Runtime / environment notes for future agents

- The sandbox harness kills every process spawned by a Bash tool command once that command
  ends (setsid/nohup/disown do NOT survive — verified). To keep a mini-service running you
  must double-fork so it reparents to PID 1:
  `( setsid bash -c 'cd <svc> && exec bun run dev >> <log> 2>&1' < /dev/null & ) ;`
- During this task the system's dev.sh re-ran at 20:32 and left a second `bun --hot`
  audio-ws instance (EADDRINUSE zombie, .zscripts/mini-service-audio-ws.log). Both old
  instances were killed and ONE clean instance restarted via the double-fork trick.
  If you see duplicated audio-ws processes, kill all and restart the same way.
- bun --hot module re-evaluation resets the module-level `clients` Map; WS clients connected
  across a hot reload become orphaned (they must reconnect). Short-lived reconnects are fine.

## Verification

- `bun run lint` — PASS (no errors).
- `bunx tsc --noEmit` — PASS (exit 0, no errors anywhere in the project).
- Live protocol smoke tests (against the running service, all passed):
  state:full includes zones; zone:patch persists to db/hkm-state.json; mute stripped when
  allowMuteControl=false; unknown zoneId no-op; no zone:patch echo to sender; desktop
  receives zone:patch with sourceRole=mobile; PUT /api/state/sync -> mobile receives
  state:sync with zones; /internal/broadcast delivers to connected mobiles.
- `curl localhost:3000/manifest.webmanifest` — 200, served. `/sw.js` and both icons — 200.
- GET / — 200 (all frontend changes compile under the dev server).
- Store restored to pre-test values after smoke tests (zone levels, allowMuteControl).
