import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.join(__dirname, 'fork-sdk-overlay.js');

function hasBinary(name, args = ['--version']) {
  try {
    execFileSync(name, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeSdkTarball(version, root) {
  const pkgDir = path.join(root, 'package');
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@openchamber/sdk', version }));
  fs.writeFileSync(path.join(pkgDir, 'dist', 'manifest.js'), 'module.exports = {};');
  const tgz = path.join(root, 'sdk.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', root, 'package']);
  return tgz;
}

describe('fork-sdk-overlay', () => {
  let workDir;
  let server;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-overlay-test-'));
  });

  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    server = undefined;
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('replaces the nested SDK with the release build and verifies the version', async () => {
    if (!hasBinary('tar') || !hasBinary('openssl', ['version'])) return;
    const tgz = makeSdkTarball('9.9.9', workDir);
    const payload = fs.readFileSync(tgz);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(workDir, 'key.pem'),
      '-out', path.join(workDir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=127.0.0.1',
    ]);
    server = createServer(
      {
        key: fs.readFileSync(path.join(workDir, 'key.pem')),
        cert: fs.readFileSync(path.join(workDir, 'cert.pem')),
      },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(payload);
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const url = `https://127.0.0.1:${port}/openchamber-sdk-9.9.9.tgz`;
    const nested = path.join(workDir, 'install', 'node_modules', '@openchamber', 'sdk');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: '@openchamber/sdk', version: '0.0.0' }));
    fs.writeFileSync(path.join(nested, 'stale.txt'), 'stale');

    const result = spawnSync(process.execPath, [OVERLAY, url, nested, '9.9.9'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SDK 9.9.9 installed');
    expect(JSON.parse(fs.readFileSync(path.join(nested, 'package.json'), 'utf8')).version).toBe('9.9.9');
    expect(fs.existsSync(path.join(nested, 'stale.txt'))).toBe(false);
  });

  it('fails when the installed version does not match', async () => {
    if (!hasBinary('tar') || !hasBinary('openssl', ['version'])) return;
    const tgz = makeSdkTarball('1.2.3', workDir);
    const payload = fs.readFileSync(tgz);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(workDir, 'key.pem'),
      '-out', path.join(workDir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=127.0.0.1',
    ]);
    server = createServer(
      {
        key: fs.readFileSync(path.join(workDir, 'key.pem')),
        cert: fs.readFileSync(path.join(workDir, 'cert.pem')),
      },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(payload);
      },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const nested = path.join(workDir, 'install', 'node_modules', '@openchamber', 'sdk');
    const result = spawnSync(
      process.execPath,
      [OVERLAY, `https://127.0.0.1:${port}/openchamber-sdk-1.2.3.tgz`, nested, '9.9.9'],
      { encoding: 'utf8', env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match');
  });

  it('refuses non-https tarball URLs', () => {
    const nested = path.join(workDir, 'install', 'node_modules', '@openchamber', 'sdk');
    const result = spawnSync(process.execPath, [OVERLAY, 'http://example.invalid/sdk.tgz', nested, '9.9.9'], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('https');
  });

  it('refuses paths outside a global install layout', () => {
    const result = spawnSync(
      process.execPath,
      [OVERLAY, 'https://example.invalid/sdk.tgz', path.join(workDir, 'src', 'sdk'), '9.9.9'],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing unexpected SDK path');
  });
});
