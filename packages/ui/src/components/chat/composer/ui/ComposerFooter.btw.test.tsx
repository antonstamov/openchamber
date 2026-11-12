import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BtwSelection } from '@/stores/useBtwStore';
import type { PermissionMode } from '@/stores/utils/permissionAutoAccept';

const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/action-toolbar', () => ({ TooltipLabelWithShortcut: () => null }));
mock.module('@/components/ui/tooltip', () => ({ Tooltip: Passthrough, TooltipTrigger: Passthrough, TooltipContent: () => null }));
mock.module('@/components/dictation/ComposerDictation', () => ({ ComposerDictation: () => <div data-testid="composer-dictation" /> }));
mock.module('../../ModelControls', () => ({ ModelControls: () => null }));
mock.module('./ComposerActionButtons', () => ({ ComposerActionButtons: () => null }));
mock.module('./ComposerAttachmentControls', () => ({ ComposerAttachmentControls: () => null }));
mock.module('./PermissionAutoAcceptButton', () => ({ PermissionAutoAcceptButton: () => null }));
mock.module('@/components/chat/SessionGoalButton', () => ({ SessionGoalButton: () => null, SessionGoalObjectiveCounter: () => null }));
mock.module('@/hooks/useGuestSurfaces', () => ({ useGuestActions: () => [] }));
mock.module('@/lib/shortcuts', () => ({ formatShortcutForDisplay: () => '', getEffectiveShortcutCombo: () => '' }));
mock.module('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: (select: (state: { dictationEnabled: boolean }) => unknown) => select({ dictationEnabled: true }) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { shortcutOverrides: object }) => unknown) => select({ shortcutOverrides: {} }) }));
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
mock.module('@/lib/dictation/use-dictation-audio-source', () => ({ isDictationCaptureSupported: () => true }));

const { ComposerFooter } = await import('./ComposerFooter');

let browser: Window;
let root: Root;
let restoreGlobals: () => void;

// SAFETY: the footer only reads the BTW selection through to ModelControls,
// which is mocked out; the test passes an empty object with the used shape.
const btwSelection = {} as never as BtwSelection;

const renderFooter = async (isMobile: boolean, isBtw: boolean) => {
    await act(async () => root.render(
        <ComposerFooter
            isMobile={isMobile}
            isVSCode={false}
            sessionId="session-1"
            newSessionDraftOpen={false}
            messageLength={0}
            radius="12px"
            footerPaddingClass=""
            footerGapClass=""
            footerIconButtonClass=""
            iconSizeClass=""
            sendIconSizeClass=""
            stopIconSizeClass=""
            canSend
            canAbort={false}
            hasContent
            permissionMode={'ask' as PermissionMode}
            isPermissionAutoAcceptInteractive
            dictationActive={false}
            onPickLocalFiles={() => undefined}
            onOpenGitHubPicker={() => undefined}
            onOpenAttachSheet={() => undefined}
            onCyclePermissionMode={() => undefined}
            onPrimaryAction={() => undefined}
            onAbort={() => undefined}
            onStartDictation={() => undefined}
            onDictationInsert={() => undefined}
            onDictationInsertAndSend={() => undefined}
            onDictationSendStart={() => undefined}
            onDictationStart={() => undefined}
            isBtw={isBtw}
            btwSelection={btwSelection}
            waitingForOpenCode={false}
        />,
    ));
};

beforeEach(() => {
    browser = new Window();
    const globals = {
        window: browser,
        document: browser.document,
        navigator: browser.navigator,
        HTMLElement: browser.HTMLElement,
        Element: browser.Element,
        Node: browser.Node,
        MutationObserver: browser.MutationObserver,
        ResizeObserver: browser.ResizeObserver,
        requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
        cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
        getComputedStyle: browser.getComputedStyle.bind(browser),
        localStorage: browser.localStorage,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    Object.assign(globalThis, globals);
    restoreGlobals = () => {
        for (const key of Object.keys(globals)) {
            const descriptor = descriptors[key];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    };
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    browser.close();
    restoreGlobals();
});

test('desktop BTW keeps the composer dictation engine', async () => {
    await renderFooter(false, true);
    expect(document.querySelector('[data-testid="composer-dictation"]')).not.toBeNull();
});

test('desktop chat keeps the composer dictation engine', async () => {
    await renderFooter(false, false);
    expect(document.querySelector('[data-testid="composer-dictation"]')).not.toBeNull();
});

test('mobile BTW keeps the mic trigger', async () => {
    await renderFooter(true, true);
    expect(document.querySelector('button[aria-label="chat.dictation.start"]')).not.toBeNull();
});

test('mobile chat keeps the mic trigger', async () => {
    await renderFooter(true, false);
    expect(document.querySelector('button[aria-label="chat.dictation.start"]')).not.toBeNull();
});
