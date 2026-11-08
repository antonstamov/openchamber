import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getUpdateCommand } from './package-manager.js';

// The emitted cleanup step is executed for real here (no child_process mock
// in this file): npm_config_prefix points the manager at a temp prefix, so
// nothing outside it is touched. The step is always first in the command;
// temp paths never contain ' && '.
const WEB = 'https://example.invalid/openchamber-web-0.0.0.tgz';

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

describe('update cleanup step', () => {
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

  function runStep(step) {
    return spawnSync(step, { encoding: 'utf8', shell: true, timeout: 30000 });
  }

  it('removes only our bin entries and always exits 0', () => {
    const { removed, keptDirs, foreignFile } = seedBinDir(binDir, prefixDir);
    const [step] = getUpdateCommand('npm', { downloadUrl: WEB }).split(' && ');

    const result = runStep(step);

    expect(result.status).toBe(0);
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
    const command = getUpdateCommand('definitely-not-a-pm-xyz', { downloadUrl: WEB });
    if (process.platform !== 'win32') {
      expect(command).not.toContain('openchamber-guest-bundle');
      expect(fs.readFileSync(ours, 'utf8')).toBe('stale');
      return;
    }
    const [step] = command.split(' && ');
    const result = runStep(step);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(ours, 'utf8')).toBe('stale');
  });
});
