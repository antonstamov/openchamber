import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  detectPackageManager,
  executeUpdate,
  fetchRequiredOpenCodeVersion,
  getCurrentVersion,
  getUpdateCommand,
  quoteArg,
  readUpdateChannel,
} = await import('./package-manager.js');

/** Helper: create a fetch mock that routes by URL pattern */
function createFetchMock() {
  const handlers = new Map();

  const mock = vi.fn((url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    for (const [pattern, response] of handlers) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve(response);
      }
    }

    return Promise.reject(new Error(`Unexpected fetch call: ${urlStr}`));
  });

  mock.when = (pattern, response) => {
    handlers.set(pattern, response);
    return mock;
  };

  return mock;
}

describe('checkForUpdates', () => {
  let fetchMock;
  let originalFetch;
  let previousDataDir;

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    // No channel picked: these are the release checks, whatever the machine's own settings say.
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = path.join(os.tmpdir(), 'oc-update-check-no-settings');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  });

  // --- Fork: web installs track the fork's releases, not npm or the upstream API ---

  const forkReleaseUrl = 'api.github.com/repos/antonstamov/openchamber/releases/latest';
  const webTgz = (version) => ({
    name: `openchamber-web-${version}.tgz`,
    browser_download_url: `https://github.com/antonstamov/openchamber/releases/download/v${version}/openchamber-web-${version}.tgz`,
  });
  const sdkTgz = (version) => ({
    name: `openchamber-sdk-${version}.tgz`,
    browser_download_url: `https://github.com/antonstamov/openchamber/releases/download/v${version}/openchamber-sdk-${version}.tgz`,
  });
  const serveForkRelease = (version, { body, assets } = {}) => {
    fetchMock.when(forkReleaseUrl, {
      ok: true,
      json: async () => ({
        tag_name: `v${version}`,
        body: body ?? `## [${version}]\n\n- Fork build`,
        html_url: `https://github.com/antonstamov/openchamber/releases/tag/v${version}`,
        assets: assets ?? [webTgz(version), sdkTgz(version)],
      }),
    });
  };
  const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

  it('returns available=true with tarballs when the fork release is newer', async () => {
    serveForkRelease('1.10.0');

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result).toMatchObject({
      available: true,
      version: '1.10.0',
      currentVersion: '1.9.10',
      downloadUrl: 'https://github.com/antonstamov/openchamber/releases/download/v1.10.0/openchamber-web-1.10.0.tgz',
      sdkDownloadUrl: 'https://github.com/antonstamov/openchamber/releases/download/v1.10.0/openchamber-sdk-1.10.0.tgz',
      releaseUrl: 'https://github.com/antonstamov/openchamber/releases/tag/v1.10.0',
      updateCommand: 'openchamber update',
    });
    expect(result.body).toContain('[1.10.0]');
    // No npm registry or upstream API call: the fork release is the only source.
    expect(fetchedUrls().some((url) => url.includes('registry.npmjs.org'))).toBe(false);
    expect(fetchedUrls().some((url) => url.includes('api.openchamber.dev'))).toBe(false);
  });

  it('returns available=false when the fork release matches the installed version', async () => {
    serveForkRelease('1.9.10');

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.downloadUrl).toBeUndefined();
  });

  it('returns available=false when the fork release is older than installed', async () => {
    serveForkRelease('1.9.9');

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  it('returns available=false with an error when the fork release has no web package', async () => {
    serveForkRelease('1.10.0', { assets: [sdkTgz('1.10.0')] });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Release has no web package yet');
  });

  it('returns available=false without an error when the fork has no releases yet', async () => {
    fetchMock.when(forkReleaseUrl, { ok: false, status: 404 });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('returns available=false with an error when the fork API is unreachable', async () => {
    fetchMock.when(forkReleaseUrl, Promise.reject(new Error('Network error')));

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to determine versions');
  });

  it('accepts electron desktop update claims without npm cross-checking', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          releaseNotes: '## [1.10.0] - 2026-05-01\n\n- Great new feature',
        }),
      });

    const result = await checkForUpdates({
      appType: 'desktop-electron',
      currentVersion: '1.9.10',
      installId: '4f4dfead-9688-4c4f-97d7-4607fbbfc3ab',
      platform: 'windows',
      arch: 'arm64',
    });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      installId: '4f4dfead-9688-4c4f-97d7-4607fbbfc3ab',
      platform: 'windows',
      arch: 'arm64',
    });
  });

  it('still checks for updates in enterprise mode but reports no usage', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({ latestVersion: '1.10.0', updateAvailable: true, releaseNotes: '' }),
      });
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const result = await checkForUpdates({
        appType: 'desktop-electron',
        currentVersion: '1.9.10',
        installId: '4f4dfead-9688-4c4f-97d7-4607fbbfc3ab',
        platform: 'windows',
        arch: 'arm64',
      });
      expect(result.available).toBe(true);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.reportUsage).toBe(false);
      expect(sent.installId).toBeUndefined();
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('offers a Canary Android app the newest APK of the fork canary pre-release', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({ latestVersion: '2.5.3', updateAvailable: false }),
      })
      .when('api.github.com/repos/antonstamov/openchamber/releases/tags/canary', {
        ok: true,
        json: async () => ({
          assets: [
            { name: 'OpenChamber-2.5.4-canary.20261030.4-29857000-android.apk', browser_download_url: 'https://downloads.example/old.apk' },
            { name: 'OpenChamber-2.5.4-canary.20261031.5-29858440-android.apk', browser_download_url: 'https://downloads.example/new.apk' },
            { name: 'OpenChamber-2.5.4-canary.20261031.5-29858440-android.aab', browser_download_url: 'https://downloads.example/new.aab' },
          ],
        }),
      });

    const result = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '2.5.4-canary.20261030.4',
    });

    expect(result).toMatchObject({
      available: true,
      version: '2.5.4-canary.20261031.5',
      downloadUrl: 'https://downloads.example/new.apk',
    });

    // An APK from a release, whose releases carry no APK any more, moves to Canary.
    const fromRelease = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '2.5.3',
    });
    expect(fromRelease.available).toBe(true);
    expect(fromRelease.downloadUrl).toBe('https://downloads.example/new.apk');

    const upToDate = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '2.5.4-canary.20261031.5',
    });
    expect(upToDate.available).toBe(false);
    expect(upToDate.downloadUrl).toBeUndefined();
  });

  it('offers the Canary APK from the R2 mirror once the mirror has it', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({ latestVersion: '2.5.3', updateAvailable: false }),
      })
      .when('api.github.com/repos/antonstamov/openchamber/releases/tags/canary', {
        ok: true,
        json: async () => ({
          assets: [{ name: 'OpenChamber-2.5.4-canary.20261031.5-29858440-android.apk', browser_download_url: 'https://downloads.example/new.apk' }],
        }),
      })
      .when('downloads.openchamber.dev/desktop/canary/OpenChamber-2.5.4-canary.20261031.5-29858440-android.apk', { ok: true });

    const result = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '2.5.4-canary.20261030.4',
    });
    expect(result.downloadUrl).toBe('https://downloads.openchamber.dev/desktop/canary/OpenChamber-2.5.4-canary.20261031.5-29858440-android.apk');
  });

  it('reports an unreadable fork canary pre-release as an error for a Canary Android app', async () => {
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({ latestVersion: '2.5.3', updateAvailable: false }),
      })
      .when('api.github.com/repos/antonstamov/openchamber/releases/tags/canary', { ok: false, status: 503 });

    const result = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '2.5.4-canary.20261030.4',
    });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to determine versions');
  });

  // --- Fork: the upstream API and npm are not consulted for web installs ---

  it('ignores the upstream API and follows only the fork release', async () => {
    fetchMock.when('api.openchamber.dev', {
      ok: true,
      json: async () => ({
        latestVersion: '9.9.9',
        updateAvailable: true,
        releaseNotes: 'Upstream only',
      }),
    });
    serveForkRelease('1.9.10');

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(fetchedUrls().some((url) => url.includes('api.openchamber.dev'))).toBe(false);
    expect(fetchedUrls().some((url) => url.includes('registry.npmjs.org'))).toBe(false);
  });
});

