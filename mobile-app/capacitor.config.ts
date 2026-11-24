import type { CapacitorConfig } from '@capacitor/cli';

/**
 * HKM FOH Companion — Android shell (Capacitor 7).
 *
 * The APK bundles only the offline pairing/connect screen (www/). Once the
 * engineer links it to a desktop console on the LAN, the WebView navigates to
 * the console's companion surface (`/?mode=remote&token=…`), which carries the
 * real-time fader/mute/zone control synced over the HKM WebSocket relay.
 *
 * `androidScheme: 'http'` keeps the local app origin plain-http so navigating
 * to a LAN http:// console never trips mixed-content blocking.
 * `allowNavigation: ['*']` lets the WebView open any LAN address the engineer
 * pairs with (console IPs are not known ahead of time).
 */
const config: CapacitorConfig = {
  appId: 'org.hkmaudio.companion',
  appName: 'HKM FOH Companion',
  webDir: 'www',
  androidScheme: 'http',
  server: {
    allowNavigation: ['*'],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
