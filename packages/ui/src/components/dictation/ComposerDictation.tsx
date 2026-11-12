/**
 * Composer dictation controls: a mic button for the composer footer plus a
 * compact inline status while dictation is active (recording, transcribing,
 * or failed). The editor stays mounted, visible and editable throughout:
 * recording and transcription never cover the field, the way the comment
 * dictation button already behaves.
 *
 * The transcript still arrives asynchronously after confirm; the host inserts
 * it inline. Only the salvage text of a failed dictation is rendered here.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useDictation, type DictationStatus } from '@/hooks/useDictation';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { DictationWaveform } from '@/components/dictation/DictationWaveform';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// One composer owns microphone capture and its keyboard confirmation in a window.
let recordingOwner: HTMLSpanElement | null = null;

/**
 * Imperative handle for the host's send path: a Send or Enter during
 * recording or transcription confirms the dictation for insert and queues
 * the send until the transcript lands, instead of sending without it.
 */
export interface ComposerDictationController {
    /** Finalize a live recording for insert; no-op unless recording. */
    confirmInsert: () => void;
    /** Live engine status without waiting for a render. */
    getStatus: () => DictationStatus;
}

interface ComposerDictationProps {
    isMobile: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    disabled?: boolean;
    onInsert: (text: string) => void;
    onInsertAndSend: (text: string) => void;
    /** Called once when a dictation leaves idle, before any transcript exists,
        so the host can record which draft the dictation belongs to. */
    onStart?: () => void;
    /** Called when the record-and-send button is pressed, before the async
        transcript resolves; the host holds the composer open until onInsert
        or onInsertAndSend settles. */
    onSendStart?: () => void;
    /** Reports whether dictation is active (recording/transcribing/failed). */
    onActiveChange?: (active: boolean) => void;
    /** Reports every engine status change, so the host can queue a send
        pressed mid-dictation until the transcript lands. Failed keeps a
        queued send armed for retry; idle drops it. */
    onStatusChange?: (status: DictationStatus) => void;
    /** Imperative handle for the host's send path (confirm for insert). */
    controllerRef?: React.RefObject<ComposerDictationController | null>;
    /** Render the mic trigger button (default). Pass false when the host renders
        its own trigger and only needs the engine + inline status. */
    renderTrigger?: boolean;
}

const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
};

/**
 * Polls the dictation status route while the local model is downloading and
 * returns the download percent (null while unknown / not downloading).
 */
