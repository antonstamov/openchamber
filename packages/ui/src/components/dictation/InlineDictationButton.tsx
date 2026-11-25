/**
 * Dictation for a plain text field outside the composer (project notes and
 * todos): a mic button that turns into discard/insert while recording and a
 * spinner while the server transcribes. The transcript goes to `onTranscript`;
 * the host decides where it lands in its field.
 *
 * Unlike ComposerDictation there is no global shortcut: the
 * toggle_dictation shortcut belongs to the chat composer, and a second listener
 * would start two recordings from one key press.
 *
 * Two modes: with `fieldKey`/`panelKey` the recording is hosted by
 * FieldDictationHost, so it survives the field's panel closing; without them
 * the button owns its session directly and supports the attach-while-busy
 * handoff (controllerRef/handoffRef/onStatusChange) into comment drafts.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { DictationWaveform } from '@/components/dictation/DictationWaveform';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { useDictation, type DictationCompletionHandoff, type DictationStatus } from '@/hooks/useDictation';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { cancelFieldDictation, finishFieldDictation, startFieldDictation, useFieldRecording } from '@/lib/dictation/fieldDictation';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';

interface InlineDictationButtonProps {
  /** Field-dictation mode: shared recording hosted by FieldDictationHost. */
  fieldKey?: string;
  panelKey?: string;
  onTranscript: (text: string) => void;
  disabled?: boolean;
  buttonClassName: string;
  iconClassName?: string;
  /** Reports failures, so a host can salvage a transcript after its field closed. */
  onError?: (error: Error) => void;
  /**
   * Reports every status change, so a host attaching while busy can finalize
   * the session and arm a handoff into the attached draft instead of losing
   * the transcript.
   */
  onStatusChange?: (status: DictationStatus) => void;
  /** Latest partial transcript; salvage for a failure after the field closed. */
  onPartialTranscript?: (text: string) => void;
  /**
   * Imperative handle for attach-while-busy: `confirm` finalizes a recording
   * in the background, `getStatus` reads the live status without a render.
   */
  controllerRef?: React.RefObject<InlineDictationController | null>;
  /** Armed at attach-while-busy; keeps the stream past this button's unmount. */
  handoffRef?: React.RefObject<DictationCompletionHandoff | null>;
}

export interface InlineDictationController {
  confirm: () => void;
  cancel: () => void;
  getStatus: () => DictationStatus;
}