describe('checkForUpdates on the update channels', () => {
  let fetchMock;
  let originalFetch;
  let dataDir;
  let previousDataDir;

  const pickChannel = (channel) => {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ serverUpdateChannel: channel }));
  };
  const serveForkRelease = (version) => {
    fetchMock.when('api.github.com/repos/antonstamov/openchamber/releases/latest', {
      ok: true,
      json: async () => ({
        tag_name: `v${version}`,
        body: `## [${version}]`,
        html_url: `https://github.com/antonstamov/openchamber/releases/tag/v${version}`,
        assets: [
          { name: `openchamber-web-${version}.tgz`, browser_download_url: `https://example.invalid/web-${version}.tgz` },
          { name: `openchamber-sdk-${version}.tgz`, browser_download_url: `https://example.invalid/sdk-${version}.tgz` },
        ],
      }),
    });
  };

  it('offers nothing on the Canary channel: the fork publishes no canary builds', async () => {
    pickChannel('canary');
    serveForkRelease('2.5.3');

    const result = await checkForUpdates({ currentVersion: '2.5.3' });

    expect(result.available).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('is up to date on Canary before the first Canary is published', async () => {
    pickChannel('canary');

    const result = await checkForUpdates({ currentVersion: '2.5.3' });

    expect(result.available).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('offers the older release on Stable from a Canary build', async () => {
    pickChannel('stable');
    serveForkRelease('2.5.3');

    const result = await checkForUpdates({ currentVersion: '2.5.4-canary.20261031.7' });

    expect(result).toMatchObject({ available: true, version: '2.5.3' });
  });

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-update-channel-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps a Canary build installed from the terminal on Canary until a channel is picked', async () => {
    expect(readUpdateChannel('2.5.4-canary.20261031.7')).toBe('canary');
    expect(readUpdateChannel('2.5.3')).toBe('stable');
    expect((await checkForUpdates({ currentVersion: '2.5.4-canary.20261031.7' })).available).toBe(false);
  });

  it('leaves the desktop app, VS Code and phones on releases', async () => {
    pickChannel('canary');
    fetchMock.when('api.openchamber.dev', {
      ok: true,
      json: async () => ({ latestVersion: '2.5.3', updateAvailable: false }),
    });

    const result = await checkForUpdates({ currentVersion: '2.5.3', appType: 'vscode' });

    expect(result.version).toBe('2.5.3');
    expect(result.available).toBe(false);
  });
});

