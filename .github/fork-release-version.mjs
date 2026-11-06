#!/usr/bin/env node
// Fork: push main-ru and tag a new version when one is due.
//
// Release rule (agreed): every merge that lands commits releases. The tag
// version is the package version when it is newer than the last fork
// release, otherwise one patch above the last release. A tag whose release
// already exists means there is nothing to do.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'antonstamov';
const REPO = 'openchamber';

const run = (command, options) => execSync(command, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();
const appendOutput = (name, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);

const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};
const compareVersions = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const pkgParts = parseVersion(pkg.version);
if (!pkgParts) throw new Error(`Cannot parse package version ${pkg.version}`);

const releasesJson = run(`gh release list --repo ${OWNER}/${REPO} --exclude-drafts --limit 50 --json tagName`);
const tags = JSON.parse(releasesJson || '[]')
  .map((entry) => String(entry?.tagName || '').replace(/^v/, ''))
  .map((version) => ({ version, parts: parseVersion(version) }))
  .filter((entry) => entry.parts !== null);
let last = [0, 0, 0];
for (const entry of tags) {
  if (compareVersions(entry.parts, last) > 0) last = entry.parts;
}

const target = compareVersions(pkgParts, last) > 0 ? pkgParts : [last[0], last[1], last[2] + 1];
const targetText = target.join('.');
const targetTag = `v${targetText}`;

// Quiet days and reruns: HEAD already carries the release tag and the
// release exists, so there is nothing to push or tag.
const headTags = run('git tag --points-at HEAD')
  .split('\n')
  .map((tag) => tag.trim())
  .filter(Boolean);
if (headTags.includes(targetTag)) {
  const existing = run(`gh release view ${targetTag} --repo ${OWNER}/${REPO} --json tagName 2>/dev/null || true`);
  if (existing) {
    console.log(`Release ${targetTag} already exists for HEAD, nothing to do.`);
    appendOutput('released', 'false');
    appendOutput('version', targetText);
    process.exit(0);
  }
  console.log(`Tag ${targetTag} exists on HEAD without a release, recreating it below.`);
}

run('git push origin HEAD:refs/heads/main-ru');

const remoteTag = run(`git ls-remote --tags origin refs/tags/v${targetText}`).trim();
if (remoteTag) {
  const releaseJson = run(`gh release view v${targetText} --repo ${OWNER}/${REPO} --json tagName 2>/dev/null || true`);
  if (releaseJson) {
    console.log(`Release v${targetText} already exists, nothing to tag.`);
    appendOutput('released', 'false');
    appendOutput('version', targetText);
    process.exit(0);
  }
  console.log(`Tag v${targetText} exists without a release, recreating it.`);
}

if (targetText !== pkg.version) {
  execFileSync('node', ['scripts/bump-version.mjs', targetText], { cwd: ROOT, stdio: 'inherit' });
  run('git add package.json packages/ui/package.json packages/web/package.json packages/sdk/package.json packages/electron/package.json packages/vscode/package.json bun.lock');
  run(`git commit -m "chore: bump version to ${targetText} for fork release"`);
  run('git push origin HEAD:refs/heads/main-ru');
}

run(remoteTag ? `git tag --force v${targetText}` : `git tag v${targetText}`);
run(`git push --force origin tag v${targetText}`);
console.log(`Tagged v${targetText}, the release workflow takes it from here.`);
appendOutput('released', 'true');
appendOutput('version', targetText);