const FieldInlineDictationButton: React.FC<{
  fieldKey: string;
  panelKey: string;
  onTranscript: (text: string) => void;
  disabled?: boolean;
  buttonClassName: string;
  iconClassName?: string;
}> = ({
  fieldKey,
  panelKey,
  onTranscript,
  disabled,
  buttonClassName,
  iconClassName = 'h-4 w-4',
}) => {
  const { t } = useI18n();
  const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
  const [supported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());

  const recording = useFieldRecording(fieldKey);
  const { status, error, errorReason, duration, partialTranscript } = recording?.view
    ?? { status: 'idle', error: null, errorReason: null, duration: 0, partialTranscript: '' };
  const actions = recording?.actions;

  const recordingBlink = useWaitingBlink(status === 'recording');

  if (!supported || (!dictationEnabled && !recording)) {
    return null;
  }

  if (status === 'uploading') {
    return (
      <span role="status" className="inline-flex min-w-0 items-center gap-1.5 typography-meta text-muted-foreground">
        <Icon name="loader-4" className={cn(iconClassName, 'shrink-0 animate-spin')} />
        <span className="truncate">{t('chat.dictation.processing')}</span>
      </span>
    );
  }

  if (status === 'recording') {
    const downloadingModel = errorReason === 'model_download_in_progress';
    return (
      <>
        <span role="status" aria-label={t('chat.dictation.listening')} className="inline-flex min-w-0 items-center gap-1.5">
          <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
            <span className={cn('relative inline-flex size-1.5 rounded-full bg-[var(--status-error)]', recordingBlink)} />
          </span>
          {downloadingModel ? (
            <span className="truncate typography-meta text-muted-foreground">{t('chat.dictation.downloadingModel')}</span>
          ) : (
            actions ? <DictationWaveform subscribeLevel={actions.subscribeLevel} className="block h-4 w-12 min-w-0" /> : null
          )}
          <span className="shrink-0 tabular-nums typography-meta text-muted-foreground">
            {`${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`}
          </span>
        </span>
        <ButtonTooltip label={t('chat.dictation.cancel')} className="shrink-0">
          <button
            type="button"
            onClick={() => cancelFieldDictation(fieldKey)}
            className={buttonClassName}
            aria-label={t('chat.dictation.cancel')}
          >
            <Icon name="close" className={iconClassName} />
          </button>
        </ButtonTooltip>
        <ButtonTooltip label={t('chat.dictation.insert')} className="shrink-0">
          <button
            type="button"
            onClick={() => finishFieldDictation(fieldKey)}
            className={cn(buttonClassName, 'text-primary hover:text-primary')}
            aria-label={t('chat.dictation.insert')}
          >
            <Icon name="check" className={iconClassName} />
          </button>
        </ButtonTooltip>
      </>
    );
  }

  if (status === 'failed') {
    const failedActions: Array<{ key: string; label: string; icon: IconName; run: () => void }> = [
      { key: 'discard', label: t('chat.dictation.discard'), icon: 'close', run: () => actions?.discardFailedDictation() },
      { key: 'retry', label: t('chat.dictation.retry'), icon: 'refresh', run: () => void actions?.retryFailedDictation() },
    ];
    if (partialTranscript.trim()) {
      failedActions.push({ key: 'insert', label: t('chat.dictation.insert'), icon: 'check', run: () => { actions?.acceptPartialTranscript(); } });
    }
    return (
      <>
        <span role="status" title={error ?? undefined} className="min-w-0 truncate typography-meta text-[var(--status-error-text)]">
          {t('chat.dictation.failed')}
        </span>
        {failedActions.map(({ key, label, icon, run }) => (
          <ButtonTooltip key={key} label={label} className="shrink-0">
            <button type="button" onClick={run} className={buttonClassName} aria-label={label}>
              <Icon name={icon} className={iconClassName} />
            </button>
          </ButtonTooltip>
        ))}
      </>
    );
  }

  return (
    <ButtonTooltip label={t('chat.dictation.start')} className="shrink-0">
      <button
        type="button"
        onClick={() => startFieldDictation({ fieldKey, panelKey, insert: onTranscript })}
        disabled={disabled}
        className={buttonClassName}
        aria-label={t('chat.dictation.start')}
      >
        <Icon name="mic" className={iconClassName} />
      </button>
    </ButtonTooltip>
  );
};

