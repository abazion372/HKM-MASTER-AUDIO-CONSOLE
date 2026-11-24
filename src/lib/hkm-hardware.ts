import fs from 'node:fs';
import dgram from 'node:dgram';
import type { DetectedHardwareEndpoint, PlatformTarget } from '../hkm/types/audio.ts';
import { recognizeAudioEndpoint } from '../hkm/utils/hardwareRecognition.ts';

export function resolveCurrentHostPlatform(): PlatformTarget {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

async function discoverLanOscMixers(): Promise<DetectedHardwareEndpoint[]> {
  const discovered: DetectedHardwareEndpoint[] = [];
  const xinfoMsg = Buffer.from([
    0x2f, 0x78, 0x69, 0x6e, 0x66, 0x6f, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00,
  ]);
  const ports = [10023, 10024]; // X32 (10023) & XR18 / MR18 (10024)

  await Promise.all(
    ports.map(
      (port) =>
        new Promise<void>((resolve) => {
          let sock: dgram.Socket;
          try {
            sock = dgram.createSocket('udp4');
          } catch {
            resolve();
            return;
          }
          const seenIps = new Set<string>();
          const finish = () => {
            try {
              sock.close();
            } catch {
              // ignore already closed socket
            }
            resolve();
          };
          const timer = setTimeout(finish, 320);

          sock.on('error', () => {
            clearTimeout(timer);
            finish();
          });

          sock.on('message', (msg, rinfo) => {
            if (seenIps.has(rinfo.address)) return;
            seenIps.add(rinfo.address);
            const ascii = msg.toString('utf8').replace(/[^\x20-\x7e]+/g, ' ').trim();
            const defaultModel =
              port === 10024 ? 'Behringer XR18 (LAN OSC)' : 'Behringer X32 (LAN OSC)';
            const label = ascii.length > 5 ? `${defaultModel} · ${ascii}` : defaultModel;
            discovered.push(
              recognizeAudioEndpoint({
                id: `lan-${rinfo.address}-${port}`,
                name: label,
                direction: 'duplex',
                source: 'lan-discovery',
                estimatedInputChannels: port === 10024 ? 18 : 32,
                estimatedOutputChannels: port === 10024 ? 18 : 16,
                hostAddress: rinfo.address,
                platform: resolveCurrentHostPlatform(),
              })
            );
          });

          try {
            sock.bind(0, () => {
              try {
                sock.setBroadcast(true);
                sock.send(xinfoMsg, 0, xinfoMsg.length, port, '255.255.255.255');
              } catch {
                clearTimeout(timer);
                finish();
              }
            });
          } catch {
            clearTimeout(timer);
            finish();
          }
        })
    )
  );

  return discovered;
}

export async function scanHostAudioHardware(): Promise<{
  hostPlatform: PlatformTarget;
  endpoints: DetectedHardwareEndpoint[];
}> {
  const hostPlatform = resolveCurrentHostPlatform();
  const endpoints: DetectedHardwareEndpoint[] = [];

  if (process.platform === 'linux') {
    try {
      const cardsPath = '/proc/asound/cards';
      if (fs.existsSync(cardsPath)) {
        const rawCards = fs.readFileSync(cardsPath, 'utf8');
        const lines = rawCards.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].match(/^\s*(\d+)\s+\[[^\]]+\]:\s+(.+)$/);
          if (!match) continue;
          const cardIdx = match[1];
          const cardHeader = match[2].trim();
          const detailLine = lines[i + 1]?.trim() || cardHeader;

          let usbIdText = '';
          const usbidPath = `/proc/asound/card${cardIdx}/usbid`;
          if (fs.existsSync(usbidPath)) {
            usbIdText = fs.readFileSync(usbidPath, 'utf8').trim();
          }

          let streamText = '';
          const streamPath = `/proc/asound/card${cardIdx}/stream0`;
          if (fs.existsSync(streamPath)) {
            streamText = fs.readFileSync(streamPath, 'utf8');
          }

          const inMatch = streamText.match(/Capture:[\s\S]*?Channels:\s*(\d+)/i);
          const outMatch = streamText.match(/Playback:[\s\S]*?Channels:\s*(\d+)/i);
          const [vid, pid] = usbIdText.includes(':') ? usbIdText.split(':') : [undefined, undefined];

          endpoints.push(
            recognizeAudioEndpoint({
              id: `alsa-card-${cardIdx}`,
              name: detailLine || cardHeader,
              direction: 'duplex',
              source: 'os-probe',
              vendorId: vid,
              productId: pid,
              estimatedInputChannels: inMatch ? Number(inMatch[1]) : undefined,
              estimatedOutputChannels: outMatch ? Number(outMatch[1]) : undefined,
              isDefault: cardIdx === '0',
              platform: hostPlatform,
            })
          );
        }
      }
    } catch {
      // ignore ALSA probe errors in headless containers
    }
  }

  const lanMixers = await discoverLanOscMixers();
  endpoints.push(...lanMixers);

  return { hostPlatform, endpoints };
}
