import React from 'react';
import type { DictationOrigin } from '../../composer/state/useDictationOrigin';

import type { DictationStatus } from '@/hooks/useDictation';
import type { ComposerDictationController } from '@/components/dictation/ComposerDictation';

export function useComposerDictationState() {
    const dictationSendEndRef = React.useRef<(() => void) | null>(null);
    const dictationSendInFlightRef = React.useRef(false);
    const dictationOriginRef = React.useRef<DictationOrigin | null>(null);
    // A Send or Enter pressed during recording or transcription confirms the
    // dictation and queues the send: the transcript lands below and the
    // message goes out whole. The ref mirrors the state so the submit path
    // (which may run before the next render commits) reads the live value.
    const dictationControllerRef = React.useRef<ComposerDictationController | null>(null);
    const [dictationStatus, setDictationStatus] = React.useState<DictationStatus>('idle');
    const [dictationSendPending, setDictationSendPending] = React.useState(false);
    const dictationSendPendingRef = React.useRef(false);
    // A send already waiting for comment transcripts owns the wait; a second
    // press while it runs is redundant because the pending submit reads the
    // composer and drafts when it fires, not when it was pressed.
    const commentDictationWaitRef = React.useRef<Promise<'settled' | 'timeout'> | null>(null);
    // Cancel, discard, an unmount, or a confirmation that produced nothing
    // drops the queued send; a failure keeps it armed for retry.
    const handleDictationStatusChange = React.useCallback((status: DictationStatus) => {
        setDictationStatus(status);
        if (status === 'idle') {
            dictationSendPendingRef.current = false;
            setDictationSendPending(false);
        }
    }, []);

    return {
        dictationSendInFlightRef, dictationSendEndRef, dictationOriginRef,
        dictationControllerRef, dictationStatus, dictationSendPending, setDictationSendPending,
        dictationSendPendingRef, commentDictationWaitRef, handleDictationStatusChange,
    };
}