const LegacyInlineDictationButton: React.FC<{
  onTranscript: (text: string) => void;
  disabled?: boolean;
  buttonClassName: string;
  iconClassName?: string;
  onError?: (error: Error) => void;
  onStatusChange?: (status: DictationStatus) => void;
  onPartialTranscript?: (text: string) => void;
  controllerRef?: React.RefObject<InlineDictationController | null>;
  handoffRef?: React.RefObject<DictationCompletionHandoff | null>;
}> = ({
  onTranscript,
  disabled,
  buttonClassName,
  onError,
  onStatusChange,
  onPartialTranscript,
  controllerRef,
  handoffRef,
  iconClassName = 'h-4 w-4',
}) => {
  const { t } = useI18n();
  const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
  const [supported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());

  const onTranscriptRef = React.useRef(onTranscript);
  React.useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const {
    status,
    error,
    errorReason,
    duration,
    subscribeLevel,
    partialTranscript,
    startDictation,
    confirmDictation,
    cancelDictation,
    discardFailedDictation,
    getStatus,
  } = useDictation({
    onTranscript: (text) => {
      if (text.trim()) onTranscriptRef.current(text.trim());
    },
    onError: (error) => onErrorRef.current?.(error),
    handoffRef,
  });

  const onStatusChangeRef = React.useRef(onStatusChange);
  React.useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);
  React.useEffect(() => {
    onStatusChangeRef.current?.(status);
  }, [status]);

  const onPartialTranscriptRef = React.useRef(onPartialTranscript);
  React.useEffect(() => {
    onPartialTranscriptRef.current = onPartialTranscript;
  }, [onPartialTranscript]);
  React.useEffect(() => {
    onPartialTranscriptRef.current?.(partialTranscript);
  }, [partialTranscript]);

  React.useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      confirm: () => void confirmDictation(),
      cancel: () => void cancelDictation(),
      getStatus,
    };
  });

  React.useEffect(() => {
    if (status !== 'failed') return;
    const salvage = partialTranscript.trim();
    if (salvage) onTranscriptRef.current(salvage);
    toast.error(t('chat.dictation.failed'), error ? { description: error } : undefined);
    discardFailedDictation();
  }, [discardFailedDictation, error, partialTranscript, status, t]);

  const recordingBlink = useWaitingBlink(status === 'recording');

  if (!supported || !dictationEnabled) {
    return null;
  }

  if (status === 'uploading') {
    return (
      <span role="status" className="inline-flex min-w-0 items-center gap-1.5 typography-meta text-muted-foreground">
        <Icon name="loader-4" className={cn(iconClassName, 'shrink-0 animate-spin')} />
        <span className="truncate">{t('chat.dictation.processing')}</span>
      </span>
    );
  }

  if (status === 'recording') {
    const downloadingModel = errorReason === 'model_download_in_progress';
    return (
      <>
        <span role="status" aria-label={t('chat.dictation.listening')} className="inline-flex min-w-0 items-center gap-1.5">
          <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
            <span className={cn('relative inline-flex size-1.5 rounded-full bg-[var(--status-error)]', recordingBlink)} />
          </span>
          {downloadingModel ? (
            <span className="truncate typography-meta text-muted-foreground">{t('chat.dictation.downloadingModel')}</span>
          ) : (
            <DictationWaveform subscribeLevel={subscribeLevel} className="block h-4 w-12 min-w-0" />
          )}
          <span className="shrink-0 tabular-nums typography-meta text-muted-foreground">
            {`${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`}
          </span>
        </span>
        <ButtonTooltip label={t('chat.dictation.cancel')} className="shrink-0">
          <button
            type="button"
            onClick={() => void cancelDictation()}
            className={buttonClassName}
            aria-label={t('chat.dictation.cancel')}
          >
            <Icon name="close" className={iconClassName} />
          </button>
        </ButtonTooltip>
        <ButtonTooltip label={t('chat.dictation.insert')} className="shrink-0">
          <button
            type="button"
            onClick={() => void confirmDictation()}
            className={cn(buttonClassName, 'text-primary hover:text-primary')}
            aria-label={t('chat.dictation.insert')}
          >
            <Icon name="check" className={iconClassName} />
          </button>
        </ButtonTooltip>
      </>
    );
  }

  return (
    <ButtonTooltip label={t('chat.dictation.start')} className="shrink-0">
      <button
        type="button"
        onClick={() => void startDictation()}
        disabled={disabled}
        className={buttonClassName}
        aria-label={t('chat.dictation.start')}
      >
        <Icon name="mic" className={iconClassName} />
      </button>
    </ButtonTooltip>
  );
};

export const InlineDictationButton: React.FC<InlineDictationButtonProps> = (props) => {
  const { fieldKey, panelKey, ...rest } = props;
  if (fieldKey !== undefined && panelKey !== undefined) {
    return (
      <FieldInlineDictationButton
        fieldKey={fieldKey}
        panelKey={panelKey}
        onTranscript={rest.onTranscript}
        disabled={rest.disabled}
        buttonClassName={rest.buttonClassName}
        iconClassName={rest.iconClassName}
      />
    );
  }
  return <LegacyInlineDictationButton {...rest} />;
};
