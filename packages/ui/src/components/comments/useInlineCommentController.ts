import React from 'react';
import { toast } from '@/components/ui';
import {
  EMPTY_INLINE_COMMENT_DRAFTS,
  getInlineCommentDraftKey,
  useInlineCommentDraftStore,
  type InlineCommentDraft,
  type InlineCommentSource,
} from '@/stores/useInlineCommentDraftStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useComposerDraftTarget } from '@/hooks/useComposerAddress';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { diffCommentOriginKey, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { mergeExternalDraftAppend } from '@/components/dictation/commentDictationHandoff';
import type { InlineCommentSaveOptions, InlineCommentSaveTarget } from './InlineCommentInput';
import { anchorComment, commentContext, type CommentAnchorInput, type CommentLineSource } from '@/lib/commentAnchor';

type LineRangeBase = {
  start: number;
  end: number;
};

type StoreRange = {
  startLine: number;
  endLine: number;
  side?: 'original' | 'modified';
};

interface UseInlineCommentControllerOptions<TRange extends LineRangeBase> {
  source: InlineCommentSource;
  fileLabel: string | null;
  language: string;
  getCodeForRange: (range: TRange) => string;
  toStoreRange: (range: TRange) => StoreRange;
  fromDraftRange: (draft: InlineCommentDraft) => TRange;
  origin?: DiffCommentOrigin;
  lineSource?: (range: TRange) => CommentLineSource | null;
  contentVersion?: unknown;
  onSelectionMoved?: (range: TRange) => void;
}

const normalizeStoreRange = (range: StoreRange): StoreRange => {
  const startLine = Math.min(range.startLine, range.endLine);
  const endLine = Math.max(range.startLine, range.endLine);
  return {
    ...range,
    startLine,
    endLine,
  };
};

export const normalizeLineRange = <TRange extends LineRangeBase>(range: TRange): TRange => {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return {
    ...range,
    start,
    end,
  };
};