describe('getCurrentVersion', () => {
  it('is exported for the CLI update command', () => {
    expect(typeof getCurrentVersion).toBe('function');
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
  });
});

describe('fetchRequiredOpenCodeVersion', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads the oldest OpenCode from engines.opencode of the published release', async () => {
    const cases = [
      [{ opencode: '>=2.3.0' }, '2.3.0'],
      [{ node: '>=24.14.0' }, null],
      [{ opencode: '^2.3.0' }, null],
    ];
    for (const [engines, expected] of cases) {
      globalThis.fetch = createFetchMock().when('@openchamber%2Fweb/2.7.1', { ok: true, json: async () => ({ version: '2.7.1', engines }) });
      expect(await fetchRequiredOpenCodeVersion('2.7.1')).toBe(expected);
    }
    globalThis.fetch = createFetchMock().when('@openchamber%2Fweb/2.7.1', { ok: false, status: 404 });
    expect(await fetchRequiredOpenCodeVersion('2.7.1')).toBeNull();
  });
});

describe('getUpdateCommand', () => {
  it('pins the exact target version instead of re-resolving the latest dist-tag', () => {
    expect(getUpdateCommand('npm', { targetVersion: '1.24.1' })).toBe('npm install -g @openchamber/web@1.24.1');
    expect(getUpdateCommand('pnpm', { targetVersion: 'v1.24.1' })).toBe('pnpm add -g @openchamber/web@1.24.1');
    expect(getUpdateCommand('yarn', { targetVersion: '1.24.1' })).toBe('yarn global add @openchamber/web@1.24.1');
    expect(getUpdateCommand('bun', { targetVersion: '1.25.0-beta.1' })).toContain('add -g @openchamber/web@1.25.0-beta.1');
  });

  describe('pnpm build approvals', () => {
    function stubPnpmVersion(stdout, status = 0) {
      spawnSync.mockImplementation((command, args) => (
        Array.isArray(args) && args[0] === '--version'
          ? { status, stdout, stderr: '' }
          : { status: 0, stdout: '', stderr: '' }
      ));
    }

    afterEach(() => {
      spawnSync.mockReset();
    });

    it('pre-approves the dependency builds on pnpm 10.4 and newer', () => {
      for (const version of ['10.4.0', '10.34.6', '11.28.2', '12.11.2']) {
        stubPnpmVersion(`${version}\n`);
        expect(getUpdateCommand('pnpm', { targetVersion: '1.24.1' })).toBe(
          'pnpm add -g --allow-build=msgpackr-extract --allow-build=node-pty @openchamber/web@1.24.1',
        );
      }
    });

    it('leaves the flag out where pnpm rejects it or the version is unknown', () => {
      for (const version of ['9.15.9', '10.3.0', '']) {
        stubPnpmVersion(`${version}\n`);
        expect(getUpdateCommand('pnpm', { targetVersion: '1.24.1' })).toBe('pnpm add -g @openchamber/web@1.24.1');
      }
      stubPnpmVersion('', 1);
      expect(getUpdateCommand('pnpm', { targetVersion: '1.24.1' })).toBe('pnpm add -g @openchamber/web@1.24.1');
    });
  });

  it('falls back to the latest dist-tag when no target version is given', () => {
    expect(getUpdateCommand('npm')).toBe('npm install -g @openchamber/web@latest');
  });

  it('installs the release tarballs and overlays the SDK when download URLs are given', () => {
    const web = 'https://github.com/antonstamov/openchamber/releases/download/v1.10.0/openchamber-web-1.10.0.tgz';
    const sdk = 'https://github.com/antonstamov/openchamber/releases/download/v1.10.0/openchamber-sdk-1.10.0.tgz';
    const command = getUpdateCommand('npm', { targetVersion: '1.10.0', downloadUrl: web, sdkDownloadUrl: sdk });
    const overlay = `node ${quoteArg(joinOverlayPath())} ${quoteArg(sdk)} ${quoteArg(joinNestedSdkDir())} ${quoteArg('1.10.0')}`;
    expect(command).toBe(`npm install -g --allow-remote=root ${quoteArg(sdk)} ${quoteArg(web)} && ${overlay}`);
    expect(command).not.toContain('@openchamber/web@');
  });

  it('emits a plain install with no embedded cleanup step', () => {
    const web = 'https://example.invalid/openchamber-web-1.10.0.tgz';
    const sdk = 'https://example.invalid/openchamber-sdk-1.10.0.tgz';
    // Stale bin entries are dropped in-process by the caller, never as an
    // `rm` or `node -e` step inside the command string.
    for (const options of [
      { targetVersion: '1.10.0', downloadUrl: web, sdkDownloadUrl: sdk },
      { targetVersion: '1.10.0', downloadUrl: web, sdkDownloadUrl: sdk, cleanStaleBins: false },
      { targetVersion: '1.10.0', downloadUrl: web },
    ]) {
      const command = getUpdateCommand('npm', options);
      expect(command).not.toContain('rm -f');
      expect(command).not.toContain('node -e');
      expect(command).not.toContain('openchamber-guest-bundle');
    }
  });

  it('quotes the tarball install per platform', () => {
    const web = 'https://example.invalid/a b.tgz';
    expect(getUpdateCommand('npm', { targetVersion: '1.10.0', downloadUrl: web, platform: 'linux' }))
      .toContain(`install -g --allow-remote=root ${quoteArg(web, 'linux')}`);
    expect(getUpdateCommand('npm', { targetVersion: '1.10.0', downloadUrl: web, platform: 'win32' }))
      .toContain(`install -g --allow-remote=root ${quoteArg(web, 'win32')}`);
    expect(quoteArg(web, 'linux')).toBe(`'https://example.invalid/a b.tgz'`);
    expect(quoteArg(web, 'win32')).toBe(`"https://example.invalid/a b.tgz"`);
  });

  it('quotes shell arguments per platform', () => {
    expect(quoteArg('plain')).toBe('"plain"');
    expect(quoteArg('C:\\Program Files\\app\\x.js', 'win32')).toBe('"C:\\Program Files\\app\\x.js"');
    expect(quoteArg('a"b', 'win32')).toBe('"a""b"');
    expect(quoteArg("a'b", 'linux')).toBe(`'a'\\''b'`);
    expect(quoteArg('a b', 'darwin')).toBe(`'a b'`);
  });

  function joinOverlayPath() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), 'fork-sdk-overlay.js');
  }

  function joinNestedSdkDir() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '@openchamber', 'sdk');
  }

  it('installs the release tarball per package manager', () => {
    const web = 'https://example.invalid/openchamber-web-1.10.0.tgz';
    for (const [pm, install] of [
      ['npm', `npm install -g --allow-remote=root ${quoteArg(web)}`],
      ['yarn', `yarn global add ${quoteArg(web)}`],
      ['bun', `add -g ${quoteArg(web)}`],
      ['pnpm', `add -g ${quoteArg(web)}`],
    ]) {
      const command = getUpdateCommand(pm, { targetVersion: '1.10.0', downloadUrl: web });
      expect(command).not.toContain('openchamber-guest-bundle');
      expect(command).toContain(install);
    }
  });

  it('installs only the web tarball when the release has no SDK asset', () => {
    const web = 'https://github.com/antonstamov/openchamber/releases/download/v1.10.0/openchamber-web-1.10.0.tgz';
    const command = getUpdateCommand('npm', { targetVersion: '1.10.0', downloadUrl: web });
    expect(command).not.toContain('openchamber-guest-bundle');
    expect(command).toContain(`npm install -g --allow-remote=root ${quoteArg(web)}`);
  });

  it('rejects a target version that is not a concrete version', () => {
    expect(() => getUpdateCommand('npm', { targetVersion: 'latest; rm -rf /' })).toThrow(/Invalid target version/);
  });
});

