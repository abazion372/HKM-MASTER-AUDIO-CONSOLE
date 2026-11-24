/**
 * HKM Audio System — Unified Version & Release Manager.
 *
 * Synchronizes the release version across all 4 canonical manifests:
 *   1. package.json
 *   2. src-tauri/tauri.conf.json
 *   3. src-tauri/Cargo.toml
 *   4. src/hkm/components/AppMenuBar.tsx (APP_VERSION)
 *
 * Usage:
 *   node scripts/bump-version.mjs <version|patch|minor|major> [--tag]
 *
 * Examples:
 *   npm run release:version -- 0.3.0
 *   npm run release:version -- patch
 *   npm run release:version -- 0.3.0 --tag
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(ROOT, 'package.json');
const TAURI_CONF_PATH = join(ROOT, 'src-tauri', 'tauri.conf.json');
const CARGO_TOML_PATH = join(ROOT, 'src-tauri', 'Cargo.toml');
const MENU_BAR_PATH = join(ROOT, 'src', 'hkm', 'components', 'AppMenuBar.tsx');

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

function resolveNextVersion(current, arg) {
  if (!arg) {
    throw new Error(
      `Missing version argument (current: ${current}). Pass <x.y.z> or patch | minor | major.`
    );
  }
  const cleaned = arg.replace(/^v/i, '').trim();
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Current version '${current}' is not valid semver.`);
  let [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];

  if (cleaned === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (cleaned === 'minor') return `${major}.${minor + 1}.0`;
  if (cleaned === 'major') return `${major + 1}.0.0`;

  if (!SEMVER_RE.test(cleaned)) {
    throw new Error(`Invalid version '${arg}'. Expected x.y.z (e.g. 0.3.0) or patch/minor/major.`);
  }
  return cleaned;
}

function main() {
  const args = process.argv.slice(2);
  const shouldTag = args.includes('--tag');
  const versionArg = args.find((a) => !a.startsWith('--'));

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const nextVersion = resolveNextVersion(pkg.version, versionArg);

  // 1. package.json
  pkg.version = nextVersion;
  writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  // 2. src-tauri/tauri.conf.json
  const tauriConf = JSON.parse(readFileSync(TAURI_CONF_PATH, 'utf8'));
  tauriConf.version = nextVersion;
  writeFileSync(TAURI_CONF_PATH, `${JSON.stringify(tauriConf, null, 2)}\n`, 'utf8');

  // 3. src-tauri/Cargo.toml (update only the [package] version line)
  const cargoRaw = readFileSync(CARGO_TOML_PATH, 'utf8');
  const cargoUpdated = cargoRaw.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/,
    `$1"${nextVersion}"`
  );
  writeFileSync(CARGO_TOML_PATH, cargoUpdated, 'utf8');

  // 4. src/hkm/components/AppMenuBar.tsx
  const menuRaw = readFileSync(MENU_BAR_PATH, 'utf8');
  const menuUpdated = menuRaw.replace(
    /export const APP_VERSION = '[^']+';/,
    `export const APP_VERSION = '${nextVersion}';`
  );
  writeFileSync(MENU_BAR_PATH, menuUpdated, 'utf8');

  console.log(`[release] Synchronized version -> v${nextVersion}`);
  console.log('  - package.json');
  console.log('  - src-tauri/tauri.conf.json');
  console.log('  - src-tauri/Cargo.toml');
  console.log('  - src/hkm/components/AppMenuBar.tsx');

  if (shouldTag) {
    execFileSync(
      'git',
      [
        'add',
        'package.json',
        'src-tauri/tauri.conf.json',
        'src-tauri/Cargo.toml',
        'src/hkm/components/AppMenuBar.tsx',
      ],
      { cwd: ROOT, stdio: 'inherit' }
    );
    execFileSync('git', ['commit', '-m', `chore(release): v${nextVersion}`], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    execFileSync('git', ['tag', '-a', `v${nextVersion}`, '-m', `Release v${nextVersion}`], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    console.log(`[release] Created git commit and tag v${nextVersion}.`);
    console.log(`[release] Push with: git push && git push origin v${nextVersion}`);
  }
}

main();
