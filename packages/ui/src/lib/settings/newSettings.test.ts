import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  acknowledgeNewSettingPage as acknowledgePage,
  getNewSettingPages as getPages,
  isNewSetting,
  resetNewSettingsBadgeCacheForTests,
} from './newSettings';
import { SETTINGS_ANCHOR_PAGES, type SettingsSearchAvailabilityContext } from './search';

const runtimeCtx: SettingsSearchAvailabilityContext = {
  isVSCode: false, isWeb: true, isDesktop: false, isMobile: false,
  isDesktopLocalOrigin: false, isMac: false, isWindows: false, isLinux: false,
  routingAvailable: false, enterpriseMode: false, jevBlockedByEnterprise: false,
};
const getNewSettingPages = () => getPages(runtimeCtx);
const acknowledgeNewSettingPage = (page: Parameters<typeof acknowledgePage>[0]) => acknowledgePage(page, runtimeCtx);

const STORAGE_KEY = 'openchamber.settings.newBadgeSeen.v1';

const previousLocalStorage = globalThis.localStorage;

const installTestLocalStorage = (): void => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
    configurable: true,
    writable: true,
  });
};

/** Every anchor the build has, minus the ones a test wants to look new. */
const baselineWithout = (...anchorIds: string[]): string[] =>
  [...SETTINGS_ANCHOR_PAGES.keys()].filter((anchorId) => !anchorIds.includes(anchorId));

const storedBaseline = (): string[] => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');

const startFromBaseline = (anchorIds: string[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(anchorIds));
  resetNewSettingsBadgeCacheForTests();
};

beforeAll(installTestLocalStorage);
beforeEach(() => {
  localStorage.clear();
  resetNewSettingsBadgeCacheForTests();
});
afterAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: previousLocalStorage,
    configurable: true,
    writable: true,
  });
});

