import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DictationStatus, UseDictationOptions } from '@/hooks/useDictation';

const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

const actualI18n = await import('@/lib/i18n');
mock.module('@/lib/i18n', () => ({ ...actualI18n, useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined, info: () => undefined, success: () => undefined } }));
mock.module('@/components/ui/tooltip', () => ({ Tooltip: Passthrough, TooltipTrigger: Passthrough, TooltipContent: () => null }));
mock.module('@/components/comments/useCommentImagePaste', () => ({
    useCommentImagePaste: () => ({
        attachCitedImages: async () => undefined,
        discardPastedImages: () => undefined,
        takePastedImages: () => null,
    }),
}));
mock.module('../../hooks/chatQuoteHighlightStore', () => ({ useChatQuoteHighlightApi: () => null }));
mock.module('./contextPreviewHeight', () => ({ getContextPreviewMaxHeight: () => 300 }));
mock.module('../../message/parts/attachmentCitationChips', () => ({ withAttachmentChips: (text: string) => text }));
mock.module('@/sync/input-store', () => ({ useInputStore: (select: (state: { attachedFiles: never[] }) => never[]) => select({ attachedFiles: [] }) }));
mock.module('./GlassPopupMotion', () => ({ GlassPopupMotion: Passthrough }));
mock.module('@/components/comments/wholeFileComment', () => ({ isWholeFileComment: () => false }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: Passthrough }));
mock.module('../comment/MobileCommentComposerContext', () => ({ useMobileCommentComposerController: () => null }));
mock.module('motion/react', () => ({ AnimatePresence: Passthrough }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { isMobile: boolean; mobileReturnKeySends: boolean; shortcutOverrides: object }) => { isMobile: boolean; mobileReturnKeySends: boolean; shortcutOverrides: object }) => select({ isMobile: false, mobileReturnKeySends: false, shortcutOverrides: {} }) }));
const actualConfigStore = await import('@/stores/useConfigStore');
mock.module('@/stores/useConfigStore', () => ({ ...actualConfigStore, useConfigStore: (select: (state: { dictationEnabled: boolean }) => { dictationEnabled: boolean }) => select({ dictationEnabled: true }) }));
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
mock.module('@/lib/dictation/use-dictation-audio-source', () => ({ isDictationCaptureSupported: () => true }));
const actualDurationTicker = await import('@/hooks/useDurationTicker');
mock.module('@/hooks/useDurationTicker', () => ({ ...actualDurationTicker, useWaitingBlink: () => '' }));
mock.module('@/components/dictation/DictationWaveform', () => ({ DictationWaveform: () => null }));

const engines: Array<{ getOptions: () => UseDictationOptions }> = [];
const idleDictationStatus: DictationStatus = 'idle';
mock.module('@/hooks/useDictation', () => ({
    useDictation: (options: UseDictationOptions) => {
        const optionsRef = React.useRef(options);
        optionsRef.current = options;
        React.useEffect(() => {
            engines.push({ getOptions: () => optionsRef.current });
        }, []);
        return {
            status: idleDictationStatus,
            getStatus: () => idleDictationStatus,
            isRecording: false,
            isProcessing: false,
            partialTranscript: '',
            subscribeLevel: () => () => {},
            duration: 0,
            error: null,
            errorReason: null,
            startDictation: async () => {},
            confirmDictation: async () => null,
            cancelDictation: async () => {},
            retryFailedDictation: async () => null,
            acceptPartialTranscript: () => null,
            discardFailedDictation: () => {},
        };
    },
}));

const { ComposerContextChips } = await import('./ComposerContextChips');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
const { useCommentDictationPendingStore } = await import('@/stores/useCommentDictationPendingStore');

describe('a transcript that lands while its comment is being edited', () => {
    let browser: Window;
    let root: Root;
    let restoreGlobals: () => void;
    let previewHost: HTMLElement;

    const target = { directory: '/repo', sessionKey: 'session-1' };

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
        engines.length = 0;
        useInlineCommentDraftStore.setState({ drafts: {} });
        useCommentDictationPendingStore.setState({ pending: {} });
        const host = document.createElement('div');
        document.body.append(host);
        previewHost = document.createElement('div');
        document.body.append(previewHost);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        browser.close();
        restoreGlobals();
        engines.length = 0;
        useInlineCommentDraftStore.setState({ drafts: {} });
        useCommentDictationPendingStore.setState({ pending: {} });
    });

    test('the transcript shows in the open editor at once and saves without duplication', async () => {
        useInlineCommentDraftStore.getState().addDraft(target, {
            id: 'draft-1',
            source: 'chat-quote',
            fileLabel: 'msg-1',
            startLine: 0,
            endLine: 0,
            code: 'quoted text',
            language: 'text',
            text: 'note',
        });
        await act(async () => root.render(
            <ComposerContextChips
                draftTarget={target}
                // SAFETY: the chips only read colors.status.info for the count;
                // the test passes the one used key with the used shape.
                colors={{ status: { info: 'blue' } } as never}
                previewHost={previewHost}
                isMobile={false}
            />,
        ));

        const chip = browser.document.querySelector('button[aria-expanded]');
        await act(async () => { chip!.dispatchEvent(new browser.Event('click', { bubbles: true })); });
        const editButton = browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.edit"]');
        await act(async () => { editButton!.dispatchEvent(new browser.Event('click', { bubbles: true })); });
        expect(browser.document.querySelector('.cm-content')?.textContent).toContain('note');

        // The transcript lands while the edit is open: it shows in the field
        // at once instead of waiting for the save.
        await act(async () => { useCommentDictationPendingStore.getState().markPending('draft-1'); });
        expect(engines).toHaveLength(1);
        await act(async () => { engines[0].getOptions().onTranscript?.('spoken words'); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(browser.document.querySelector('.cm-content')?.textContent).toContain('spoken words');
        expect(useCommentDictationPendingStore.getState().pending).toEqual({});

        // Saving keeps the transcript exactly once: the edit base moved with
        // the late text, so the save merge does not append it again.
        const saveButton = browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.saveEdit"]');
        await act(async () => { saveButton!.dispatchEvent(new browser.Event('click', { bubbles: true })); });
        const texts = useInlineCommentDraftStore.getState().getDrafts(target).map((draft) => draft.text);
        expect(texts).toEqual(['note spoken words ']);
    });
});