describe('executeUpdate', () => {
  let globalPrefix;
  let shellRuns;

  const globalRootDir = () => process.platform === 'win32'
    ? path.join(globalPrefix, 'node_modules')
    : path.join(globalPrefix, 'lib', 'node_modules');
  const cliPath = () => path.join(globalRootDir(), '@openchamber', 'web', 'bin', 'cli.js');
  const placeCli = () => {
    fs.mkdirSync(path.dirname(cliPath()), { recursive: true });
    fs.writeFileSync(cliPath(), '#!/usr/bin/env node\n');
  };
  const binDir = () => (process.platform === 'win32' ? globalPrefix : path.join(globalPrefix, 'bin'));
  const seedStaleBin = (name = 'openchamber-guest-bundle') => {
    fs.mkdirSync(binDir(), { recursive: true });
    const file = path.join(binDir(), name);
    fs.writeFileSync(file, 'stale bin entry');
    return file;
  };

  function stubSpawnSync({ installStatuses = [0], listingStdout = '', listingStatus = 0, onShellRun, noRoots = false } = {}) {
    shellRuns = [];
    spawnSync.mockImplementation((command, args) => {
      if (!Array.isArray(args)) {
        shellRuns.push(command);
        onShellRun?.(shellRuns.length);
        const status = installStatuses[Math.min(shellRuns.length - 1, installStatuses.length - 1)];
        return { status, stdout: '', stderr: '' };
      }
      if (args.includes('--version')) {
        return { status: 0, stdout: '10.0.0', stderr: '' };
      }
      if (args[0] === 'root') {
        return noRoots ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `${globalRootDir()}\n`, stderr: '' };
      }
      if (args[0] === 'prefix') {
        return noRoots ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `${globalPrefix}\n`, stderr: '' };
      }
      if (args[0] === 'list' || args[0] === 'pm' || args[0] === 'global') {
        return { status: listingStatus, stdout: listingStdout, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
  }

  beforeEach(() => {
    globalPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-update-global-'));
    shellRuns = [];
  });

  afterEach(() => {
    spawnSync.mockReset();
    fs.rmSync(globalPrefix, { recursive: true, force: true });
  });

  it('reports success when the installed version matches the target', () => {
    placeCli();
    stubSpawnSync({ listingStdout: '└── @openchamber/web@1.24.1' });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(true);
    expect(result.installedVersion).toBe('1.24.1');
    expect(shellRuns).toHaveLength(1);
  });

  it('retries once when the CLI entry point is missing after a failed install', () => {
    const staleBin = seedStaleBin();
    const foreignFile = path.join(binDir(), 'someone-else-tool');
    fs.writeFileSync(foreignFile, 'not ours');
    const ourDir = path.join(binDir(), 'openchamber');
    fs.mkdirSync(ourDir, { recursive: true });
    stubSpawnSync({ installStatuses: [1, 1] });
    const update = {
      targetVersion: '1.24.1',
      downloadUrl: 'https://example.invalid/openchamber-web-1.24.1.tgz',
      sdkDownloadUrl: 'https://example.invalid/openchamber-sdk-1.24.1.tgz',
    };
    const result = executeUpdate('npm', update);
    expect(result.success).toBe(false);
    expect(result.error).toContain('exited with code 1');
    expect(result.error).toContain('still missing after one retry');
    expect(shellRuns).toHaveLength(2);
    // The retry runs the same plain install: the cleanup happens in-process
    // between the runs, not as a step inside the command.
    expect(shellRuns[1]).toBe(shellRuns[0]);
    expect(shellRuns[0]).not.toContain('openchamber-guest-bundle');
    expect(fs.existsSync(staleBin)).toBe(false);
    expect(fs.readFileSync(foreignFile, 'utf8')).toBe('not ours');
    expect(fs.statSync(ourDir).isDirectory()).toBe(true);
  });

  it('leaves the bins alone when the first install is healthy', () => {
    placeCli();
    const staleBin = seedStaleBin();
    stubSpawnSync({ listingStdout: '└── @openchamber/web@1.24.1' });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(true);
    expect(shellRuns).toHaveLength(1);
    expect(fs.existsSync(staleBin)).toBe(true);
  });

  it('retries the plain command on the registry branch', () => {
    stubSpawnSync({ installStatuses: [1, 1] });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('exited with code 1');
    expect(shellRuns).toHaveLength(2);
    expect(shellRuns[0]).toBe('npm install -g @openchamber/web@1.24.1');
    expect(shellRuns[1]).toBe(shellRuns[0]);
  });

  it('does not retry a failed install that left the CLI in place', () => {
    placeCli();
    stubSpawnSync({ installStatuses: [1] });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('exited with code 1');
    expect(shellRuns).toHaveLength(1);
  });

  it('recovers when the retry brings the CLI back', () => {
    const staleBin = seedStaleBin();
    stubSpawnSync({
      listingStdout: '└── @openchamber/web@1.24.1',
      onShellRun: (run) => {
        if (run === 2) placeCli();
      },
    });
    const update = {
      targetVersion: '1.24.1',
      downloadUrl: 'https://example.invalid/openchamber-web-1.24.1.tgz',
      sdkDownloadUrl: 'https://example.invalid/openchamber-sdk-1.24.1.tgz',
    };
    const result = executeUpdate('npm', update);
    expect(result.success).toBe(true);
    expect(result.installedVersion).toBe('1.24.1');
    expect(shellRuns).toHaveLength(2);
    expect(shellRuns[1]).toBe(shellRuns[0]);
    expect(shellRuns[0]).not.toContain('openchamber-guest-bundle');
    expect(fs.existsSync(staleBin)).toBe(false);
  });

  it('fails instead of reporting success when the CLI is still missing after the retry', () => {
    stubSpawnSync({ listingStdout: '└── @openchamber/web@1.24.1' });
    const update = {
      targetVersion: '1.24.1',
      downloadUrl: 'https://example.invalid/openchamber-web-1.24.1.tgz',
      sdkDownloadUrl: 'https://example.invalid/openchamber-sdk-1.24.1.tgz',
    };
    const result = executeUpdate('npm', update);
    expect(result.success).toBe(false);
    expect(result.error).toContain('still missing after one retry');
    expect(shellRuns).toHaveLength(2);
    expect(shellRuns[1]).toBe(shellRuns[0]);
    expect(shellRuns[0]).not.toContain('openchamber-guest-bundle');
  });

  it('fails when the package manager exits successfully but installed the wrong version', () => {
    placeCli();
    stubSpawnSync({ listingStdout: '└── @openchamber/web@1.19.0' });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('1.19.0');
    expect(result.error).toContain('1.24.1');
  });

  it('fails loudly when the installed version cannot be verified', () => {
    placeCli();
    stubSpawnSync({ listingStdout: '', listingStatus: 1 });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not determine');
  });

  it('keeps the previous behavior when no target version is given', () => {
    placeCli();
    stubSpawnSync();
    const result = executeUpdate('npm');
    expect(result.success).toBe(true);
    expect(result.installedVersion).toBeNull();
  });

  it('skips the CLI verification when the global root does not resolve', () => {
    stubSpawnSync({ noRoots: true, listingStdout: '└── @openchamber/web@1.24.1' });
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(true);
    expect(result.installedVersion).toBe('1.24.1');
    expect(shellRuns).toHaveLength(1);
  });

  it('passes release tarball URLs through to the install command', () => {
    placeCli();
    const web = 'https://example.invalid/openchamber-web-1.24.1.tgz';
    const sdk = 'https://example.invalid/openchamber-sdk-1.24.1.tgz';
    stubSpawnSync({ listingStdout: '└── @openchamber/web@1.24.1' });
    const result = executeUpdate('npm', { targetVersion: '1.24.1', downloadUrl: web, sdkDownloadUrl: sdk });
    expect(result.success).toBe(true);
    expect(shellRuns).toHaveLength(1);
    // A healthy install runs the plain command once: the in-process cleanup
    // runs only before a retry over a broken install.
    expect(shellRuns[0]).not.toContain('openchamber-guest-bundle');
    expect(shellRuns[0]).toContain(`npm install -g --allow-remote=root ${quoteArg(sdk)} ${quoteArg(web)}`);
    expect(shellRuns[0]).toContain('fork-sdk-overlay.js');
    expect(shellRuns[0]).toContain(sdk);
  });
});

describe('detectPackageManagerDetails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSync.mockReset();
    vi.unstubAllEnvs();
  });

  it.each([
    ['Windows pnpm store', String.raw`D:\pnpm-store\v11\links\@openchamber\web\2.5.1\hash\node_modules\@openchamber\web`, 'pnpm'],
    ['POSIX pnpm store', '/home/user/.local/share/pnpm-store/v11/links/@openchamber/web/2.5.1/hash/node_modules/@openchamber/web', 'pnpm'],
    ['case-insensitive Windows pnpm store', String.raw`D:\PNPM-STORE\v11\links\@openchamber\web\2.5.1\hash\node_modules\@openchamber\web`, 'pnpm'],
    ['pnpm virtual store', '/opt/global/node_modules/.pnpm/@openchamber+web@2.5.1/node_modules/@openchamber/web', 'pnpm'],
    ['npm install', '/usr/local/lib/node_modules/@openchamber/web', 'npm'],
    ['unrelated store name', '/opt/pnpm-store-backup/node_modules/@openchamber/web', 'npm'],
  ])('uses the install path for %s when global roots cannot establish ownership', async (_name, packagePath, packageManager) => {
    vi.stubEnv('OPENCHAMBER_RUNTIME', '');
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', '');
    vi.stubEnv('npm_config_user_agent', '');
    vi.stubEnv('npm_execpath', '');
    spawnSync.mockImplementation((command, args) => {
      if (command !== 'npm' && command !== 'pnpm') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (args[0] === '--version') {
        return { status: 0, stdout: '10.0.0', stderr: '' };
      }
      if (args[0] === 'list') {
        return { status: 0, stdout: '@openchamber/web 2.5.1', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    vi.resetModules();
    const { detectPackageManagerDetails, getUpdateCommand } = await import('./package-manager.js');
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const resolve = path.resolve;
    vi.spyOn(path, 'resolve').mockImplementation((...parts) => (
      parts.length === 3 && parts[0] === moduleDir && parts[1] === '..' && parts[2] === '..'
        ? packagePath
        : resolve(...parts)
    ));

    expect(detectPackageManagerDetails()).toMatchObject({
      packageManager,
      packagePath,
      reason: 'hinted-visible-install',
      globalNodeModulesRoot: null,
    });
    expect(getUpdateCommand()).toBe(packageManager === 'pnpm'
      ? 'pnpm add -g @openchamber/web@latest'
      : 'npm install -g @openchamber/web@latest');
  });

  it('keeps reporting a copy no package manager installed after the first detection', async () => {
    vi.stubEnv('OPENCHAMBER_RUNTIME', '');
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', '');
    // No package manager answers, as on a server where an unpacked tarball runs.
    spawnSync.mockImplementation(() => ({ status: 1, stdout: '', stderr: '' }));
    vi.resetModules();
    const { detectPackageManagerDetails, isUnmanagedInstall } = await import('./package-manager.js');

    expect(detectPackageManagerDetails().reason).toBe('unmanaged-install');
    expect(detectPackageManagerDetails().reason).toBe('unmanaged-install');
    expect(isUnmanagedInstall()).toBe(true);
  });
});

describe('CLI update exports', () => {
  it('exports package-manager helpers used by the update command', () => {
    expect(typeof detectPackageManager).toBe('function');
    expect(typeof executeUpdate).toBe('function');
  });
});