describe('new settings badge', () => {
  test('leaving a page marks even its hidden controls seen', () => {
    startFromBaseline(baselineWithout('appearance.dock-badge', 'appearance.language'));
    expect(getPages(runtimeCtx)).toEqual(['appearance']);
    acknowledgePage('appearance', runtimeCtx);
    expect(getPages(runtimeCtx)).toEqual([]);
    expect(storedBaseline()).toContain('appearance.language');
    expect(storedBaseline()).toContain('appearance.dock-badge');

    // The page was seen, so no layout re-announces it.
    const macCtx = { ...runtimeCtx, isDesktop: true, isWeb: false, isMac: true };
    expect(getPages(macCtx)).toEqual([]);
    acknowledgePage('appearance', macCtx);
    expect(getPages(macCtx)).toEqual([]);
    resetNewSettingsBadgeCacheForTests();
    expect(getPages(macCtx)).toEqual([]);
  });

  test('leaving a badgeless page still marks its hidden controls seen', () => {
    startFromBaseline(baselineWithout('appearance.dock-badge'));
    expect(getPages(runtimeCtx)).toEqual([]);
    acknowledgePage('appearance', runtimeCtx);
    expect(storedBaseline()).toContain('appearance.dock-badge');
    resetNewSettingsBadgeCacheForTests();
    expect(getPages({ ...runtimeCtx, isDesktop: true, isMac: true })).toEqual([]);
  });

  test('VS Code cannot announce or acknowledge controls from an unavailable page', () => {
    startFromBaseline(baselineWithout('voice.playback'));
    const vscodeCtx = { ...runtimeCtx, isVSCode: true, isWeb: false };
    expect(getPages(vscodeCtx)).toEqual([]);
    acknowledgePage('voice', vscodeCtx);
    expect(storedBaseline()).not.toContain('voice.playback');
    expect(getPages(runtimeCtx)).toEqual(['voice']);
  });

  test('a fresh install seeds the baseline and announces nothing', () => {
    expect(getNewSettingPages()).toEqual([]);
    expect(isNewSetting('voice.playback')).toBe(false);
    expect(storedBaseline()).toHaveLength(SETTINGS_ANCHOR_PAGES.size);
  });

  test('every anchor a later build added is new, on its own page', () => {
    startFromBaseline(baselineWithout('voice.playback'));

    expect(isNewSetting('voice.playback')).toBe(true);
    expect(getNewSettingPages()).toEqual(['voice']);
  });

  test('several releases of added controls are all new at once', () => {
    startFromBaseline(baselineWithout('voice.playback', 'chat.activity-default'));

    expect(getNewSettingPages().sort()).toEqual(['chat', 'voice']);
  });

  test('opening a page acknowledges only that page', () => {
    startFromBaseline(baselineWithout('voice.playback', 'chat.activity-default'));

    acknowledgeNewSettingPage('chat');

    expect(getNewSettingPages()).toEqual(['voice']);
    expect(storedBaseline()).toContain('chat.activity-default');
    expect(storedBaseline()).not.toContain('voice.playback');

    resetNewSettingsBadgeCacheForTests();
    expect(getNewSettingPages()).toEqual(['voice']);
    expect(isNewSetting('voice.playback')).toBe(true);
  });

  test('leaving a page clears its row badges at once', () => {
    startFromBaseline(baselineWithout('voice.playback'));

    expect(isNewSetting('voice.playback')).toBe(true);

    acknowledgeNewSettingPage('voice');

    expect(getNewSettingPages()).toEqual([]);
    expect(isNewSetting('voice.playback')).toBe(false);

    resetNewSettingsBadgeCacheForTests();
    expect(isNewSetting('voice.playback')).toBe(false);
  });

  test('leaving a page on desktop clears its section badge on mobile too', () => {
    const desktopCtx = { ...runtimeCtx, isDesktop: true, isWeb: false };
    const mobileCtx = { ...runtimeCtx, isMobile: true };
    startFromBaseline(baselineWithout('appearance.interface-font-size', 'appearance.mobile-keyboard-mode'));

    // While the page is open, its badge stays: opening never acknowledges.
    expect(getPages(desktopCtx)).toEqual(['appearance']);
    expect(isNewSetting('appearance.interface-font-size')).toBe(true);

    // The mobile-only row was never visible on desktop, but the page was
    // seen, so its section badge must not survive on mobile.
    acknowledgePage('appearance', desktopCtx);
    expect(isNewSetting('appearance.interface-font-size')).toBe(false);
    expect(getPages(desktopCtx)).toEqual([]);
    expect(getPages(mobileCtx)).toEqual([]);
  });

  test('leaving a page on mobile clears its section badge on desktop too', () => {
    const desktopCtx = { ...runtimeCtx, isDesktop: true, isWeb: false };
    const mobileCtx = { ...runtimeCtx, isMobile: true };
    startFromBaseline(baselineWithout('appearance.interface-font-size', 'appearance.mobile-keyboard-mode'));

    expect(getPages(mobileCtx)).toEqual(['appearance']);

    acknowledgePage('appearance', mobileCtx);
    expect(getPages(mobileCtx)).toEqual([]);
    expect(getPages(desktopCtx)).toEqual([]);
  });

  test('leaving a page keeps value-hidden controls pending until shown', () => {
    const ttsOffCtx: SettingsSearchAvailabilityContext = {
      ...runtimeCtx,
      voiceSettings: {
        showMessageTTSButtons: false,
        autoReadAloudEnabled: false,
        voiceProvider: 'browser',
        dictationEnabled: false,
        sttProvider: 'local',
      },
    };
    const ttsOnCtx: SettingsSearchAvailabilityContext = {
      ...ttsOffCtx,
      voiceSettings: {
        showMessageTTSButtons: true,
        autoReadAloudEnabled: false,
        voiceProvider: 'openai-compatible',
        dictationEnabled: false,
        sttProvider: 'local',
      },
    };
    startFromBaseline(baselineWithout('voice.playback', 'voice.tts-endpoint-path'));

    // The endpoint row is hidden while the provider is off, so only playback badges.
    expect(getPages(ttsOffCtx)).toEqual(['voice']);

    acknowledgePage('voice', ttsOffCtx);

    expect(getPages(ttsOffCtx)).toEqual([]);
    expect(isNewSetting('voice.playback')).toBe(false);
    // The never-shown control stays pending and announces once turned on.
    expect(storedBaseline()).not.toContain('voice.tts-endpoint-path');
    expect(getPages(ttsOnCtx)).toEqual(['voice']);
  });

  test('acknowledging a page with nothing new leaves the baseline alone', () => {
    expect(getNewSettingPages()).toEqual([]);
    const seeded = storedBaseline();

    acknowledgeNewSettingPage('voice');

    expect(storedBaseline()).toEqual(seeded);
    expect(storedBaseline()).toHaveLength(SETTINGS_ANCHOR_PAGES.size);
  });

  test('a baseline cleared after load does not turn every anchor new', () => {
    startFromBaseline(baselineWithout('voice.playback'));
    expect(isNewSetting('voice.playback')).toBe(true);

    localStorage.removeItem(STORAGE_KEY);
    acknowledgeNewSettingPage('voice');
    resetNewSettingsBadgeCacheForTests();

    expect(getNewSettingPages()).toEqual([]);
  });

  test('an anchor the search table does not have is never new', () => {
    expect(isNewSetting('appearance.not-a-real-anchor')).toBe(false);
    expect(isNewSetting('')).toBe(false);
  });

  test('unreadable storage counts as a fresh install instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    resetNewSettingsBadgeCacheForTests();

    expect(getNewSettingPages()).toEqual([]);
    expect(storedBaseline()).toHaveLength(SETTINGS_ANCHOR_PAGES.size);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'voice.playback': true }));
    resetNewSettingsBadgeCacheForTests();

    expect(getNewSettingPages()).toEqual([]);
  });

  test('a throwing setItem never crashes the badge', () => {
    const setItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException('Denied', 'QuotaExceededError');
    };
    try {
      resetNewSettingsBadgeCacheForTests();
      expect(getNewSettingPages()).toEqual([]);
      expect(isNewSetting('voice.playback')).toBe(false);
    } finally {
      localStorage.setItem = setItem;
    }
  });
  test('a throwing getItem counts as a fresh install instead of throwing', () => {
    const getItem = localStorage.getItem;
    localStorage.getItem = () => {
      throw new DOMException('Denied', 'SecurityError');
    };
    try {
      resetNewSettingsBadgeCacheForTests();
      expect(getNewSettingPages()).toEqual([]);
      expect(isNewSetting('voice.playback')).toBe(false);
    } finally {
      localStorage.getItem = getItem;
    }
  });
});
