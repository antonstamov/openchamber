type FeedValue = string | number | boolean | null | undefined | FeedValue[] | { [key: string]: FeedValue };
type GroupKey = 'new' | 'improvements' | 'fixes' | 'sdk' | 'misc';

export type CompareVersions<Version = string> = (a: Version, b: Version) => number;

export interface ReleaseNotes {
  version: string;
  date: string;
  title: string | null;
  intro: string | null;
  groups: { key: GroupKey; bullets: string[] }[];
}

interface ParsedRelease extends Omit<ReleaseNotes, 'groups'> {
  groups: { key: GroupKey; heading: string; bullets: string[] }[];
}

export interface FetchNotesOptions {
  fetch?: (url: string, options: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<{
    ok: boolean;
    status?: number;
    json: () => Promise<FeedValue>;
  }>;
  timeoutMs?: number;
  fork?: { owner?: string; repo?: string };
}

const isFeedObject = (value: FeedValue): value is { [key: string]: FeedValue } => value !== null
  && typeof value === 'object' && !Array.isArray(value);

const CHANGELOG_API_URL = 'https://api.openchamber.dev/v1/changelog/full';
const CHANGELOG_INDEX_URL = 'https://raw.githubusercontent.com/openchamber/openchamber/main/changelog/index.json';
const CANARY_NOTES_MIRROR_URL = 'https://downloads.openchamber.dev/desktop/canary/canary-notes.json';
const CANARY_NOTES_URL = 'https://github.com/openchamber/openchamber/releases/download/canary/canary-notes.json';
const PULL_URL = 'https://github.com/openchamber/openchamber/pull/';

const GROUPS: [GroupKey, string][] = [
  ['new', 'New'],
  ['improvements', 'Improvements'],
  ['fixes', 'Fixes'],
  ['sdk', 'SDK'],
  ['misc', 'Misc'],
];

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const CANARY_VERSION_PATTERN = /^\d+\.\d+\.\d+-canary\.\d+\.\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const text = (value: FeedValue) => (value === null || value === undefined ? null : String(value).trim() || null);
const bulletList = (value: FeedValue) => (Array.isArray(value) ? value.map((item) => String(item)) : []);

const parseRelease = (entry: FeedValue): ParsedRelease | null => {
  if (!isFeedObject(entry)) return null;
  const version = text(entry.version);
  const date = text(entry.date);
  if (!version || !VERSION_PATTERN.test(version) || !date || !DATE_PATTERN.test(date)) return null;
  const app = isFeedObject(entry.app) ? entry.app : {};
  return {
    version,
    date,
    title: text(entry.title),
    intro: text(entry.intro),
    groups: GROUPS.map(([key, heading]) => ({ key, heading, bullets: bulletList(app[key]) })),
  };
};

const renderRelease = (release: ParsedRelease) => {
  const lines = [`## [${release.version}] - ${release.date}`, ''];
  if (release.title) lines.push(`**${release.title}**`, '');
  if (release.intro) lines.push(release.intro, '');
  for (const { heading, bullets } of release.groups) {
    if (bullets.length === 0) continue;
    lines.push(`### ${heading}`, '', ...bullets.map((bullet) => `- ${bullet}`), '');
  }
  return lines.join('\n').trim();
};

const AREA_NAMES = Object.fromEntries<string>([
  ['ui', 'UI'], ['sdk', 'SDK'], ['vscode', 'VS Code'], ['mcp', 'MCP'], ['ssh', 'SSH'],
  ['ios', 'iOS'], ['api', 'API'], ['cli', 'CLI'], ['pwa', 'PWA'],
]);

const areaName = (area: string) => AREA_NAMES[area] ?? `${area.charAt(0).toUpperCase()}${area.slice(1).replaceAll('-', ' ')}`;

const canaryBullet = (change: FeedValue) => {
  if (!isFeedObject(change)) return null;
  const body = text(change.text);
  if (!body) return null;
  const area = text(change.area);
  const label = area ? `**${areaName(area)}:** ` : '';
  const pr = /^\d+$/.test(String(change.pr ?? '')) ? ` [#${change.pr}](${PULL_URL}${change.pr})` : '';
  return `${label}${area ? body : `${body.charAt(0).toUpperCase()}${body.slice(1)}`}${pr}`;
};

const parseCanaryNight = (entry: FeedValue): ParsedRelease | null => {
  if (!isFeedObject(entry)) return null;
  const version = text(entry.version);
  const date = text(entry.date);
  if (!version || !CANARY_VERSION_PATTERN.test(version) || !date || !DATE_PATTERN.test(date)) return null;
  const bullets = (value: FeedValue) => (Array.isArray(value) ? value.map(canaryBullet).filter((bullet) => bullet !== null) : []);
  return {
    version,
    date,
    title: null,
    intro: null,
    groups: [
      { key: 'new', heading: 'New', bullets: bullets(entry.new) },
      { key: 'fixes', heading: 'Fixes', bullets: bullets(entry.fixes) },
    ],
  };
};

type ReleaseParser = (entry: FeedValue) => ParsedRelease | null;

const selectBetween = <Version>(entries: FeedValue[], parse: ReleaseParser, fromVersion: Version, toVersion: Version, compareVersions: CompareVersions<string | Version>) => entries
  .map(parse)
  .filter((release) => release !== null)
  .filter((release) => compareVersions(release.version, fromVersion) > 0 && compareVersions(release.version, toVersion) <= 0)
  .sort((a, b) => compareVersions(b.version, a.version));

const renderBetween = <Version>(entries: FeedValue, parse: ReleaseParser, fromVersion: Version, toVersion: Version, compareVersions: CompareVersions<string | Version>) => {
  if (!Array.isArray(entries)) return null;
  const relevant = selectBetween(entries, parse, fromVersion, toVersion, compareVersions);
  if (relevant.length === 0) return null;
  return relevant.map(renderRelease).join('\n\n');
};

export function renderUpdateNotes<Version>(index: FeedValue, fromVersion: Version, toVersion: Version, compareVersions: CompareVersions<string | Version>) {
  return renderBetween(index, parseRelease, fromVersion, toVersion, compareVersions);
}

export function renderCanaryNotes<Version>(nights: FeedValue, fromVersion: Version, toVersion: Version, compareVersions: CompareVersions<string | Version>) {
  return renderBetween(nights, parseCanaryNight, fromVersion, toVersion, compareVersions);
}

// Fork: desktop builds take updates from the fork's releases, whose notes
// the upstream changelog index does not carry. The fork release bodies
// already use the dialog's `## [x.y.z] - date` sections, so they render
// as-is: one body per release in (fromVersion, toVersion], newest first.
// Drafts and pre-releases never count.
interface ForkRelease {
  version: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
}

const parseForkRelease = (entry: FeedValue): ForkRelease | null => {
  if (!isFeedObject(entry)) return null;
  const tag = text(entry.tag_name);
  const version = tag?.startsWith('v') ? tag.slice(1) : tag;
  if (!version || !VERSION_PATTERN.test(version)) return null;
  const body = text(entry.body);
  if (!body) return null;
  return {
    version,
    body,
    draft: entry.draft === true,
    prerelease: entry.prerelease === true,
  };
};

export function renderForkReleaseNotes(releases: FeedValue, fromVersion: string, toVersion: string, compareVersions: CompareVersions) {
  if (!Array.isArray(releases)) return null;
  const relevant = releases
    .map(parseForkRelease)
    .filter((release): release is ForkRelease => release !== null && release.draft !== true && release.prerelease !== true)
    .filter((release) => compareVersions(release.version, fromVersion) > 0 && compareVersions(release.version, toVersion) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (relevant.length === 0) return null;
  return relevant.map((release) => release.body).join('\n\n');
}

export async function fetchForkReleaseNotes(fromVersion: string, toVersion: string, compareVersions: CompareVersions, options: FetchNotesOptions = {}) {
  const owner = text(options.fork?.owner);
  const repo = text(options.fork?.repo);
  if (!owner || !repo) return null;
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openchamber-update-check' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return null;
    return renderForkReleaseNotes(await response.json(), fromVersion, toVersion, compareVersions);
  } catch {
    return null;
  }
}

const fetchJson = async (url: string, options: FetchNotesOptions) => {
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    const value: FeedValue = response.ok ? await response.json() : null;
    return value;
  } catch {
    return null;
  }
};

