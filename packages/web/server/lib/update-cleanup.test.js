import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanStaleGlobalBins } from './package-manager.js';

// The cleanup runs in-process here for real (no child_process mock in this
// file): npm_config_prefix points the manager at a temp prefix, so nothing
// outside it is touched.
function binDirFor(prefixDir) {
  return process.platform === 'win32' ? prefixDir : path.join(prefixDir, 'bin');
}

function seedBinDir(binDir, prefixDir) {
  const removed = [];
  const keptDirs = [];
  if (process.platform === 'win32') {
    for (const name of ['openchamber', 'openchamber-guest-bundle']) {
      for (const entry of [name, `${name}.cmd`, `${name}.ps1`]) {
        const file = path.join(binDir, entry);
        fs.writeFileSync(file, 'stale shim');
        removed.push(file);
      }
    }
    keptDirs.push(path.join(binDir, 'openchamber-guest-check'));
    fs.mkdirSync(path.join(binDir, 'openchamber-guest-check'));
    for (const entry of ['openchamber-guest-check.cmd', 'openchamber-guest-check.ps1']) {
      const file = path.join(binDir, entry);
      fs.writeFileSync(file, 'stale shim');
      removed.push(file);
    }
  } else {
    const linkTarget = path.join(prefixDir, 'target.js');
    fs.writeFileSync(linkTarget, 'target');
    removed.push(path.join(binDir, 'openchamber'));
    fs.symlinkSync(linkTarget, path.join(binDir, 'openchamber'));
    removed.push(path.join(binDir, 'openchamber-guest-bundle'));
    fs.writeFileSync(path.join(binDir, 'openchamber-guest-bundle'), 'stale file');
    keptDirs.push(path.join(binDir, 'openchamber-guest-check'));
    fs.mkdirSync(path.join(binDir, 'openchamber-guest-check'));
  }
  const foreignFile = path.join(binDir, 'someone-else-tool');
  fs.writeFileSync(foreignFile, 'not ours');
  keptDirs.push(path.join(binDir, 'openchamber-data'));
  fs.mkdirSync(path.join(binDir, 'openchamber-data'));
  return { removed, keptDirs, foreignFile };
}

describe('cleanStaleGlobalBins', () => {
  let prefixDir;
  let binDir;
  let previousPrefix;

  beforeEach(() => {
    prefixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-update-cleanup-'));
    binDir = binDirFor(prefixDir);
    fs.mkdirSync(binDir, { recursive: true });
    previousPrefix = process.env.npm_config_prefix;
    process.env.npm_config_prefix = prefixDir;
  });

  afterEach(() => {
    if (previousPrefix === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = previousPrefix;
    fs.rmSync(prefixDir, { recursive: true, force: true });
  });

  // The manager itself is probed in-process, and on Windows the managers
  // are `.cmd` shims `spawnSync` cannot run without a shell, so no bin dir
  // resolves there and the cleanup is a no-op. The removal case is covered
  // on POSIX here and on every platform by the executeUpdate retry tests in
  // package-manager.test.js (mocked prefix, real filesystem).
  it.runIf(process.platform !== 'win32')('removes only our bin entries and never throws', () => {
    const { removed, keptDirs, foreignFile } = seedBinDir(binDir, prefixDir);

    expect(() => cleanStaleGlobalBins('npm')).not.toThrow();

    for (const file of removed) {
      expect(fs.existsSync(file), `${file} removed`).toBe(false);
    }
    expect(fs.readFileSync(foreignFile, 'utf8')).toBe('not ours');
    for (const dir of keptDirs) {
      expect(fs.statSync(dir).isDirectory(), `${dir} kept`).toBe(true);
    }
  });

  it('leaves everything alone when the package manager is unknown', () => {
    const ours = path.join(binDir, 'openchamber');
    fs.writeFileSync(ours, 'stale');

    expect(() => cleanStaleGlobalBins('definitely-not-a-pm-xyz')).not.toThrow();

    expect(fs.readFileSync(ours, 'utf8')).toBe('stale');
  });

  it('keeps a directory that carries one of our names', () => {
    const dir = path.join(binDir, process.platform === 'win32' ? 'openchamber-guest-check' : 'openchamber');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    expect(() => cleanStaleGlobalBins('npm')).not.toThrow();

    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});
