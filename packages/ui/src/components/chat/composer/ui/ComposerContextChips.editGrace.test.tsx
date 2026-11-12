import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

const actualI18n = await import('@/lib/i18n');
mock.module('@/lib/i18n', () => ({ ...actualI18n, useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { isMobile: boolean; mobileReturnKeySends: boolean; shortcutOverrides: object }) => { isMobile: boolean; mobileReturnKeySends: boolean; shortcutOverrides: object }) => select({ isMobile: false, mobileReturnKeySends: false, shortcutOverrides: {} }) }));
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
mock.module('@/components/dictation/InlineDictationButton', () => ({ InlineDictationButton: () => null }));
mock.module('../../hooks/chatQuoteHighlightStore', () => ({ useChatQuoteHighlightApi: () => null }));
mock.module('./contextPreviewHeight', () => ({ getContextPreviewMaxHeight: () => 300 }));
mock.module('../../message/parts/attachmentCitationChips', () => ({ withAttachmentChips: (text: string) => text }));
mock.module('@/sync/input-store', () => ({ useInputStore: (select: (state: { attachedFiles: never[] }) => never[]) => select({ attachedFiles: [] }) }));
mock.module('./GlassPopupMotion', () => ({ GlassPopupMotion: Passthrough }));
mock.module('@/components/comments/wholeFileComment', () => ({ isWholeFileComment: () => false }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: Passthrough }));
mock.module('../comment/MobileCommentComposerContext', () => ({ useMobileCommentComposerController: () => null }));
mock.module('motion/react', () => ({ AnimatePresence: Passthrough }));

const { ComposerContextChips } = await import('./ComposerContextChips');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
const { useCommentDictationPendingStore } = await import('@/stores/useCommentDictationPendingStore');

describe('edit commit grace after opening', () => {
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
        useInlineCommentDraftStore.setState({ drafts: {} });
        useCommentDictationPendingStore.setState({ pending: {} });
    });

    test('a blur right after opening does not commit; a later blur does', async () => {
        useInlineCommentDraftStore.getState().addDraft(target, {
            id: 'draft-1',
            source: 'chat-quote',
            fileLabel: 'msg-1',
            startLine: 0,
            endLine: 0,
            code: 'quoted text',
            language: 'text',
            text: 'my comment',
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

        // The editor opened with the draft text.
        expect(browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.saveEdit"]')).not.toBeNull();
        expect(previewHost.textContent).toContain('my comment');

        // A blur in the first moments after opening is the open click's own
        // focus dance, not the user leaving: the edit stays open.
        const editor = browser.document.querySelector('.cm-content');
        expect(editor).not.toBeNull();
        await act(async () => { editor!.dispatchEvent(new browser.Event('blur')); });
        expect(browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.saveEdit"]')).not.toBeNull();
        expect(browser.document.querySelector('.cm-content')).not.toBeNull();

        // Past the grace window a blur commits and closes the edit as before.
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
        await act(async () => { browser.document.querySelector('.cm-content')!.dispatchEvent(new browser.Event('blur')); });
        expect(browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.saveEdit"]')).toBeNull();
        expect(browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.edit"]')).not.toBeNull();
    });
});
