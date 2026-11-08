import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clean-global-bins.js');

const OUR_NAMES = ['openchamber', 'openchamber-guest-bundle', 'openchamber-guest-check'];

function binDirFor(prefixDir) {
  return process.platform === 'win32' ? prefixDir : path.join(prefixDir, 'bin');
}

function writeStubPm(stubDir) {
  const stubJs = path.join(stubDir, 'stub-pm.js');
  fs.writeFileSync(stubJs, [
    'const args = process.argv.slice(2);',
    "if (args[0] === '--version') { console.log('9.9.9-test'); }",
    "else if (args.join(' ') === 'prefix -g') { console.log(process.env.STUB_PREFIX); }",
    'else { process.exit(1); }',
    '',
  ].join('\n'));
  fs.writeFileSync(
    path.join(stubDir, 'npm'),
    `#!/bin/sh\nexec node ${JSON.stringify(stubJs)} "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(stubDir, 'npm.cmd'), `@node ${JSON.stringify(stubJs)} %*\r\n`);
}

function runCleanup(prefixDir, stubDir, pm = 'npm', probe) {
  const args = probe === undefined ? [scriptPath, pm] : [scriptPath, pm, probe];
  execFileSync(process.execPath, args, {
    env: {
      ...process.env,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
      STUB_PREFIX: prefixDir,
    },
    stdio: 'pipe',
    timeout: 30000,
  });
}

describe('clean-global-bins', () => {
  let prefixDir;
  let stubDir;
  let binDir;

  beforeEach(() => {
    prefixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-clean-bins-prefix-'));
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-clean-bins-pm-'));
    binDir = binDirFor(prefixDir);
    fs.mkdirSync(binDir, { recursive: true });
    writeStubPm(stubDir);
  });

  afterEach(() => {
    fs.rmSync(prefixDir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it('removes only our bin entries and always exits 0', () => {
    const removed = [];
    const keptDirs = [];
    if (process.platform === 'win32') {
      for (const name of OUR_NAMES) {
        if (name === 'openchamber-guest-check') {
          keptDirs.push(path.join(binDir, name));
          fs.mkdirSync(path.join(binDir, name));
        } else {
          removed.push(path.join(binDir, name));
          fs.writeFileSync(path.join(binDir, name), 'stale shim');
        }
        for (const entry of [`${name}.cmd`, `${name}.ps1`]) {
          removed.push(path.join(binDir, entry));
          fs.writeFileSync(path.join(binDir, entry), 'stale shim');
        }
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

    runCleanup(prefixDir, stubDir);

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
    runCleanup(prefixDir, stubDir, 'definitely-not-a-pm-xyz');
    expect(fs.readFileSync(ours, 'utf8')).toBe('stale');
  });

  it('probes through an absolute manager path that is not on PATH', () => {
    const probe = path.join(stubDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const ours = path.join(binDir, 'openchamber-guest-bundle');
    fs.writeFileSync(ours, 'stale');
    const foreignFile = path.join(binDir, 'someone-else-tool');
    fs.writeFileSync(foreignFile, 'not ours');
    runCleanup(prefixDir, stubDir, 'npm', probe);
    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.readFileSync(foreignFile, 'utf8')).toBe('not ours');
  });
});
