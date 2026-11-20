import { describe, expect, test } from 'bun:test';

import { shouldMountMobileDictationEngine } from './mobileDictationMount';

describe('shouldMountMobileDictationEngine', () => {
    test('mounts in btw mode: the footer mic dispatches the toggle the engine listens for', () => {
        expect(shouldMountMobileDictationEngine({ isMobile: true, isBtwActive: true, mobileCommentActive: false, messageSelectionActive: false })).toBe(true);
    });

    test('mounts outside btw mode', () => {
        expect(shouldMountMobileDictationEngine({ isMobile: true, isBtwActive: false, mobileCommentActive: false, messageSelectionActive: false })).toBe(true);
    });

    test('stays unmounted while the comment shell owns dictation', () => {
        expect(shouldMountMobileDictationEngine({ isMobile: true, isBtwActive: true, mobileCommentActive: true, messageSelectionActive: false })).toBe(false);
    });

    test('stays unmounted while message selection replaces the composer', () => {
        expect(shouldMountMobileDictationEngine({ isMobile: true, isBtwActive: true, mobileCommentActive: false, messageSelectionActive: true })).toBe(false);
    });

    test('stays unmounted off mobile: the desktop footer mounts its own engine', () => {
        expect(shouldMountMobileDictationEngine({ isMobile: false, isBtwActive: false, mobileCommentActive: false, messageSelectionActive: false })).toBe(false);
    });
});
