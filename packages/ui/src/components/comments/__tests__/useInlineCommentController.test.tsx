import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { OpenCode } from '@opencode/client';
import { toast } from '@/components/ui';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useInlineCommentController } from '../useInlineCommentController';
import type { InlineCommentSaveTarget } from '../InlineCommentInput';
import { useProjectsStore } from '@/stores/useProjectsStore';

const directory = '/repo';

type Range = { start: number; end: number };

describe('inline comment target', () => {
  let root: Root;
  let dom: ReturnType<typeof installHookTestDom>;
  let surfaceDescriptor: PropertyDescriptor | undefined;
  let frameDescriptor: PropertyDescriptor | undefined;
  let controller: ReturnType<typeof useInlineCommentController<Range>>;
  const saveComment = (text: string, range?: Range) => controller.saveComment(text, range);
  const sdk = OpenCode.make({ baseUrl: 'http://comments.test', fetch: () => new Promise<Response>(() => undefined) });

  const Harness = () => {
    controller = useInlineCommentController<Range>({
      source: 'file',
      fileLabel: 'src/a.ts',
      language: 'ts',
      getCodeForRange: () => 'const answer = 42;',
      toStoreRange: (range) => ({ startLine: range.start, endLine: range.end }),
      fromDraftRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
    });
    return null;
  };

  const draftsAt = (sessionKey: string) => useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey });

  beforeEach(async () => {
    dom = installHookTestDom();
    surfaceDescriptor = Object.getOwnPropertyDescriptor(window, '__OPENCHAMBER_SURFACE__');
    Object.defineProperty(window, '__OPENCHAMBER_SURFACE__', { configurable: true, value: 'desktop' });
    frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
    const { createRoot } = await import('react-dom/client');
    root = createRoot(dom.container);
    useProjectsStore.setState({ projects: [{ id: 'repo', path: directory }] });
    useSessionUIStore.setState({ currentSessionId: 'ses_parent', currentSessionDirectory: directory });
    useInputStore.setState({ composerAddress: null });
    useInlineCommentDraftStore.setState({ drafts: {} });
    await act(async () => root.render(
      <I18nProvider>
        <SyncProvider sdk={sdk} directory={directory}>
          <Harness />
        </SyncProvider>
      </I18nProvider>,
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useInlineCommentDraftStore.setState({ drafts: {} });
    useInputStore.setState({ composerAddress: null });
    if (surfaceDescriptor) Object.defineProperty(window, '__OPENCHAMBER_SURFACE__', surfaceDescriptor);
    else Reflect.deleteProperty(window, '__OPENCHAMBER_SURFACE__');
    if (frameDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    dom.restore();
  });

  test('a file comment is filed into the target the composer published', async () => {
    const fork = { directory, sessionKey: 'ses_fork' };
    await act(async () => { useInputStore.setState({ composerAddress: { inline: fork, attachments: null } }); });

    await act(async () => { saveComment('why this value?', { start: 3, end: 3 }); });

    expect(draftsAt('ses_fork')).toHaveLength(1);
    expect(draftsAt('ses_parent')).toEqual([]);
  });

  test('a comment refused at the limit stays in the editor and says why', async () => {
    const error = spyOn(toast, 'error').mockImplementation(() => 'toast');
    const drafts = useInlineCommentDraftStore.getState();
    for (let index = 0; index < 50; index += 1) {
      drafts.addDraft({ directory, sessionKey: `ses_${index}` }, { source: 'file', fileLabel: 'a', startLine: 1, endLine: 1, code: '', language: '', text: 'kept' });
    }
    try {
      await act(async () => {
        controller.setSelection({ start: 3, end: 3 });
        controller.setCommentText('why this value?');
      });

      let saved: InlineCommentSaveTarget | boolean | undefined;
      await act(async () => { saved = saveComment('why this value?'); });

      expect(saved).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(controller.commentText).toBe('why this value?');
      expect(controller.selection).toEqual({ start: 3, end: 3 });
      expect(Object.keys(useInlineCommentDraftStore.getState().drafts)).toHaveLength(50);
    } finally {
      error.mockRestore();
    }
  });

  test('an edit of a comment already gone closes the editor', async () => {
    const error = spyOn(toast, 'error').mockImplementation(() => 'toast');
    try {
      await act(async () => {
        controller.setSelection({ start: 3, end: 3 });
        controller.setEditingDraftId('icd-gone');
      });

      await act(async () => { saveComment('edited'); });

      expect(error).not.toHaveBeenCalled();
      expect(controller.selection).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  test('without a published target it keeps the open session', async () => {
    await act(async () => { saveComment('why this value?', { start: 3, end: 3 }); });

    expect(draftsAt('ses_parent')).toHaveLength(1);
    expect(draftsAt('ses_fork')).toEqual([]);
  });

  test('a save reports where the comment landed', async () => {
    await act(async () => { controller.setSelection({ start: 3, end: 3 }); });

    let saved: InlineCommentSaveTarget | boolean | undefined;
    await act(async () => { saved = controller.saveComment('why this value?'); });

    expect(typeof saved).toBe('object');
    const binding = saved as InlineCommentSaveTarget;
    expect(typeof binding.draftId).toBe('string');
    expect(useInlineCommentDraftStore.getState().getDrafts(binding.target).map((draft) => draft.text)).toEqual(['why this value?']);
  });

  test('an empty attach without a pending transcript stays in the editor', async () => {
    await act(async () => { controller.setSelection({ start: 3, end: 3 }); });

    let saved: InlineCommentSaveTarget | boolean | undefined;
    await act(async () => { saved = controller.saveComment('   '); });

    expect(saved).toBe(false);
    expect(draftsAt('ses_parent')).toEqual([]);
  });

  test('an empty attach with a pending transcript keeps a placeholder draft', async () => {
    await act(async () => { controller.setSelection({ start: 3, end: 3 }); });

    let saved: InlineCommentSaveTarget | boolean | undefined;
    await act(async () => { saved = controller.saveComment('   ', undefined, { allowEmptyPlaceholder: true }); });

    expect(typeof saved).toBe('object');
    const binding = saved as InlineCommentSaveTarget;
    expect(useInlineCommentDraftStore.getState().getDrafts(binding.target).map((draft) => draft.text)).toEqual(['']);
  });

  test('saving an edit keeps a transcript that landed meanwhile', async () => {
    await act(async () => { controller.setSelection({ start: 3, end: 3 }); });
    let created: InlineCommentSaveTarget | boolean | undefined;
    await act(async () => { created = controller.saveComment('base text'); });
    const binding = created as InlineCommentSaveTarget;

    await act(async () => {
      const draft = useInlineCommentDraftStore.getState().getDrafts(binding.target).find((entry) => entry.id === binding.draftId);
      controller.startEdit(draft!);
    });
    // A late transcript from an attach-while-busy lands in the store while
    // the draft is open in the editor.
    await act(async () => {
      useInlineCommentDraftStore.getState().updateDraft(binding.target, binding.draftId, { text: 'base text late ' });
    });

    await act(async () => { controller.saveComment('my edit'); });

    expect(useInlineCommentDraftStore.getState().getDrafts(binding.target).map((draft) => draft.text)).toEqual(['my edit late']);
  });

  test('a busy save of an edit whose draft is gone starts a new comment', async () => {
    await act(async () => { controller.setSelection({ start: 3, end: 3 }); });
    let created: InlineCommentSaveTarget | boolean | undefined;
    await act(async () => { created = controller.saveComment('base text'); });
    const binding = created as InlineCommentSaveTarget;

    await act(async () => {
      const draft = useInlineCommentDraftStore.getState().getDrafts(binding.target).find((entry) => entry.id === binding.draftId);
      controller.startEdit(draft!);
    });
    // The draft was sent or removed while the edit — and a dictation — was open.
    await act(async () => {
      useInlineCommentDraftStore.getState().removeDraft(binding.target, binding.draftId);
    });

    let saved: InlineCommentSaveTarget | boolean | undefined;
    await act(async () => { saved = controller.saveComment('', undefined, { allowEmptyPlaceholder: true }); });

    expect(typeof saved).toBe('object');
    const fresh = saved as InlineCommentSaveTarget;
    expect(fresh.draftId).not.toBe(binding.draftId);
    expect(useInlineCommentDraftStore.getState().getDrafts(fresh.target).map((draft) => draft.text)).toEqual(['']);
  });
});
