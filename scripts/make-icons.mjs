/**
 * HKM Audio System — Windows desktop icon generator.
 *
 * Renders the master SVG logo into the full Tauri icon set:
 *   src-tauri/icons/icon.png (512), 128x128.png, 128x128@2x.png (256), 32x32.png
 *   src-tauri/icons/icon.ico  — multi-image icon: BMP entries (16/32/48) + PNG entry (256)
 *
 * The ICO container is written manually (ICONDIR + ICONDIRENTRY + BITMAPINFOHEADER
 * with bottom-up BGRA pixels and zeroed AND masks), so no binary dependency is needed.
 *
 * Run: node scripts/make-icons.mjs
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'src-tauri', 'icons');
mkdirSync(ICON_DIR, { recursive: true });

const MASTER = 1024;

const MASTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER}" height="${MASTER}" viewBox="0 0 ${MASTER} ${MASTER}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#101826"/>
      <stop offset="1" stop-color="#070B12"/>
    </linearGradient>
    <linearGradient id="wave" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5EEAD4"/>
      <stop offset="1" stop-color="#10B981"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2DD4BF" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#0EA5E9" stop-opacity="0.18"/>
    </linearGradient>
  </defs>

  <!-- Console chassis: rounded dark slab with luminous edge -->
  <rect x="32" y="32" width="960" height="960" rx="176" fill="url(#bg)"/>
  <rect x="32" y="32" width="960" height="960" rx="176" fill="none" stroke="url(#edge)" stroke-width="14"/>

  <!-- Audio spectrum bars (engine meters) -->
  <g fill="url(#wave)">
    <rect x="196" y="418" width="56" height="188" rx="28" opacity="0.55"/>
    <rect x="296" y="330" width="56" height="364" rx="28" opacity="0.75"/>
    <rect x="396" y="248" width="56" height="528" rx="28"/>
    <rect x="496" y="188" width="56" height="648" rx="28"/>
    <rect x="596" y="262" width="56" height="500" rx="28" opacity="0.92"/>
    <rect x="696" y="342" width="56" height="340" rx="28" opacity="0.7"/>
    <rect x="796" y="430" width="56" height="164" rx="28" opacity="0.5"/>
  </g>

  <!-- Signal apex dot -->
  <circle cx="524" cy="152" r="26" fill="#5EEAD4"/>
  <circle cx="524" cy="152" r="44" fill="#5EEAD4" opacity="0.22"/>

  <!-- HKM monogram plate -->
  <rect x="330" y="742" width="364" height="118" rx="59" fill="#0B1220" stroke="#1E2A3C" stroke-width="6"/>
  <text x="512" y="832" font-family="DejaVu Sans, Verdana, sans-serif" font-size="86" font-weight="700"
        fill="#E2E8F0" text-anchor="middle" letter-spacing="10">HKM</text>
</svg>`;

async function renderPng(size) {
  return sharp(Buffer.from(MASTER_SVG), { density: 72 })
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

async function rawRgba(size) {
  const { data, info } = await sharp(Buffer.from(MASTER_SVG), { density: 72 })
    .resize(size, size, { kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`expected 4 channels, got ${info.channels}`);
  return data;
}

/** Builds one BMP-format ICO entry (BITMAPINFOHEADER + bottom-up BGRA + zero AND mask). */
function bmpEntryBytes(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND, doubled)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  const maskRowBytes = ((size + 31) >> 5) << 2; // 4-byte aligned
  const maskBytes = maskRowBytes * size;
  header.writeUInt32LE(size * size * 4 + maskBytes, 20); // biSizeImage

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 4;
      pixels[di] = rgba[si + 2]; // B
      pixels[di + 1] = rgba[si + 1]; // G
      pixels[di + 2] = rgba[si]; // R
      pixels[di + 3] = rgba[si + 3]; // A
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(maskBytes)]);
}

async function buildIco() {
  const bmpSizes = [16, 32, 48];
  const entries = [];
  for (const size of bmpSizes) {
    const rgba = await rawRgba(size);
    entries.push({ size, type: 0, data: bmpEntryBytes(size, rgba) });
  }
  const png256 = await renderPng(256);
  entries.push({ size: 256, type: 1, data: png256 });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((entry, i) => {
    const base = i * 16;
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base); // width
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1); // height
    dir.writeUInt8(0, base + 2); // palette colors
    dir.writeUInt8(0, base + 3); // reserved
    dir.writeUInt16LE(1, base + 4); // color planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(entry.data.length, base + 8); // bytes in resource
    dir.writeUInt32LE(offset, base + 12); // offset
    offset += entry.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

async function main() {
  const jobs = [
    ['icon.png', 512],
    ['128x128.png', 128],
    ['128x128@2x.png', 256],
    ['32x32.png', 32],
    ['icon.svg', null],
  ];
  for (const [name, size] of jobs) {
    if (size === null) {
      writeFileSync(join(ICON_DIR, name), MASTER_SVG, 'utf-8');
    } else {
      writeFileSync(join(ICON_DIR, name), await renderPng(size));
    }
    console.log(`[icons] wrote ${name}`);
  }

  // 1024px master for `tauri icon` (canonical .ico/.icns/Store set).
  writeFileSync(join(ROOT, 'app-icon.png'), await renderPng(MASTER));
  console.log('[icons] wrote app-icon.png (1024 master for `tauri icon`)');

  const ico = await buildIco();
  writeFileSync(join(ICON_DIR, 'icon.ico'), ico);
  console.log(`[icons] wrote fallback icon.ico (${ico.length} bytes, ${[16, 32, 48, 256].join('/')} px)`);

  if (!existsSync(join(ICON_DIR, 'icon.png'))) throw new Error('icon.png missing');
  console.log('[icons] done — run `bunx tauri icon app-icon.png` for the canonical Windows set.');
}

main().catch((err) => {
  console.error('[icons] failed:', err);
  process.exit(1);
});
