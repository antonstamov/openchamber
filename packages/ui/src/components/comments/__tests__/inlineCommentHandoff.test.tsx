import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useCommentDictationPendingStore } from '@/stores/useCommentDictationPendingStore';
import type { DictationStatus, UseDictationOptions } from '@/hooks/useDictation';

const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const engines: Array<{
  getOptions: () => UseDictationOptions;
  setStatus: (status: DictationStatus) => void;
  setPartial: (text: string) => void;
}> = [];
let confirmed = 0;

mock.module('@/hooks/useDictation', () => ({
  useDictation: (options: UseDictationOptions) => {
    const [status, setStatus] = React.useState<DictationStatus>('idle');
    const [partialTranscript, setPartial] = React.useState('');
    const statusRef = React.useRef(status);
    statusRef.current = status;
    const optionsRef = React.useRef(options);
    optionsRef.current = options;
    React.useEffect(() => {
      engines.push({ getOptions: () => optionsRef.current, setStatus, setPartial });
    }, []);
    return {
      status,
      getStatus: () => statusRef.current,
      isRecording: status === 'recording',
      isProcessing: status === 'uploading',
      partialTranscript,
      subscribeLevel: () => () => {},
      duration: 0,
      error: null,
      errorReason: null,
      startDictation: async () => { setStatus('recording'); },
      confirmDictation: async () => {
        confirmed += 1;
        setStatus('uploading');
        return null;
      },
      cancelDictation: async () => { setStatus('idle'); },
      retryFailedDictation: async () => null,
      acceptPartialTranscript: () => null,
      discardFailedDictation: () => {},
    };
  },
}));
mock.module('@/lib/dictation/use-dictation-audio-source', () => ({ isDictationCaptureSupported: () => true }));
mock.module('@/hooks/useDurationTicker', () => ({ useWaitingBlink: () => '' }));
mock.module('@/components/dictation/DictationWaveform', () => ({ DictationWaveform: () => null }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/action-toolbar', () => ({ ButtonTooltip: Passthrough, TooltipLabelWithShortcut: () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined, info: () => undefined, success: () => undefined } }));
mock.module('@/components/ui/tooltip', () => ({ Tooltip: Passthrough, TooltipTrigger: Passthrough, TooltipContent: () => null }));
mock.module('@/components/ui/spinner', () => ({ Spinner: () => null }));

const { InlineCommentInput } = await import('../InlineCommentInput');

const target = { directory: '/repo', sessionKey: 'session-1' };
const draftSeed = {
  source: 'file' as const,
  fileLabel: 'src/a.ts',
  startLine: 1,
  endLine: 1,
  code: 'const x = 1;',
  language: 'typescript',
  text: '',
};

describe('attach while dictation is still transcribing', () => {
  let browser: Window;
  let root: Root;
  let restoreGlobals: () => void;
  const saves: Array<{ text: string; options: unknown }> = [];

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
    confirmed = 0;
    saves.length = 0;
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
    useUIStore.getState().setIsMobile(false);
  });

  const pressEnter = async () => {
    const field = browser.document.querySelector('textarea');
    if (!field) throw new Error('comment field not mounted');
    await act(async () => {
      field.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    });
  };

  const mount = async () => {
    await act(async () => root.render(
      <I18nProvider>
        <InlineCommentInput
          initialText=""
          onSave={(text, range, options) => {
            saves.push({ text, options });
            return { draftId: 'draft-1', target };
          }}
          onCancel={() => undefined}
        />
      </I18nProvider>,
    ));
  };

  test('an empty attach during uploading finalizes, arms a handoff, and lands the late transcript in the draft', async () => {
    const draftId = useInlineCommentDraftStore.getState().addDraft(target, { ...draftSeed, id: 'draft-1' });
    expect(draftId).toBe('draft-1');
    await mount();
    expect(engines).toHaveLength(1);

    // The session is still transcribing when the user attaches.
    await act(async () => { engines[0].setStatus('uploading'); });
    await pressEnter();

    expect(confirmed).toBe(1);
    expect(saves).toHaveLength(1);
    expect(saves[0].text).toBe('');
    expect(saves[0].options).toEqual({ allowEmptyPlaceholder: true });
    expect(useCommentDictationPendingStore.getState().pending['draft-1']).toBe(true);

    // The parent unmounts the field on save; the transcript arrives after.
    await act(async () => root.unmount());
    await act(async () => { engines[0].getOptions().onTranscript?.('late words'); });

    expect(useInlineCommentDraftStore.getState().getDrafts(target).map((draft) => draft.text)).toEqual(['late words ']);
    expect(useCommentDictationPendingStore.getState().pending).toEqual({});
  });

  test('a post-close transcription failure salvages the partial and clears the pending mark', async () => {
    const draftId = useInlineCommentDraftStore.getState().addDraft(target, { ...draftSeed, id: 'draft-1' });
    expect(draftId).toBe('draft-1');
    await mount();
    expect(engines).toHaveLength(1);

    // The session is still transcribing when the user attaches.
    await act(async () => { engines[0].setStatus('uploading'); });
    await pressEnter();
    expect(useCommentDictationPendingStore.getState().pending['draft-1']).toBe(true);

    // The parent unmounts the field on save; transcription fails after.
    // The partial arrives while the field is still mounted, the failure after.
    await act(async () => { engines[0].setPartial('salvage me'); });
    await act(async () => root.unmount());
    await act(async () => { engines[0].getOptions().onError?.(new Error('boom')); });

    // The salvage lands in the draft and the pending indicator goes away.
    expect(useInlineCommentDraftStore.getState().getDrafts(target).map((draft) => draft.text)).toEqual(['salvage me ']);
    expect(useCommentDictationPendingStore.getState().pending).toEqual({});
  });

  test('an empty attach while idle still does nothing', async () => {
    await mount();
    await pressEnter();
    expect(saves).toHaveLength(0);
    expect(confirmed).toBe(0);
  });
});
