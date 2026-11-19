import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

const hookUrl = new URL('./register-server-sources.mjs', import.meta.url).href;
const packageManagerUrl = new URL('../server/lib/package-manager.js', import.meta.url).href;

// Vitest shims CJS globals such as __dirname in its module runtime, so a
// bare __dirname in an ESM server module still passes in-process while the
// plain Node that runs the installed server and CLI throws ReferenceError.
// Execute the update-command builder in a plain Node child to pin the real
// behavior of the fork tarball update path.
test('plain Node builds the fork tarball update command without CJS globals', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'NODE_OPTIONS'),
  );
  const result = spawnSync(process.execPath, [
    '--import', hookUrl,
    '--input-type=module', '-e',
    [
      `const pm = await import(${JSON.stringify(packageManagerUrl)});`,
      `const command = pm.getUpdateCommand('npm', {`,
      `  targetVersion: '9.9.9',`,
      `  downloadUrl: 'https://example.invalid/openchamber-web-9.9.9.tgz',`,
      `  sdkDownloadUrl: 'https://example.invalid/openchamber-sdk-9.9.9.tgz',`,
      `});`,
      `if (typeof command !== 'string' || !command.includes('fork-sdk-overlay.js')) {`,
      `  throw new Error('update command misses the SDK overlay step');`,
      `}`,
      `process.stdout.write(command);`,
    ].join('\n'),
  ], { env, encoding: 'utf8', timeout: 60_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('fork-sdk-overlay.js');
}, 90_000);
