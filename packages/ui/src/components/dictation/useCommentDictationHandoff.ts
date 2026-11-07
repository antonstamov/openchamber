import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { DictationCompletionHandoff, DictationStatus } from '@/hooks/useDictation';
import type { InlineDictationController } from './InlineDictationButton';
import {
  routeTranscriptToDraft,
  type CommentDictationRoute,
} from './commentDictationHandoff';
import { useCommentDictationPendingStore } from '@/stores/useCommentDictationPendingStore';

/**
 * Non-blocking comment dictation, shared by the floating chat-quote field and
 * the inline comment inputs. Attaching while the session is busy closes the
 * field at once: the session is finalized in the background and the late
 * transcript is appended to the attached draft (see `armHandoff`) instead of
 * being lost with the unmount. While the field is open transcripts go to
 * `onLocalTranscript`.
 */
export function useCommentDictationHandoff(options: {
  onLocalTranscript: (spoken: string) => void;
}) {
  const { t } = useI18n();
  const { onLocalTranscript } = options;
  const onLocalTranscriptRef = React.useRef(onLocalTranscript);
  React.useEffect(() => {
    onLocalTranscriptRef.current = onLocalTranscript;
  }, [onLocalTranscript]);

  const controllerRef = React.useRef<InlineDictationController | null>(null);
  const routeRef = React.useRef<CommentDictationRoute | null>(null);
  const markerRef = React.useRef<DictationCompletionHandoff | null>(null);
  const partialRef = React.useRef('');
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => {
    mountedRef.current = false;
  }, []);
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);

  const disarmHandoff = React.useCallback(() => {
    const route = routeRef.current;
    routeRef.current = null;
    markerRef.current = null;
    if (route) useCommentDictationPendingStore.getState().clearPending(route.draftId);
  }, []);

  const armHandoff = React.useCallback((route: CommentDictationRoute) => {
    routeRef.current = route;
    useCommentDictationPendingStore.getState().markPending(route.draftId);
    markerRef.current = {
      draftId: route.draftId,
      onEmpty: () => disarmHandoff(),
    };
  }, [disarmHandoff]);

  /** Finalize a busy session in the background; returns whether one was busy. */
  const confirmIfBusy = React.useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return false;
    const status = controller.getStatus();
    const isBusy = status === 'recording' || status === 'uploading';
    if (isBusy) controller.confirm();
    return isBusy;
  }, []);

  const handleTranscript = React.useCallback((spoken: string) => {
    const route = routeRef.current;
    if (route) {
      if (routeTranscriptToDraft(route, spoken) === 'refused') {
        toast.error(t('inlineComment.toast.noRoom'));
      }
      disarmHandoff();
      return;
    }
    onLocalTranscriptRef.current(spoken);
  }, [disarmHandoff, t]);

  const handleError = React.useCallback((error: Error) => {
    // While mounted the button's own failed view salvages and says it
    // failed; only an unmounted field routes here.
    if (mountedRef.current) return;
    const route = routeRef.current;
    if (!route) return;
    disarmHandoff();
    // Salvage whatever was transcribed before the failure, then say it failed.
    if (partialRef.current.trim()) {
      if (routeTranscriptToDraft(route, partialRef.current) === 'refused') {
        toast.error(t('inlineComment.toast.noRoom'));
      }
    }
    toast.error(t('chat.dictation.failed'), { description: error.message });
  }, [disarmHandoff, t]);

  const handleStatus = React.useCallback((status: DictationStatus) => {
    const isBusy = status === 'recording' || status === 'uploading';
    busyRef.current = isBusy;
    setBusy(isBusy);
  }, []);

  const handlePartialTranscript = React.useCallback((text: string) => {
    partialRef.current = text;
  }, []);

  return {
    /** Live busy flag for enabling attach on an empty field. */
    busy,
    confirmIfBusy,
    armHandoff,
    dictationProps: {
      onTranscript: handleTranscript,
      onError: handleError,
      onStatusChange: handleStatus,
      onPartialTranscript: handlePartialTranscript,
      controllerRef,
      handoffRef: markerRef,
    },
  };
}
