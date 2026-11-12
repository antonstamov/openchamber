import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined, info: () => undefined, success: () => undefined } }));
mock.module('@/components/comments/CommentTextEditor', () => ({ CommentTextEditor: () => null }));
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

describe('attached comment pending indicator', () => {
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

    test('an empty attached draft with a pending transcript shows the processing placeholder', async () => {
        useInlineCommentDraftStore.getState().addDraft(target, {
            id: 'draft-1',
            source: 'file',
            fileLabel: 'src/a.ts',
            startLine: 1,
            endLine: 1,
            code: 'const x = 1;',
            language: 'typescript',
            text: '',
        });
        useCommentDictationPendingStore.getState().markPending('draft-1');

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

        // The chip itself carries the pending mark, so the incoming text never
        // reads as lost before the preview opens.
        const chip = browser.document.querySelector('button[aria-expanded]');
        expect(chip).not.toBeNull();
        expect(chip!.querySelector('[role="status"]')).not.toBeNull();

        await act(async () => { chip!.dispatchEvent(new browser.Event('click', { bubbles: true })); });

        // The preview renders the comment area with a processing placeholder
        // instead of an empty block; the transcript replaces it when it lands.
        expect(previewHost.textContent).toContain('chat.dictation.processing');

        // The transcript landing clears the placeholder.
        const { routeTranscriptToDraft } = await import('@/components/dictation/commentDictationHandoff');
        await act(async () => { routeTranscriptToDraft({ target, draftId: 'draft-1' }, 'late words'); });
        expect(previewHost.textContent).toContain('late words');
        expect(previewHost.textContent).not.toContain('chat.dictation.processing');
        expect(useCommentDictationPendingStore.getState().pending).toEqual({});
    });

    test('the preview edit button still opens the comment editor', async () => {
        useInlineCommentDraftStore.getState().addDraft(target, {
            id: 'draft-2',
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
        expect(chip).not.toBeNull();
        await act(async () => { chip!.dispatchEvent(new browser.Event('click', { bubbles: true })); });

        const editButton = browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.edit"]');
        expect(editButton).not.toBeNull();
        await act(async () => { editButton!.dispatchEvent(new browser.Event('click', { bubbles: true })); });

        // The entry switched to editing: save and cancel replace edit and remove.
        expect(browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.saveEdit"]')).not.toBeNull();
        expect(browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.cancelEdit"]')).not.toBeNull();

        // Saving commits through the draft store and closes the editor.
        const saveButton = browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.saveEdit"]');
        await act(async () => { saveButton!.dispatchEvent(new browser.Event('click', { bubbles: true })); });
        expect(useInlineCommentDraftStore.getState().getDrafts(target).map((draft) => draft.text)).toEqual(['my comment']);
        expect(browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.edit"]')).not.toBeNull();
    });

    test('the preview remove button deletes the draft', async () => {
        useInlineCommentDraftStore.getState().addDraft(target, {
            id: 'draft-3',
            source: 'chat-quote',
            fileLabel: 'msg-1',
            startLine: 0,
            endLine: 0,
            code: 'quoted text',
            language: 'text',
            text: 'to delete',
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

        const removeButton = browser.document.querySelector('button[aria-label="chat.chatInput.contextPreview.remove"]');
        expect(removeButton).not.toBeNull();
        await act(async () => { removeButton!.dispatchEvent(new browser.Event('click', { bubbles: true })); });
        expect(useInlineCommentDraftStore.getState().getDrafts(target)).toEqual([]);
    });
});