const useModelDownloadProgress = (active: boolean): number | null => {
    const sttLocalModel = useConfigStore((state) => state.sttLocalModel);
    const [percent, setPercent] = React.useState<number | null>(null);

    React.useEffect(() => {
        if (!active) {
            setPercent(null);
            return;
        }
        let cancelled = false;
        const poll = async () => {
            try {
                const response = await runtimeFetch('/api/dictation/status', {
                    query: { provider: 'local', localModel: sttLocalModel },
                });
                if (!response.ok || cancelled) {
                    return;
                }
                const data = await response.json();
                // activeModel is the model the server dictates with, which
                // differs from the saved one when that left the catalog.
                const modelId = data?.activeModel ?? sttLocalModel;
                const model = Array.isArray(data?.models)
                    ? data.models.find((m: { id: string }) => m.id === modelId)
                    : null;
                if (!cancelled) {
                    setPercent(typeof model?.downloadProgress === 'number' ? model.downloadProgress : null);
                }
            } catch {
                // Display-only; keep the previous value.
            }
        };
        void poll();
        const interval = setInterval(() => {
            void poll();
        }, 2000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [active, sttLocalModel]);

    return active ? percent : null;
};

export const ComposerDictation: React.FC<ComposerDictationProps> = ({
    isMobile,
    footerIconButtonClass,
    iconSizeClass,
    disabled,
    onInsert,
    onInsertAndSend,
    onStart,
    onSendStart,
    onActiveChange,
    onStatusChange,
    controllerRef,
    renderTrigger = true,
}) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const dictationAutoSend = useConfigStore((state) => state.dictationAutoSend);
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const dictationShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_dictation', shortcutOverrides), '');
    // The dictation server (WebSocket + STT worker) lives in the OpenChamber
    // web server; the VS Code bridge has no server process for it.
    const [supported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());

    const pendingActionRef = React.useRef<'insert' | 'send' | null>(null);
    const composerMarkerRef = React.useRef<HTMLSpanElement | null>(null);
    const onInsertRef = React.useRef(onInsert);
    const onInsertAndSendRef = React.useRef(onInsertAndSend);
    React.useEffect(() => {
        onInsertRef.current = onInsert;
        onInsertAndSendRef.current = onInsertAndSend;
    }, [onInsert, onInsertAndSend]);

    const dictation = useDictation({
        onTranscript: (text) => {
            const action = pendingActionRef.current;
            pendingActionRef.current = null;
            if (action === 'send') {
                onInsertAndSendRef.current(text);
            } else {
                onInsertRef.current(text);
            }
        },
    });

    const {
        status,
        partialTranscript,
        subscribeLevel,
        duration,
        error,
        errorReason,
        startDictation,
        confirmDictation,
        cancelDictation,
        retryFailedDictation,
        acceptPartialTranscript,
        discardFailedDictation,
        getStatus,
    } = dictation;
    const recordingBlink = useWaitingBlink(status === 'recording');

    const isModelDownloading = status === 'recording' && errorReason === 'model_download_in_progress';
    const downloadPercent = useModelDownloadProgress(isModelDownloading);

    const statusRef = React.useRef(status);
    React.useLayoutEffect(() => {
        statusRef.current = status;
        if (status === 'idle' && recordingOwner === composerMarkerRef.current) {
            recordingOwner = null;
        }
    });

    const startRecording = React.useCallback(() => {
        if (!supported || !dictationEnabled || disabled || recordingOwner || statusRef.current !== 'idle') return;
        recordingOwner = composerMarkerRef.current;
        void startDictation();
    }, [supported, dictationEnabled, disabled, startDictation]);

    // The transcript arrives long after the start; report the start itself so
    // the host can keep the transcript with the draft that was on screen then.
    const onStartRef = React.useRef(onStart);
    React.useEffect(() => {
        onStartRef.current = onStart;
    }, [onStart]);
    const onSendStartRef = React.useRef(onSendStart);
    React.useEffect(() => {
        onSendStartRef.current = onSendStart;
    }, [onSendStart]);

    const confirmWith = React.useCallback((action: 'insert' | 'send') => {
        pendingActionRef.current = action;
        // Hold the mobile composer open until the asynchronous submit settles.
        if (action === 'send') {
            onSendStartRef.current?.();
        }
        void confirmDictation();
    }, [confirmDictation]);

    const wasIdleRef = React.useRef(true);
    React.useLayoutEffect(() => {
        const idle = status === 'idle';
        if (wasIdleRef.current && !idle) {
            onStartRef.current?.();
        }
        wasIdleRef.current = idle;
    }, [status]);

    // Layout effect on purpose: the host may expand/collapse the composer in
    // response, and that state change must land in the same paint as the
    // status (a plain effect painted one clipped frame of status content
    // inside the still-collapsed pill before the morph started).
    const onStatusChangeRef = React.useRef(onStatusChange);
    React.useEffect(() => {
        onStatusChangeRef.current = onStatusChange;
    }, [onStatusChange]);
    React.useLayoutEffect(() => {
        onActiveChange?.(status !== 'idle');
        onStatusChangeRef.current?.(status);
    }, [status, onActiveChange]);

    // Imperative handle for the host's send path (see ComposerDictationController).
    React.useEffect(() => {
        if (!controllerRef) return;
        controllerRef.current = {
            confirmInsert: () => confirmWith('insert'),
            getStatus,
        };
    });

    // Keyboard shortcut (toggle_dictation): idle -> start recording,
    // recording -> confirm. Dispatched by useKeyboardShortcuts.
    React.useEffect(() => {
        if (!supported || !dictationEnabled) return;
        const marker = composerMarkerRef.current;
        const onToggle = (event: Event) => {
            const requestedForm = (event as CustomEvent<{ composer?: HTMLFormElement }>).detail?.composer;
            if (requestedForm && (!marker || !requestedForm.contains(marker))) return;
            const targetForm = requestedForm
                ?? document.activeElement?.closest('form')
                ?? Array.from(document.querySelectorAll('[data-composer-dictation]'))
                    .find((element) => !element.closest('[data-chat-column="pinned"]'))?.closest('form');
            if (recordingOwner ? recordingOwner !== marker : !marker || !targetForm?.contains(marker)) return;
            event.stopImmediatePropagation();
            if (statusRef.current === 'idle') {
                startRecording();
            } else if (statusRef.current === 'recording') {
                confirmWith(dictationAutoSend ? 'send' : 'insert');
            }
        };
        window.addEventListener('openchamber:dictation-toggle', onToggle);
        return () => window.removeEventListener('openchamber:dictation-toggle', onToggle);
    }, [supported, dictationEnabled, startRecording, confirmWith, dictationAutoSend]);

    React.useEffect(() => {
        const marker = composerMarkerRef.current;
        return () => {
            if (recordingOwner === marker) recordingOwner = null;
            // An unmount abandons the stream: no transcript will arrive, so
            // report idle and let the host drop any queued send.
            if (statusRef.current !== 'idle') onStatusChangeRef.current?.('idle');
        };
    }, [supported, dictationEnabled]);

    if (!supported || !dictationEnabled) {
        return null;
    }

    const isActive = status !== 'idle';

    const retry = () => {
        pendingActionRef.current = 'insert';
        void retryFailedDictation();
    };

    // Dictation must not dismiss the soft keyboard: block the focus transfer
    // iOS performs on tap for the mic and every inline control (same pattern
    // as PermissionAutoAcceptButton).
    const keepKeyboardFocusProps = {
        onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
        onPointerDownCapture: (event: React.PointerEvent) => {
            if (event.pointerType === 'touch') {
                event.preventDefault();
            }
        },
    } as const;

    // Inline, next to the field: the editor stays visible and editable while
    // recording or transcribing, the way the comment dictation button works.
    // No overlay, no dialog, no Enter/Escape capture: typing, sending and
    // autocomplete keep working; confirmation and cancellation are explicit
    // through these controls and the toggle shortcut.
    const renderStatus = () => {
        if (status === 'recording') {
            return (
                <span
                    role="status"
                    aria-label={t('chat.dictation.listening')}
                    className="flex min-w-0 items-center gap-x-1.5"
                >
                    <span className="relative ms-0.5 flex size-1.5 shrink-0" aria-hidden="true">
                        <span
                            className={cn('relative inline-flex size-1.5 rounded-full', recordingBlink)}
                            style={{ backgroundColor: currentTheme.colors.status.error }}
                        />
                    </span>
                    {isModelDownloading ? (
                        <span className="typography-meta min-w-0 truncate" style={{ color: currentTheme.colors.surface.mutedForeground }}>
                            {downloadPercent !== null
                                ? t('chat.dictation.downloadingModelProgress', { percent: String(downloadPercent) })
                                : t('chat.dictation.downloadingModel')}
                        </span>
                    ) : (
                        <>
                            <DictationWaveform subscribeLevel={subscribeLevel} className="block h-4 w-12 shrink-0" />
                            <span className="typography-meta shrink-0 tabular-nums" style={{ color: currentTheme.colors.surface.mutedForeground }}>
                                {formatDuration(duration)}
                            </span>
                        </>
                    )}
                    {error && !isModelDownloading ? (
                        <span className="typography-meta min-w-0 truncate" style={{ color: currentTheme.colors.status.warning }}>
                            {error}
                        </span>
                    ) : null}
                </span>
            );
        }
        if (status === 'uploading') {
            return (
                <span
                    role="status"
                    aria-label={t('chat.dictation.processing')}
                    className="flex min-w-0 items-center gap-x-1.5"
                >
                    <Icon name="loader-4" className="h-4 w-4 shrink-0 animate-spin" style={{ color: currentTheme.colors.surface.mutedForeground }} />
                    <span className="typography-meta min-w-0 truncate" style={{ color: currentTheme.colors.surface.mutedForeground }}>
                        {t('chat.dictation.processing')}
                    </span>
                </span>
            );
        }
        // Failed: salvage text stays inline in the footer flow, beside the
        // retry/discard/insert actions. The composer itself never grows for it.
        return (
            <span role="alert" className="flex min-w-0 items-center gap-x-1.5">
                <span className="typography-meta min-w-0 truncate" style={{ color: currentTheme.colors.status.error }}>
                    {error || t('chat.dictation.failed')}
                </span>
                {partialTranscript.trim() ? (
                    <span
                        className="typography-meta min-w-0 max-w-24 truncate sm:max-w-40"
                        style={{ color: currentTheme.colors.surface.mutedForeground }}
                        title={partialTranscript.trim()}
                    >
                        {partialTranscript.trim()}
                    </span>
                ) : null}
            </span>
        );
    };

    const renderActions = () => {
        if (status === 'recording') {
            // One send button only: the composer's own. Dictation confirms
            // with insert; record-and-send stays on the toggle shortcut when
            // auto-send is on. The editor and the composer send keep working
            // throughout the recording.
            return (
                <span className={cn('flex shrink-0 items-center', isMobile ? 'gap-x-1' : 'gap-x-1.5')}>
                    <button
                        type="button"
                        {...keepKeyboardFocusProps}
                        className={cn(footerIconButtonClass, 'text-muted-foreground hover:text-foreground')}
                        onClick={() => {
                            void cancelDictation();
                        }}
                        title={t('chat.dictation.cancel')}
                        aria-label={t('chat.dictation.cancel')}
                    >
                        <Icon name="close" className={iconSizeClass} />
                    </button>
                    <button
                        type="button"
                        {...keepKeyboardFocusProps}
                        className={footerIconButtonClass}
                        onClick={() => confirmWith('insert')}
                        title={t('chat.dictation.insert')}
                        aria-label={t('chat.dictation.insert')}
                    >
                        <Icon name="check" className={iconSizeClass} />
                    </button>
                </span>
            );
        }
        if (status === 'uploading') {
            return (
                <span className="flex shrink-0 items-center">
                    <button
                        type="button"
                        {...keepKeyboardFocusProps}
                        className={cn(footerIconButtonClass, 'text-muted-foreground hover:text-foreground')}
                        onClick={() => {
                            void cancelDictation();
                        }}
                        title={t('chat.dictation.cancel')}
                        aria-label={t('chat.dictation.cancel')}
                    >
                        <Icon name="close" className={iconSizeClass} />
                    </button>
                </span>
            );
        }
        return (
            <span className={cn('flex shrink-0 items-center', isMobile ? 'gap-x-1' : 'gap-x-1.5')}>
                <button
                    type="button"
                    {...keepKeyboardFocusProps}
                    className={cn(footerIconButtonClass, 'text-muted-foreground hover:text-foreground')}
                    onClick={discardFailedDictation}
                    title={t('chat.dictation.discard')}
                    aria-label={t('chat.dictation.discard')}
                >
                    <Icon name="close" className={iconSizeClass} />
                </button>
                <button
                    type="button"
                    {...keepKeyboardFocusProps}
                    className={footerIconButtonClass}
                    onClick={retry}
                    title={t('chat.dictation.retry')}
                    aria-label={t('chat.dictation.retry')}
                >
                    <Icon name="refresh" className={iconSizeClass} />
                </button>
                {partialTranscript.trim() ? (
                    <button
                        type="button"
                        {...keepKeyboardFocusProps}
                        className={footerIconButtonClass}
                        onClick={() => {
                            pendingActionRef.current = 'insert';
                            acceptPartialTranscript();
                        }}
                        title={t('chat.dictation.insert')}
                        aria-label={t('chat.dictation.insert')}
                    >
                        <Icon name="check" className={iconSizeClass} />
                    </button>
                ) : null}
            </span>
        );
    };

    return (
        <>
            <span ref={composerMarkerRef} data-composer-dictation hidden />
            {renderTrigger ? (
                <Tooltip>
                <TooltipTrigger asChild>
                <button
                    type="button"
                    {...keepKeyboardFocusProps}
                    className={footerIconButtonClass}
                    onClick={startRecording}
                    disabled={disabled || isActive}
                    aria-label={t('chat.dictation.start')}
                >
                    <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}><TooltipLabelWithShortcut label={t('chat.dictation.start')} shortcut={dictationShortcut} /></TooltipContent>
                </Tooltip>
            ) : null}
            {isActive ? (
                <span className="flex min-w-0 items-center gap-x-1.5" data-testid="composer-dictation-inline">
                    {renderStatus()}
                    {renderActions()}
                </span>
            ) : null}
        </>
    );
};