const indexFromApiFeed = (feed: FeedValue) => {
  if (!isFeedObject(feed) || !Array.isArray(feed.entries)) return null;
  const releases = feed.entries
    .filter(isFeedObject)
    .filter((entry) => entry.groups)
    .map(({ version, date, title, intro, groups }) => ({ version, date, title, intro, app: groups }));
  return releases.length > 0 ? releases : null;
};

const asArray = (value: FeedValue) => (Array.isArray(value) ? value : null);

const fetchEntries = async (canary: boolean, options: FetchNotesOptions) => {
  const first = { ...options, timeoutMs: options.timeoutMs ?? 5_000 };
  if (canary) return asArray(await fetchJson(CANARY_NOTES_MIRROR_URL, first)) ?? asArray(await fetchJson(CANARY_NOTES_URL, options));
  return indexFromApiFeed(await fetchJson(CHANGELOG_API_URL, first)) ?? asArray(await fetchJson(CHANGELOG_INDEX_URL, options));
};

export async function fetchUpdateNotes<Version>(fromVersion: Version, toVersion: Version, compareVersions: CompareVersions<string | Version>, options: FetchNotesOptions = {}) {
  const canary = CANARY_VERSION_PATTERN.test(String(toVersion ?? ''));
  // Fork builds take updates from the fork's releases, so the fork bodies
  // are the default and the upstream index only fills gaps they leave.
  if (!canary && options.fork) {
    const forkNotes = await fetchForkReleaseNotes(fromVersion, toVersion, compareVersions, options);
    if (forkNotes) return forkNotes;
  }
  const entries = await fetchEntries(canary, options);
  if (!entries) return null;
  return (canary ? renderCanaryNotes : renderUpdateNotes)(entries, fromVersion, toVersion, compareVersions);
}

export async function fetchReleaseNotes(version: string, since: string | undefined, compareVersions: CompareVersions, options: FetchNotesOptions = {}): Promise<ReleaseNotes[] | null> {
  const canary = CANARY_VERSION_PATTERN.test(version);
  const entries = await fetchEntries(canary, options);
  if (!entries) return null;
  const parse = canary ? parseCanaryNight : parseRelease;
  const releases = since && compareVersions(version, since) > 0
    ? selectBetween(entries, parse, since, version, compareVersions)
    : entries.map(parse).filter((release): release is ParsedRelease => release !== null && release.version === version);
  return releases.map(({ version: releaseVersion, date, title, intro, groups }) => ({
    version: releaseVersion,
    date,
    title,
    intro,
    groups: groups.filter(({ bullets }) => bullets.length > 0).map(({ key, bullets }) => ({ key, bullets })),
  }));
}
