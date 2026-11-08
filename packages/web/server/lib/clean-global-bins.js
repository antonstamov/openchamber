#!/usr/bin/env node
// Fork: drop stale global bin entries owned by @openchamber packages before
// `npm install -g <tarballs>`.
//
// npm refuses to overwrite a global bin entry whose existing link points
// outside the package being installed (EEXIST in bin-links/_checkBins):
// the links left by a previous version keep pointing at the old layout,
// the install aborts after removing the old package, and no CLI is left.
// Removing exactly our three bin names first makes the entries missing,
// which npm treats as installable. Only our names are touched, and only
// files or symlinks: directories and everything else stay. The script never
// fails the update chain, so it always exits 0.
//
// Usage: node clean-global-bins.js [npm|pnpm|yarn|bun] [probe-command]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BIN_NAMES = ['openchamber', 'openchamber-guest-bundle', 'openchamber-guest-check'];

function runRaw(command, args, extraOptions) {
  const options = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    ...extraOptions,
  };
  if (process.platform === 'win32') options.windowsHide = true;
  try {
    const result = spawnSync(command, args, options);
    if (result.status !== 0) return null;
    const out = String(result.stdout || '').trim();
    return out || null;
  } catch {
    return null;
  }
}

// The update command runs through a shell, so `npm` resolves there, but this
// script probes the manager itself: on Windows the managers are .cmd shims,
// which CreateProcess cannot start directly, so go through cmd.exe (without
// /s, whose quote-stripping mangles quotes when spawned from Node).
// The probe defaults to the family name. The updater passes the resolved
// command, which can be an absolute path (bun from BUN_INSTALL) that is not
// on PATH, so a bare-name probe would miss it.
function isBareProbe(probe) {
  return /^[A-Za-z0-9_.-]+$/.test(probe);
}

// A probe carrying a path comes from our own update command; still refuse
// shell metacharacters, since on Windows it runs through cmd.exe.
function isPathProbe(probe) {
  return /[/\\]/.test(probe) && !/["'\n\r`$&|<>;()!]/.test(probe);
}

function runProbe(probe, args) {
  if (isBareProbe(probe)) {
    if (process.platform === 'win32') {
      return runRaw('cmd.exe', ['/d', '/c', [probe, ...args].join(' ')]);
    }
    return runRaw(probe, args);
  }
  if (!isPathProbe(probe)) return null;
  if (process.platform === 'win32') {
    // An absolute .cmd/.exe path with spaces cannot go through a hand-built
    // cmd line (quote-stripping eats it when spawned from Node), so run it
    // as one shell string: Node quotes the file for cmd itself. Single
    // string, no arg array, so the shell-escaping warning does not apply.
    const line = [`"${probe}"`, ...args.map((part) => `"${part}"`)].join(' ');
    return runRaw(line, [], { shell: true });
  }
  return runRaw(probe, args);
}

function resolveProbe(probe) {
  if (runProbe(probe, ['--version']) !== null) return probe;
  return null;
}

// Mirrors getGlobalBinDirs in package-manager.js, which owns the canonical
// layout. Kept local so the update command stays a hermetic node invocation.
function getBinDirs(family, probe) {
  const dirs = [];
  if (family === 'pnpm') {
    const bin = runProbe(probe, ['bin', '-g']);
    if (bin) dirs.push(bin);
    const prefix = runProbe(probe, ['prefix', '-g']);
    if (prefix) dirs.push(process.platform === 'win32' ? prefix : path.join(prefix, 'bin'));
  } else if (family === 'yarn') {
    const bin = runProbe(probe, ['global', 'bin']);
    if (bin) dirs.push(bin);
  } else if (family === 'bun') {
    const bin = runProbe(probe, ['pm', 'bin', '-g']);
    if (bin) dirs.push(bin);
  } else {
    const prefix = runProbe(probe, ['prefix', '-g']);
    if (prefix) dirs.push(process.platform === 'win32' ? prefix : path.join(prefix, 'bin'));
  }
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function candidatePaths(binDir) {
  const paths = [];
  for (const name of BIN_NAMES) {
    paths.push(path.join(binDir, name));
    if (process.platform === 'win32') {
      paths.push(path.join(binDir, `${name}.cmd`));
      paths.push(path.join(binDir, `${name}.ps1`));
    }
  }
  return paths;
}

function removeEntry(filePath) {
  let stat = null;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    console.log(`clean-global-bins: skipping ${filePath}: ${error?.message || error}`);
    return false;
  }
  if (!stat.isSymbolicLink() && !stat.isFile()) {
    console.log(`clean-global-bins: keeping non-file ${filePath}`);
    return false;
  }
  try {
    fs.rmSync(filePath, { force: true });
    console.log(`clean-global-bins: removed ${filePath}`);
    return true;
  } catch (error) {
    console.log(`clean-global-bins: keeping ${filePath}: ${error?.message || error}`);
    return false;
  }
}

function main() {
  const family = process.argv[2] || 'npm';
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(family)) {
    console.log(`clean-global-bins: unknown package manager ${family}, nothing to clean`);
    return;
  }
  const probe = resolveProbe(process.argv[3] || family);
  if (!probe) {
    console.log(`clean-global-bins: package manager ${family} not found, nothing to clean`);
    return;
  }
  let removed = 0;
  for (const binDir of getBinDirs(family, probe)) {
    for (const candidate of candidatePaths(binDir)) {
      if (removeEntry(candidate)) removed += 1;
    }
  }
  console.log(`clean-global-bins: done (${removed} removed)`);
}

try {
  main();
} catch (error) {
  console.log(`clean-global-bins: skipped: ${error instanceof Error ? error.message : error}`);
}
process.exit(0);
