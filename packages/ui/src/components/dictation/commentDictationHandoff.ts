import { appendInlineText } from '@/components/chat/composer/text';
import {
  useInlineCommentDraftStore,
  type InlineCommentDraftTarget,
} from '@/stores/useInlineCommentDraftStore';
import { useCommentDictationPendingStore } from '@/stores/useCommentDictationPendingStore';

/**
 * Non-blocking comment dictation: attaching a comment while its transcript is
 * still being recorded or transcribed closes the field at once and the late
 * transcript is appended to the attached draft afterwards.
 *
 * The dictation session lives in the field that started it, so it would be
 * cancelled with the field's unmount. Arming a handoff at attach time keeps
 * the stream alive past the unmount and routes the completion here, into the
 * draft store, keyed by draft id so parallel dictations stay separate.
 */
export interface CommentDictationRoute {
  target: InlineCommentDraftTarget;
  draftId: string;
}

export type RouteTranscriptResult = 'appended' | 'empty' | 'gone' | 'refused';

/**
 * Append a late transcript to its draft, reading the draft's current text so a
 * meanwhile edit is kept. Returns what happened, so the caller can say why a
 * transcript went nowhere. Always clears the pending mark: a routed, refused,
 * or orphaned transcript must not leave the draft flagged forever.
 */
export function routeTranscriptToDraft(route: CommentDictationRoute, spoken: string): RouteTranscriptResult {
  const { clearPending } = useCommentDictationPendingStore.getState();
  const trimmed = spoken.trim();
  if (!trimmed) {
    clearPending(route.draftId);
    return 'empty';
  }
  const store = useInlineCommentDraftStore.getState();
  const draft = store.getDrafts(route.target).find((entry) => entry.id === route.draftId);
  if (!draft) {
    clearPending(route.draftId);
    return 'gone';
  }
  const accepted = store.updateDraft(route.target, route.draftId, {
    text: appendInlineText(draft.text, trimmed),
  });
  clearPending(route.draftId);
  return accepted ? 'appended' : 'refused';
}

/**
 * Merge a transcript that landed in the draft store while its comment was
 * open in an editor. The editor holds the text the edit started from; a late
 * append must join the edited text, not replace it and not be lost by the
 * save. Appends are the only external change this path produces, so a
 * non-append difference falls back to the edited text.
 */
export function mergeExternalDraftAppend(baseText: string, currentText: string, editedText: string): string {
  if (currentText === baseText) return editedText;
  const suffix = currentText.startsWith(baseText) ? currentText.slice(baseText.length) : '';
  if (!suffix.trim()) return editedText;
  return appendInlineText(editedText, suffix).trimEnd();
}
