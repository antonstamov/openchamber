import { afterEach, describe, expect, test } from 'bun:test';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useCommentDictationPendingStore } from '@/stores/useCommentDictationPendingStore';
import {
  mergeExternalDraftAppend,
  routeTranscriptToDraft,
  waitForCommentDictationSettled,
} from './commentDictationHandoff';

const comment = {
  source: 'file' as const,
  fileLabel: 'src/app.ts:12',
  startLine: 12,
  endLine: 12,
  code: 'const x = 1',
  language: 'typescript',
};
const target = { directory: '/repo', sessionKey: 'session-1' };

const drafts = () => useInlineCommentDraftStore.getState();
const pending = () => useCommentDictationPendingStore.getState();

describe('a transcript that arrives after its comment attached', () => {
  afterEach(() => {
    useInlineCommentDraftStore.setState({ drafts: {} });
    useCommentDictationPendingStore.setState({ pending: {} });
  });

  test('appends to the attached draft and clears the pending mark', () => {
    const draftId = drafts().addDraft(target, { ...comment, text: '' });
    pending().markPending(draftId!);

    expect(routeTranscriptToDraft({ target, draftId: draftId! }, 'hello there')).toBe('appended');
    expect(drafts().getDrafts(target).map((draft) => draft.text)).toEqual(['hello there ']);
    expect(pending().pending[draftId!]).toBeUndefined();
  });

  test('keeps text typed after attaching and clears the pending mark', () => {
    const draftId = drafts().addDraft(target, { ...comment, text: 'note' });
    pending().markPending(draftId!);

    expect(routeTranscriptToDraft({ target, draftId: draftId! }, 'more')).toBe('appended');
    expect(drafts().getDrafts(target).map((draft) => draft.text)).toEqual(['note more ']);
    expect(pending().pending[draftId!]).toBeUndefined();
  });

  test('an empty transcript only clears the pending mark', () => {
    const draftId = drafts().addDraft(target, { ...comment, text: '' });
    pending().markPending(draftId!);

    expect(routeTranscriptToDraft({ target, draftId: draftId! }, '   ')).toBe('empty');
    expect(drafts().getDrafts(target).map((draft) => draft.text)).toEqual(['']);
    expect(pending().pending[draftId!]).toBeUndefined();
  });

  test('a draft removed meanwhile clears the pending mark without writing', () => {
    const draftId = drafts().addDraft(target, { ...comment, text: '' });
    pending().markPending(draftId!);
    drafts().removeDraft(target, draftId!);

    expect(routeTranscriptToDraft({ target, draftId: draftId! }, 'late')).toBe('gone');
    expect(pending().pending[draftId!]).toBeUndefined();
  });

  test('a refused append clears the pending mark and says so', () => {
    const quote = 'x'.repeat(500 * 1024);
    const first = drafts().addDraft(target, { ...comment, code: quote, text: 'first' });
    const second = drafts().addDraft({ directory: '/repo', sessionKey: 'session-2' }, { ...comment, code: quote, text: 'second' });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    pending().markPending(first!);

    expect(routeTranscriptToDraft({ target, draftId: first! }, 'y'.repeat(100 * 1024))).toBe('refused');
    expect(drafts().getDrafts(target).map((draft) => draft.text)).toEqual(['first']);
    expect(pending().pending[first!]).toBeUndefined();
  });

  test('parallel dictations into different drafts stay separate', () => {
    const first = drafts().addDraft(target, { ...comment, text: '' });
    const other = { directory: '/repo', sessionKey: 'session-2' };
    const second = drafts().addDraft(other, { ...comment, text: '' });
    pending().markPending(first!);
    pending().markPending(second!);

    expect(routeTranscriptToDraft({ target: other, draftId: second! }, 'second draft')).toBe('appended');
    expect(routeTranscriptToDraft({ target, draftId: first! }, 'first draft')).toBe('appended');

    expect(drafts().getDrafts(target).map((draft) => draft.text)).toEqual(['first draft ']);
    expect(drafts().getDrafts(other).map((draft) => draft.text)).toEqual(['second draft ']);
    expect(pending().pending).toEqual({});
  });
});

describe('merging a late transcript into a comment being edited', () => {
  test('no outside change saves the edited text as is', () => {
    expect(mergeExternalDraftAppend('base', 'base', 'edited')).toBe('edited');
  });

  test('an appended transcript joins the edited text', () => {
    expect(mergeExternalDraftAppend('base', 'base spoken ', 'edited')).toBe('edited spoken');
  });

  test('an empty append changes nothing', () => {
    expect(mergeExternalDraftAppend('base', 'base', 'edited')).toBe('edited');
  });

  test('a non-append outside change favors the edited text', () => {
    expect(mergeExternalDraftAppend('base', 'rewritten', 'edited')).toBe('edited');
  });
});

describe('waiting for pending transcripts before a send', () => {
  afterEach(() => {
    useCommentDictationPendingStore.setState({ pending: {} });
  });

  test('resolves settled at once when nothing is pending', async () => {
    expect(await waitForCommentDictationSettled(10)).toBe('settled');
  });

  test('resolves settled once the last pending mark clears', async () => {
    pending().markPending('draft-1');
    pending().markPending('draft-2');
    const waited = waitForCommentDictationSettled(1000);
    pending().clearPending('draft-1');
    await Promise.resolve();
    pending().clearPending('draft-2');
    expect(await waited).toBe('settled');
  });

  test('resolves timeout when a transcript never arrives', async () => {
    pending().markPending('draft-1');
    expect(await waitForCommentDictationSettled(10)).toBe('timeout');
    expect(pending().pending).toEqual({ 'draft-1': true });
  });
});
