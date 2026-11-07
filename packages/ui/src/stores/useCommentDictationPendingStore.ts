import { create } from 'zustand';

/**
 * Tracks comment drafts with a dictation transcript still on its way. The
 * comment field closes on attach without waiting for transcription (nothing
 * blocks the send), so the chips preview and the comment editor need to know
 * which draft is still expecting text. Keyed by draft id, so parallel
 * dictations into different comments do not share a slot.
 *
 * Memory-only: an in-flight transcription dies with the page, so there is
 * nothing to restore after a reload.
 */
interface CommentDictationPendingState {
  pending: Record<string, true>;
  markPending: (draftId: string) => void;
  clearPending: (draftId: string) => void;
}

export const useCommentDictationPendingStore = create<CommentDictationPendingState>()((set) => ({
  pending: {},
  markPending: (draftId) => {
    if (!draftId) return;
    set((state) => (state.pending[draftId] ? state : { pending: { ...state.pending, [draftId]: true } }));
  },
  clearPending: (draftId) => {
    if (!draftId) return;
    set((state) => {
      if (!state.pending[draftId]) return state;
      const pending = { ...state.pending };
      delete pending[draftId];
      return { pending };
    });
  },
}));
