/**
 * HKM Audio System — desktop bundle preparer (runs after `next build`
 * via `npm run build` / `tauri.conf.json > build.beforeBuildCommand`).
 *
 * 1. Copies `.next/static` -> `.next/standalone/.next/static` and
 *    `public` -> `.next/standalone/public` using cross-platform Node fs.cpSync
 *    (replacing Unix-only `cp -r` so builds succeed natively on Windows cmd/PowerShell).
 * 2. Verifies the Next.js standalone server exists (.next/standalone/server.js).
 * 3. Makes sure src-tauri/binaries exists (bundled bun runtime target).
 * 4. Best-effort: downloads the bun windows-x64 runtime (`hkm-server.exe`) so the
 *    Windows NSIS installer is 100% self-contained. Failure is non-fatal — the
 *    desktop app falls back to a system node/bun runtime at runtime.
 *
 * Flags:
 *   --copy-only  Only copy static & public assets into .next/standalone (skip bun download)
 *   --skip-bun   Skip the bun runtime download
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE_DIR = join(ROOT, '.next', 'standalone');
const STANDALONE_SERVER = join(STANDALONE_DIR, 'server.js');
const NEXT_STATIC_SRC = join(ROOT, '.next', 'static');
const NEXT_STATIC_DEST = join(STANDALONE_DIR, '.next', 'static');
const PUBLIC_SRC = join(ROOT, 'public');
const PUBLIC_DEST = join(STANDALONE_DIR, 'public');
const BIN_DIR = join(ROOT, 'src-tauri', 'binaries');
const PLACEHOLDER = join(BIN_DIR, 'PLACEHOLDER.txt');

function fail(message) {
  console.error(`[desktop] ${message}`);
  process.exit(1);
}

function copyStandaloneAssets() {
  if (!existsSync(STANDALONE_SERVER)) {
    fail('Next.js standalone output is missing (.next/standalone/server.js). Run `next build` first.');
  }

  if (existsSync(NEXT_STATIC_SRC)) {
    mkdirSync(join(STANDALONE_DIR, '.next'), { recursive: true });
    cpSync(NEXT_STATIC_SRC, NEXT_STATIC_DEST, { recursive: true, force: true });
    console.log('[desktop] copied .next/static -> .next/standalone/.next/static');
  }

  if (existsSync(PUBLIC_SRC)) {
    cpSync(PUBLIC_SRC, PUBLIC_DEST, { recursive: true, force: true });
    console.log('[desktop] copied public -> .next/standalone/public');
  }

  // Strip accidental nested build artifacts inside .next/standalone (e.g. src-tauri/target)
  // so NSIS installer packaging stays fast and lean.
  const nestedTauri = join(STANDALONE_DIR, 'src-tauri');
  if (existsSync(nestedTauri)) {
    rmSync(nestedTauri, { recursive: true, force: true });
    console.log('[desktop] removed nested .next/standalone/src-tauri');
  }

  console.log('[desktop] standalone console server OK:', STANDALONE_SERVER);
}

function main() {
  copyStandaloneAssets();

  if (!existsSync(PLACEHOLDER)) {
    mkdirSync(BIN_DIR, { recursive: true });
    writeFileSync(
      PLACEHOLDER,
      'This folder holds hkm-server.exe (the bundled bun runtime for the console server).\n'
        + 'Run `npm run desktop:fetch-server` before `npm run desktop:build` for a fully\n'
        + 'self-contained installer. Without it, the app uses a system node/bun install.\n'
    );
  }

  if (
    process.argv.includes('--copy-only') ||
    process.argv.includes('--skip-bun') ||
    process.env.HKM_SKIP_BUN === '1'
  ) {
    if (process.argv.includes('--skip-bun') || process.env.HKM_SKIP_BUN === '1') {
      console.log('[desktop] skipping bun runtime download (--skip-bun).');
    }
    return;
  }

  const target = join(BIN_DIR, 'hkm-server.exe');
  if (existsSync(target)) {
    console.log('[desktop] bundled server runtime already present.');
    return;
  }

  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'fetch-bun-server.mjs')], {
      stdio: 'inherit',
    });
  } catch {
    console.warn(
      '[desktop] bun runtime download failed — the desktop app will require a system node/bun install.'
    );
  }
}

main();
