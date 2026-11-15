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
mock.module('@/components/ui/row-tooltip', () => ({ HoverTooltip: Passthrough }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: Passthrough }));
mock.module('@/components/icons/FileTypeIcon', () => ({ FileTypeIcon: () => null }));
mock.module('@/components/comments/useCommentImagePaste', () => ({
  useCommentImagePaste: () => ({
    attachCitedImages: async () => undefined,
    discardPastedImages: () => undefined,
    takePastedImages: () => null,
  }),
}));
mock.module('../../hooks/chatQuoteHighlightStore', () => ({ useChatQuoteHighlightApi: () => null }));
mock.module('../../message/parts/attachmentCitationChips', () => ({ withAttachmentChips: (text: string) => [text] }));
mock.module('@/sync/input-store', () => ({ useInputStore: (select: (state: { attachedFiles: never[] }) => never[]) => select({ attachedFiles: [] }) }));
mock.module('../comment/MobileCommentComposerContext', () => ({ useMobileCommentComposerController: () => null }));
const actualRegistry = await import('@/lib/source-control/providers/registry');
mock.module('@/lib/source-control/providers/registry', () => ({
  ...actualRegistry,
  useSourceControlDescriptorOf: () => () => ({ terminology: { changeRequest: 'pullRequest' } }),
}));
const actualConfigStore = await import('@/stores/useConfigStore');
mock.module('@/stores/useConfigStore', () => ({ ...actualConfigStore, useConfigStore: (select: (state: { dictationEnabled: boolean }) => { dictationEnabled: boolean }) => select({ dictationEnabled: true }) }));
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
mock.module('@/lib/dictation/use-dictation-audio-source', () => ({ isDictationCaptureSupported: () => true }));
const actualDurationTicker = await import('@/hooks/useDurationTicker');
mock.module('@/hooks/useDurationTicker', () => ({ ...actualDurationTicker, useWaitingBlink: () => '' }));
mock.module('@/components/dictation/DictationWaveform', () => ({ DictationWaveform: () => null }));

const engines: Array<{ getOptions: () => UseDictationOptions; setStatus: (status: DictationStatus) => void }> = [];
const idleDictationStatus: DictationStatus = 'idle';
mock.module('@/hooks/useDictation', () => ({
  useDictation: (options: UseDictationOptions) => {
    const optionsRef = React.useRef(options);
    optionsRef.current = options;
    const [status, setStatus] = React.useState<DictationStatus>(idleDictationStatus);
    const statusRef = React.useRef(status);
    statusRef.current = status;
    React.useEffect(() => {
      engines.push({ getOptions: () => optionsRef.current, setStatus });
    }, []);
    return {
      status,
      getStatus: () => statusRef.current,
      isRecording: status === 'recording',
      isProcessing: status === 'uploading',
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

const { ComposerContextRows } = await import('./ComposerContextRows');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
const { useCommentDictationPendingStore } = await import('@/stores/useCommentDictationPendingStore');

describe('ComposerContextRows comment edit dictation', () => {
  let browser: Window;
  let root: Root;
  let restoreGlobals: () => void;

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

  test('an open row edit mounts the inline dictation button', async () => {
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
      <ComposerContextRows draftTarget={target} isMobile={false} onOpenAttachment={() => {}} />,
    ));

    const collapsed = browser.document.querySelector('[role="button"][aria-expanded="false"]');
    expect(collapsed).not.toBeNull();
    await act(async () => { collapsed!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })); });

    expect(browser.document.querySelector('.cm-content')?.textContent).toContain('note');
    // The edit mounts one comment dictation engine, with a mic for the transcript.
    expect(engines).toHaveLength(1);
    expect(browser.document.querySelector('button[aria-label="chat.dictation.start"]')).not.toBeNull();
  });

  test('a transcript that lands while the row edit is open saves without duplication', async () => {
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
      <ComposerContextRows draftTarget={target} isMobile={false} onOpenAttachment={() => {}} />,
    ));

    const collapsed = browser.document.querySelector('[role="button"][aria-expanded="false"]');
    await act(async () => { collapsed!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })); });
    expect(engines).toHaveLength(1);

    // Recording arms the handoff; the status-leave without a transcript disarms it.
    await act(async () => { engines[0].setStatus('recording'); });
    expect(useCommentDictationPendingStore.getState().pending).toEqual({ 'draft-1': true });
    await act(async () => { engines[0].setStatus('idle'); });
    expect(useCommentDictationPendingStore.getState().pending).toEqual({});

    await act(async () => { engines[0].getOptions().onTranscript?.('spoken words'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(browser.document.querySelector('.cm-content')?.textContent).toContain('spoken words');
    expect(useCommentDictationPendingStore.getState().pending).toEqual({});

    // Committing the edit keeps the transcript exactly once: the edit base
    // moved with the late text, so the save merge does not append it again.
    const header = browser.document.querySelector('.oc-tile [role="button"]');
    await act(async () => { header!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const texts = useInlineCommentDraftStore.getState().getDrafts(target).map((draft) => draft.text);
    expect(texts).toEqual(['note spoken words ']);
  });

  test('saving while dictation is busy keeps the handoff for the late transcript', async () => {
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
      <ComposerContextRows draftTarget={target} isMobile={false} onOpenAttachment={() => {}} />,
    ));

    const collapsed = browser.document.querySelector('[role="button"][aria-expanded="false"]');
    await act(async () => { collapsed!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })); });
    expect(engines).toHaveLength(1);
    await act(async () => { engines[0].setStatus('recording'); });

    // Enter/save while busy closes the row but keeps the pending mark: the
    // late transcript still has a route into the draft.
    const header = browser.document.querySelector('.oc-tile [role="button"]');
    await act(async () => { header!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(useCommentDictationPendingStore.getState().pending).toEqual({ 'draft-1': true });

    await act(async () => { engines[0].getOptions().onTranscript?.('late words'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(useCommentDictationPendingStore.getState().pending).toEqual({});
    const texts = useInlineCommentDraftStore.getState().getDrafts(target).map((draft) => draft.text);
    expect(texts).toEqual(['note late words ']);
  });

  test('an empty draft with a pending transcript shows the processing placeholder', async () => {
    useInlineCommentDraftStore.getState().addDraft(target, {
      id: 'draft-1',
      source: 'chat-quote',
      fileLabel: 'msg-1',
      startLine: 0,
      endLine: 0,
      code: 'quoted text',
      language: 'text',
      text: '',
    });
    useCommentDictationPendingStore.getState().markPending('draft-1');

    await act(async () => root.render(
      <ComposerContextRows draftTarget={target} isMobile={false} onOpenAttachment={() => {}} />,
    ));

    const collapsed = browser.document.querySelector('[role="button"][aria-expanded="false"]');
    expect(collapsed).not.toBeNull();
    expect(collapsed!.textContent).toContain('chat.dictation.processing');
  });
});
