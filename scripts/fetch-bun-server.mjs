/**
 * HKM Audio System — bundled console server runtime fetcher.
 *
 * Downloads the official bun windows-x64 build and installs it as
 * src-tauri/binaries/hkm-server.exe — the self-contained runtime that runs the
 * Next.js standalone server inside the Windows desktop app. When skipped, the
 * desktop app falls back to a system `node`/`bun` install at runtime.
 *
 * Run: node scripts/fetch-bun-server.mjs [--version <bun-version>]
 */
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = join(ROOT, 'src-tauri', 'binaries');
const TARGET = join(BIN_DIR, 'hkm-server.exe');

function resolveVersion() {
  const idx = process.argv.indexOf('--version');
  if (idx > -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.BUN_VERSION || 'latest';
}

function releaseUrl(version) {
  // Always use the `bun-windows-x64-baseline` build so `hkm-server.exe` runs on
  // EVERY 64-bit Windows PC (including older Intel Xeon/Pentium/Celeron/Core i3-i7
  // and AMD FX/Athlon processors without AVX2 that crash with 0xC000001D Illegal Instruction
  // on the non-baseline AVX2 build).
  if (version === 'latest') {
    return 'https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64-baseline.zip';
  }
  const clean = version.replace(/^bun-?v?/i, '');
  return `https://github.com/oven-sh/bun/releases/download/bun-v${clean}/bun-windows-x64-baseline.zip`;
}

async function download(url, destPath) {
  console.log(`[server-runtime] downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
}

/** bsdtar (Windows 10+ / macOS / Linux) extracts zip archives without extra deps. */
function extractZip(zipPath, destDir) {
  execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
}

function findBunExe(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const found = findBunExe(full);
      if (found) return found;
    } else if (entry.toLowerCase() === 'bun.exe') {
      return full;
    }
  }
  return null;
}

async function main() {
  if (existsSync(TARGET)) {
    console.log(`[server-runtime] already present: ${TARGET}`);
    return;
  }
  mkdirSync(BIN_DIR, { recursive: true });

  const version = resolveVersion();
  const url = releaseUrl(version);
  const workDir = mkdtempSync(join(tmpdir(), 'hkm-bun-'));
  const zipPath = join(workDir, 'bun-windows-x64.zip');

  try {
    await download(url, zipPath);
    extractZip(zipPath, workDir);
    const bunExe = findBunExe(workDir);
    if (!bunExe) throw new Error('bun.exe not found inside the downloaded archive');
    cpSync(bunExe, TARGET);
    console.log(`[server-runtime] installed ${TARGET} (bun ${version})`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[server-runtime] failed: ${err.message}`);
  console.error('[server-runtime] The desktop app will fall back to a system node/bun install.');
  process.exit(1);
});
