import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import type { SettingsPageSlug } from './metadata';
import { getSettingsPageMeta } from './metadata';
import { getAvailableSettingsAnchorPages, SETTINGS_ANCHOR_PAGES, type SettingsSearchAvailabilityContext } from './search';

const STORAGE_KEY = 'openchamber.settings.newBadgeSeen.v1';

const parseSeenAnchors = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

const loadSeenAnchors = (): Set<string> => {
  try {
    return new Set(parseSeenAnchors(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return new Set();
  }
};

const saveSeenAnchors = (anchorIds: readonly string[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(anchorIds));
  } catch {
    // Ignore storage failures; the badge simply reappears next time.
  }
};

/**
 * The anchors this client already knows. A client with no baseline is seeding
 * one for the first time, so the build's own anchors are what it knows; that is
 * what keeps a fresh install free of badges.
 */
const loadOrSeedBaseline = (): Set<string> => {
  const known = loadSeenAnchors();
  if (known.size > 0) return known;
  const seeded = new Set(SETTINGS_ANCHOR_PAGES.keys());
  saveSeenAnchors([...seeded]);
  return seeded;
};

type NewSettingsBadgeState = {
  /** The anchors on the open page that still show a row badge. */
  readonly newAnchors: ReadonlySet<string>;
  readonly pendingAnchors: ReadonlySet<string>;
};

/**
 * What this client has not seen yet: the anchors the running build has that its
 * baseline lacks, whatever number of releases that spans.
 */
const buildState = (): NewSettingsBadgeState => {
  const known = loadOrSeedBaseline();

  const newAnchors = new Set<string>();
  for (const anchorId of SETTINGS_ANCHOR_PAGES.keys()) {
    if (known.has(anchorId)) continue;
    newAnchors.add(anchorId);
  }
  return { newAnchors, pendingAnchors: newAnchors };
};

/**
 * Resolved once and kept in memory: deciding what is new walks the whole search
 * table, and the answer only changes when the user acknowledges it. Reading it
 * again on every row render would repeat that walk for nothing.
 */
let state: NewSettingsBadgeState | null = null;

let badgeVersion = 0;
const badgeListeners = new Set<() => void>();

const emitNewSettingsBadgeChange = (): void => {
  badgeVersion += 1;
  for (const listener of [...badgeListeners]) {
    try {
      listener();
    } catch {
      // A throwing listener must not block the rest.
    }
  }
};

/** React subscription for row and nav badges. */
const subscribeNewSettingsBadge = (listener: () => void): (() => void) => {
  badgeListeners.add(listener);
  return () => {
    badgeListeners.delete(listener);
  };
};

const getNewSettingsBadgeVersion = (): number => badgeVersion;

const resolveState = (): NewSettingsBadgeState => {
  if (!state) state = buildState();
  return state;
};

/** Whether the control at `anchorId` still shows a row badge. Unknown anchors never do. */
export const isNewSetting = (anchorId: string): boolean => resolveState().newAnchors.has(anchorId);

/** Reactive row-badge answer for one anchor. Re-renders when the page is acknowledged. */
export const useIsNewSetting = (anchorId?: string): boolean => {
  useSyncExternalStore(subscribeNewSettingsBadge, getNewSettingsBadgeVersion, getNewSettingsBadgeVersion);
  if (!anchorId) return false;
  return isNewSetting(anchorId);
};

/** The pages whose nav item still carries the badge, in search-table order. */
export const getNewSettingPages = (ctx: SettingsSearchAvailabilityContext): SettingsPageSlug[] => {
  const pending = resolveState().pendingAnchors;
  return [...new Set([...getAvailableSettingsAnchorPages(ctx)]
    .filter(([anchorId]) => pending.has(anchorId))
    .map(([, page]) => page))];
};

/** Reactive nav-badge answer. Re-renders when a page is acknowledged. */
export const useNewSettingPages = (ctx: SettingsSearchAvailabilityContext): SettingsPageSlug[] => {
  useSyncExternalStore(subscribeNewSettingsBadge, getNewSettingsBadgeVersion, getNewSettingsBadgeVersion);
  return getNewSettingPages(ctx);
};

/**
 * The device-class flags that pick which rows a layout shows. Varying them
 * answers "could this anchor show in another layout" while the value-driven
 * state (voice settings, feature flags, server policy) stays fixed, so
 * layout-hidden anchors acknowledge with the page they belong to and
 * value-hidden ones stay pending.
 */
const BADGE_LAYOUT_KEYS = [
  'isVSCode',
  'isWeb',
  'isDesktop',
  'isMobile',
  'isDesktopLocalOrigin',
  'isMac',
  'isWindows',
  'isLinux',
] as const satisfies readonly (keyof SettingsSearchAvailabilityContext)[];

const withBadgeLayoutVariant = (ctx: SettingsSearchAvailabilityContext, variant: number): SettingsSearchAvailabilityContext => {
  const next = { ...ctx };
  BADGE_LAYOUT_KEYS.forEach((key, index) => {
    next[key] = (variant >> index & 1) === 1;
  });
  return next;
};

/**
 * Acknowledge one page: the baseline moves past that page's seen anchors,
 * and the row badges on that page clear at once. The Settings view calls it
 * when the user leaves the page or closes Settings, so the badges stay visible
 * while the page is open. Pages the user has not left keep their badge.
 *
 * A page counts as seen with every anchor its layouts show, including the
 * ones the current layout hides: the baseline is one per browser, shared by
 * every responsive layout, so clearing only the visible anchors leaves the
 * section badge lit in the layouts where the hidden anchors show. Anchors
 * hidden by values the user never turned on (a voice provider, a feature
 * flag) stay pending until actually shown. A page the device cannot show at
 * all keeps its badge.
 */
export const acknowledgeNewSettingPage = (page: SettingsPageSlug, ctx: SettingsSearchAvailabilityContext): void => {
  const current = resolveState();
  const pageAnchors = [...SETTINGS_ANCHOR_PAGES]
    .filter(([, anchorPage]) => anchorPage === page)
    .map(([anchorId]) => anchorId);
  const pendingPageAnchors = pageAnchors.filter((anchorId) => current.pendingAnchors.has(anchorId));
  if (pendingPageAnchors.length === 0) return;
  const meta = getSettingsPageMeta(page);
  if (meta?.isAvailable && !meta.isAvailable(ctx)) return;

  const availableNow = new Set(
    [...getAvailableSettingsAnchorPages(ctx)]
      .filter(([, anchorPage]) => anchorPage === page)
      .map(([anchorId]) => anchorId),
  );
  const acknowledged = new Set(availableNow);
  const remaining = new Set(pendingPageAnchors.filter((anchorId) => !acknowledged.has(anchorId)));
  for (let variant = 0; variant < (1 << BADGE_LAYOUT_KEYS.length) && remaining.size > 0; variant += 1) {
    const variantAvailable = getAvailableSettingsAnchorPages(withBadgeLayoutVariant(ctx, variant));
    for (const anchorId of remaining) {
      if (variantAvailable.has(anchorId)) {
        acknowledged.add(anchorId);
        remaining.delete(anchorId);
      }
    }
  }
  if (acknowledged.size === 0) return;

  const seen = loadOrSeedBaseline();
  const pendingAnchors = new Set(current.pendingAnchors);
  const newAnchors = new Set(current.newAnchors);
  for (const anchorId of acknowledged) {
    seen.add(anchorId);
    pendingAnchors.delete(anchorId);
    newAnchors.delete(anchorId);
  }
  saveSeenAnchors([...seen]);

  state = {
    newAnchors,
    pendingAnchors,
  };
  emitNewSettingsBadgeChange();
};

/** Drop the resolved answer so the next read rebuilds it. Tests use it after writing storage directly. */
export const resetNewSettingsBadgeCacheForTests = (): void => {
  state = null;
  emitNewSettingsBadgeChange();
};
