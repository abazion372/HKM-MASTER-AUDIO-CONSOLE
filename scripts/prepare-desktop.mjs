/**
 * HKM Audio System — desktop bundle preparer (runs after `bun run build`
 * via tauri.conf.json > build.beforeBuildCommand).
 *
 * 1. Verifies the Next.js standalone server exists (.next/standalone/server.js).
 * 2. Makes sure src-tauri/binaries exists (bundled bun runtime target).
 * 3. Best-effort: downloads the bun windows-x64 runtime so the installer is
 *    self-contained. Failure is non-fatal — the desktop app falls back to a
 *    system node/bun runtime at runtime.
 *
 * Flags: --skip-bun  (skip the runtime download entirely)
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE_SERVER = join(ROOT, '.next', 'standalone', 'server.js');
const BIN_DIR = join(ROOT, 'src-tauri', 'binaries');
const PLACEHOLDER = join(BIN_DIR, 'PLACEHOLDER.txt');

function fail(message) {
  console.error(`[desktop] ${message}`);
  process.exit(1);
}

function main() {
  if (!existsSync(STANDALONE_SERVER)) {
    fail('Next.js standalone output is missing (.next/standalone/server.js). Run `bun run build` first.');
  }
  console.log('[desktop] standalone console server OK:', STANDALONE_SERVER);

  if (!existsSync(PLACEHOLDER)) {
    mkdirSync(BIN_DIR, { recursive: true });
    writeFileSync(
      PLACEHOLDER,
      'This folder holds hkm-server.exe (the bundled bun runtime for the console server).\n'
        + 'Run `bun run desktop:fetch-server` before `bun run desktop:build` for a fully\n'
        + 'self-contained installer. Without it, the app uses a system node/bun install.\n'
    );
  }

  if (process.argv.includes('--skip-bun') || process.env.HKM_SKIP_BUN === '1') {
    console.log('[desktop] skipping bun runtime download (--skip-bun).');
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
