#!/usr/bin/env node
// Fork-only: overlay the release's SDK build over the nested published copy.
//
// `npm install -g <web-tgz>` resolves @openchamber/sdk from the public
// registry, and that published copy can lag the web sources the release was
// built from. The update command therefore runs this script right after the
// global install:
//
//   node fork-sdk-overlay.js <sdk-tgz-url> <nested-sdk-dir> <expected-version>
//
// It downloads the SDK tarball, extracts it over the nested copy with the
// system tar, and verifies the installed version. No package manager is
// involved, so npm, pnpm, yarn and bun installs are all handled the same
// way. Any failure exits non-zero so the update is reported as failed
// instead of leaving a half-updated install.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [sdkTarballUrl, nestedSdkDir, expectedVersion] = process.argv.slice(2);

const fail = (message) => {
  console.error(`fork-sdk-overlay: ${message}`);
  process.exit(1);
};

if (!sdkTarballUrl || !/^https:\/\//.test(sdkTarballUrl)) fail('expected an https SDK tarball URL');
if (!nestedSdkDir || path.isAbsolute(nestedSdkDir) === false) fail('expected an absolute nested SDK dir');
if (!expectedVersion || !/^\d+\.\d+\.\d+/.test(expectedVersion)) fail('expected an SDK version');

// Safety: only touch a global install layout (<root>/node_modules/@openchamber/sdk).
// A source checkout must never reach this script, but rm -rf deserves a second guard.
const segments = nestedSdkDir.split(path.sep).filter(Boolean);
const scopeIndex = segments.lastIndexOf('@openchamber');
if (segments[scopeIndex - 1] !== 'node_modules' || segments[scopeIndex + 1] !== 'sdk') {
  fail(`refusing unexpected SDK path: ${nestedSdkDir}`);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-sdk-overlay-'));
try {
  const tarballPath = path.join(workDir, 'sdk.tgz');
  const downloaded = await fetch(sdkTarballUrl, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'openchamber-update-check' },
    signal: AbortSignal.timeout(120000),
  });
  if (!downloaded.ok) {
    throw new Error(`download failed with HTTP ${downloaded.status}`);
  }
  fs.writeFileSync(tarballPath, Buffer.from(await downloaded.arrayBuffer()));
  execFileSync('tar', ['-xzf', tarballPath, '-C', workDir]);
  const extractedDir = path.join(workDir, 'package');
  const extractedPkg = path.join(extractedDir, 'package.json');
  if (!fs.existsSync(extractedPkg)) {
    throw new Error('tarball has no package/ directory');
  }
  fs.rmSync(nestedSdkDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(nestedSdkDir), { recursive: true });
  fs.cpSync(extractedDir, nestedSdkDir, { recursive: true });
} catch (error) {
  fail(`overlay failed: ${error instanceof Error ? error.message : error}`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

let installedVersion = null;
try {
  installedVersion = JSON.parse(fs.readFileSync(path.join(nestedSdkDir, 'package.json'), 'utf8')).version ?? null;
} catch {
  installedVersion = null;
}
if (installedVersion !== expectedVersion) {
  fail(`installed SDK version ${String(installedVersion)} does not match ${expectedVersion}`);
}

console.log(`fork-sdk-overlay: SDK ${expectedVersion} installed`);