export function useInlineCommentController<TRange extends LineRangeBase>(
  options: UseInlineCommentControllerOptions<TRange>
) {
  const { t } = useI18n();
  const { source, fileLabel, language, getCodeForRange, toStoreRange, fromDraftRange, origin, contentVersion } = options;
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  });
  const originKey = diffCommentOriginKey(origin);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const effectiveDirectory = useEffectiveDirectory();
  const sessionDirectory = useSessionUIStore(
    React.useCallback(
      (state) => currentSessionId ? state.getDirectoryForSession(currentSessionId) : null,
      [currentSessionId],
    ),
  );

  const addDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const updateDraft = useInlineCommentDraftStore((state) => state.updateDraft);
  const removeDraft = useInlineCommentDraftStore((state) => state.removeDraft);

  const [selection, setSelection] = React.useState<TRange | null>(null);
  const [commentText, setCommentText] = React.useState('');
  const [editingDraftId, setEditingDraftId] = React.useState<string | null>(null);
  // The draft text the current edit started from: a late transcript landing
  // in the store meanwhile is merged into the save, not overwritten by it.
  const editBaseRef = React.useRef('');

  const target = useComposerDraftTarget(sessionDirectory ?? effectiveDirectory);
  const targetKey = target
    ? getInlineCommentDraftKey(getRuntimeKey(), target.directory, target.sessionKey)
    : null;
  const sessionDrafts = useInlineCommentDraftStore(
    React.useCallback(
      (state) => targetKey ? state.drafts[targetKey] ?? EMPTY_INLINE_COMMENT_DRAFTS : EMPTY_INLINE_COMMENT_DRAFTS,
      [targetKey],
    ),
  );

  const drafts = React.useMemo(() => {
    if (!target || !fileLabel) return [];
    return sessionDrafts.filter((draft) => (
      draft.source === source && draft.fileLabel === fileLabel && diffCommentOriginKey(draft.origin) === originKey
    ));
  }, [fileLabel, originKey, sessionDrafts, source, target]);

  React.useEffect(() => {
    if (!target) return;
    const { lineSource, fromDraftRange: rangeOf } = optionsRef.current;
    if (!lineSource) return;
    for (const draft of drafts) {
      const lines = lineSource(rangeOf(draft));
      if (!lines) continue;
      const anchored = anchorComment(lines, draft);
      if (anchored.startLine === draft.startLine && anchored.endLine === draft.endLine && anchored.changedCode === draft.changedCode) continue;
      updateDraft(target, draft.id, { startLine: anchored.startLine, endLine: anchored.endLine, changedCode: anchored.changedCode });
    }
  }, [contentVersion, drafts, target, updateDraft]);

  const selectionAnchorRef = React.useRef<Omit<CommentAnchorInput, 'startLine' | 'endLine'> | null>(null);
  const movedSelectionRef = React.useRef<{ start: number; end: number } | null>(null);
  React.useEffect(() => {
    const { lineSource, getCodeForRange: codeOf, toStoreRange: storeRangeOf } = optionsRef.current;
    const lines = selection ? lineSource?.(selection) : null;
    const moved = movedSelectionRef.current;
    movedSelectionRef.current = null;
    if (!selection || !lines) {
      selectionAnchorRef.current = null;
      return;
    }
    const range = normalizeLineRange(selection);
    if (moved && moved.start === range.start && moved.end === range.end && selectionAnchorRef.current) return;
    const stored = normalizeStoreRange(storeRangeOf(range));
    selectionAnchorRef.current = { code: codeOf(range), ...commentContext(lines, stored.startLine, stored.endLine) };
  }, [selection]);
  React.useEffect(() => {
    const anchor = selectionAnchorRef.current;
    const { lineSource, toStoreRange: storeRangeOf, onSelectionMoved } = optionsRef.current;
    const lines = selection ? lineSource?.(selection) : null;
    if (!selection || !anchor || !lines) return;
    const range = normalizeLineRange(selection);
    const stored = normalizeStoreRange(storeRangeOf(range));
    const anchored = anchorComment(lines, { ...anchor, startLine: stored.startLine, endLine: stored.endLine });
    if (anchored.startLine === stored.startLine && anchored.endLine === stored.endLine) return;
    movedSelectionRef.current = { start: anchored.startLine, end: anchored.endLine };
    (onSelectionMoved ?? setSelection)({ ...range, start: anchored.startLine, end: anchored.endLine });
  }, [contentVersion, selection]);

  const reset = React.useCallback(() => {
    setSelection(null);
    setCommentText('');
    setEditingDraftId(null);
    editBaseRef.current = '';
  }, []);

  const cancel = React.useCallback(() => {
    reset();
  }, [reset]);

  const startEdit = React.useCallback((draft: InlineCommentDraft) => {
    const draftRange = normalizeLineRange(fromDraftRange(draft));
    setSelection(draftRange);
    setCommentText(draft.text);
    setEditingDraftId(draft.id);
    editBaseRef.current = draft.text;
  }, [fromDraftRange]);

  const deleteDraft = React.useCallback((draft: InlineCommentDraft) => {
    if (!target) return;
    removeDraft(target, draft.id);
    if (editingDraftId === draft.id) {
      reset();
    }
  }, [editingDraftId, removeDraft, reset, target]);

  // True when the editor is done with the text. False keeps it open: a refused
  // comment exists nowhere but in the field. On success returns where the
  // comment landed, so an attach-while-busy can route the late transcript
  // into the draft after the field unmounts.
  const saveComment = React.useCallback((textToSave: string, rangeOverride?: TRange, options?: InlineCommentSaveOptions): InlineCommentSaveTarget | boolean => {
    const targetRange = rangeOverride ?? selection;
    const trimmedText = textToSave.trim();
    if (!targetRange || !fileLabel) return false;
    if (!trimmedText && !options?.allowEmptyPlaceholder) return false;

    if (!target) {
      toast.error(t('inlineComment.toast.selectSessionToSave'));
      return false;
    }

    // The edited comment was sent or removed meanwhile: nothing left to save to.
    // A busy attach converts into a new comment instead, so the late
    // transcript still gets a draft.
    let editId = editingDraftId;
    if (editId && !useInlineCommentDraftStore.getState().getDrafts(target).some((draft) => draft.id === editId)) {
      if (!options?.allowEmptyPlaceholder) {
        reset();
        return true;
      }
      setEditingDraftId(null);
      editBaseRef.current = '';
      editId = null;
    }

    const normalizedRange = normalizeLineRange(targetRange);
    const normalizedStoreRange = normalizeStoreRange(toStoreRange(normalizedRange));
    const code = getCodeForRange(normalizedRange);
    const lines = optionsRef.current.lineSource?.(normalizedRange);
    const context = lines ? commentContext(lines, normalizedStoreRange.startLine, normalizedStoreRange.endLine) : null;
    const anchor = {
      contextBefore: context?.contextBefore,
      contextAfter: context?.contextAfter,
      changedCode: undefined,
    };

    const isNewComment = !editId;
    if (editId) {
      // A late transcript may have landed in the draft while it was open in
      // the editor: merge it into the edited text instead of overwriting it.
      const stored = useInlineCommentDraftStore.getState().getDrafts(target).find((draft) => draft.id === editId);
      const mergedText = mergeExternalDraftAppend(editBaseRef.current ?? '', stored?.text ?? '', trimmedText);
      const updated = updateDraft(target, editId, {
        fileLabel,
        startLine: normalizedStoreRange.startLine,
        endLine: normalizedStoreRange.endLine,
        side: normalizedStoreRange.side,
        code,
        ...anchor,
        language,
        text: mergedText,
        origin,
      });
      if (!updated) {
        toast.error(t('inlineComment.toast.noRoom'));
        return false;
      }
      const binding = { draftId: editId, target };
      reset();
      return binding;
    }
    const draftId = addDraft(target, {
      source,
      fileLabel,
      startLine: normalizedStoreRange.startLine,
      endLine: normalizedStoreRange.endLine,
      side: normalizedStoreRange.side,
      code,
      ...anchor,
      language,
      text: trimmedText,
      origin,
    });
    if (!draftId) {
      toast.error(t('inlineComment.toast.noRoom'));
      return false;
    }

    const binding = { draftId, target };
    reset();
    if (isNewComment) {
      requestAnimationFrame(focusChatInput);
    }
    return binding;
  }, [addDraft, editingDraftId, fileLabel, getCodeForRange, language, origin, reset, selection, source, t, target, toStoreRange, updateDraft]);

  return {
    drafts,
    selection,
    setSelection,
    commentText,
    setCommentText,
    editingDraftId,
    setEditingDraftId,
    reset,
    cancel,
    startEdit,
    deleteDraft,
    saveComment,
    fromDraftRange,
  };
}
