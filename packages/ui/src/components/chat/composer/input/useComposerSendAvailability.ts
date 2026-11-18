import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDictationState } from './useComposerDictationState';
import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useBtwStore } from '@/stores/useBtwStore';
import { useIsPageWaiting } from '@/sync/global-blocking-requests';
import { selectComposerQueue } from '../../composer/submit/buildOutgoingMessage';

type Dependencies = {
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'hasText' | 'composerText'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'attachedFiles' | 'isBtwActive' | 'currentSessionId' | 'btwPanel'>;
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'hasDrafts'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'queuedMessages'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'sessionPhase'>;
    dictationState: Pick<ReturnType<typeof useComposerDictationState>, 'dictationStatus' | 'dictationSendPending'>;
};

export function useComposerSendAvailability({
    draftText, editorState, sessionScope, inlineContext, queueState, sessionLifecycle, dictationState,
}: Dependencies) {
    const { hasText, composerText } = draftText;
    const { composerRef } = editorState;
    const { attachedFiles, isBtwActive, currentSessionId, btwPanel } = sessionScope;
    const { hasDrafts } = inlineContext;
    const { queuedMessages } = queueState;
    const { sessionPhase } = sessionLifecycle;
    const { dictationStatus, dictationSendPending } = dictationState;

    const hasContent = hasText || attachedFiles.length > 0 || hasDrafts;

    const composerQueuedMessages = selectComposerQueue(queuedMessages);

    const hasQueuedMessages = !isBtwActive && composerQueuedMessages.length > 0;

    const preparingBtwSend = useBtwStore((state) => Boolean(currentSessionId && state.byParent[currentSessionId]?.pendingSend));

    const pendingFirstSend = useSessionUIStore((s) => (currentSessionId ? s.pendingDraftSends.get(currentSessionId) ?? null : null));

    // Recording or transcribing: Send and Enter confirm the dictation first,
    // so the button stays enabled even on an empty composer while busy, and
    // goes quiet while a confirmed send waits for its transcript.
    const dictationBusy = dictationStatus === 'recording' || dictationStatus === 'uploading';
    const canSend = (hasContent || hasQueuedMessages || dictationBusy) && !(isBtwActive && (btwPanel.creating || preparingBtwSend)) && !pendingFirstSend && !dictationSendPending;

    const canAbort = sessionPhase !== 'idle' && !pendingFirstSend;

    const isPageWaiting = useIsPageWaiting(currentSessionId);

    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = composerRef.current?.getValue() ?? composerText.get();
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || attachedFiles.length > 0 || hasDrafts,
        };
    }, [attachedFiles.length, composerText, hasDrafts, composerRef]);


    return {
        getCurrentInputSnapshot, pendingFirstSend,
        composerQueuedMessages, hasQueuedMessages, isPageWaiting, hasContent, canAbort, canSend,
    };
}
