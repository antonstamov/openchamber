import React, { useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { textareaCaretCoords } from '@/components/inline-picker/placement';
import { isPastedInput } from '@/components/inline-picker/useTextareaInlinePicker';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { useCommentImagePaste } from './useCommentImagePaste';
import { useCommentFieldPicker } from './useCommentFieldPicker';
import { useCommentEnterSubmit } from './useCommentEnterSubmit';
import { InlineDictationButton } from '@/components/dictation/InlineDictationButton';
import { useCommentDictationHandoff } from '@/components/dictation/useCommentDictationHandoff';
import type { InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { withInlineInsertionBoundaries } from '@/components/chat/composer/text';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestActions } from '@/hooks/useGuestSurfaces';
import { guestActionsWhere } from '@/lib/guests/actions';
import { runGuestAction } from '@/lib/guests/run-action';

export interface InlineCommentSaveOptions {
  /**
   * The field attached while dictation was busy: an empty text is a
   * placeholder for the late transcript, not a refusal reason.
   */
  allowEmptyPlaceholder?: boolean;
}

/** Where an attached comment landed: the handoff target for a late transcript. */
export interface InlineCommentSaveTarget {
  draftId: string;
  target: InlineCommentDraftTarget;
}

export interface InlineCommentInputProps {
  initialText?: string;
  onTextChange?: (text: string) => void;
  /**
   * False keeps the field open with its text: the save did not land. A save
   * target lets an attach-while-busy route the late transcript into the draft
   * after this field unmounts.
   */
  onSave: (text: string, range?: { start: number; end: number; side?: 'additions' | 'deletions' }, options?: InlineCommentSaveOptions) => InlineCommentSaveTarget | boolean | void;
  onCancel: () => void;
  fileLabel?: string;
  lineRange?: { start: number; end: number; side?: 'additions' | 'deletions' };
  isEditing?: boolean;
  className?: string;
  maxWidth?: number;
  bandColor?: string;
  floating?: boolean;
  band?: boolean;
  wholeFile?: boolean;
  saveLabel?: string;
  saving?: boolean;
  review?: {
    add: (text: string, range?: { start: number; end: number; side?: 'additions' | 'deletions' }) => Promise<boolean>;
    suggestionCode?: () => string;
  };
}

const MAX_FIELD_HEIGHT_PX = 120;
const baseName = (path: string) => path.split('/').pop() || path;

export function InlineCommentInput({
  initialText = '',
  onTextChange,
  onSave,
  onCancel,
  fileLabel,
  lineRange,
  isEditing = false,
  className,
  maxWidth,
  bandColor,
  floating = false,
  band = true,
  wholeFile = false,
  saveLabel,
  saving = false,
  review,
}: InlineCommentInputProps) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const lineActions = guestActionsWhere(useGuestActions(), 'diff');
  const [text, setText] = React.useState(initialText);
  const [addingToReview, setAddingToReview] = React.useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveShortcut = formatShortcutForDisplay('enter');
  void isEditing;

  const appendTranscript = (spoken: string) => {
    const trimmed = spoken.trim();
    if (!trimmed) return;
    const field = textareaRef.current;
    const base = field?.value ?? text;
    const from = field?.selectionStart ?? base.length;
    const to = field?.selectionEnd ?? from;
    const insert = withInlineInsertionBoundaries(trimmed, base.slice(0, from), base.slice(to));
    replaceRange(from, to, insert);
  };

  // Dictation handoff: attaching while the session is busy closes the field at
  // once; the late transcript lands in the attached draft (see onSave's save
  // target) instead of being lost with the unmount.
  const {
    busy: dictationBusy,
    confirmIfBusy: confirmDictationIfBusy,
    armHandoff,
    dictationProps,
  } = useCommentDictationHandoff({ onLocalTranscript: appendTranscript });

  const resizeTextarea = () => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_FIELD_HEIGHT_PX)}px`;
  };

  const handleTextChange = (value: string) => {
    setText(value);
    onTextChange?.(value);
  };

  React.useLayoutEffect(resizeTextarea, [text]);

  const stableRangeRef = useRef(lineRange);
  useEffect(() => {
    if (lineRange) {
      stableRangeRef.current = lineRange;
    }
  }, [lineRange]);

  const normalizeRange = (range?: { start: number; end: number; side?: 'additions' | 'deletions' }) => {
    if (!range) return undefined;
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    return { ...range, start, end };
  };

  const displayRange = normalizeRange(lineRange);
  const rangeLabel = wholeFile
    ? t('inlineComment.range.wholeFile')
    : !displayRange ? null
    : displayRange.start === displayRange.end
      ? t('review.range.line', { line: displayRange.start })
      : t('inlineComment.range.lines', { start: displayRange.start, end: displayRange.end });
  const ariaLabel = [
    fileLabel,
    displayRange ? t('inlineComment.range.lines', { start: displayRange.start, end: displayRange.end }) : null,
  ].filter(Boolean).join(' • ') || t('inlineComment.actions.comment');

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
    if (isMobile) textarea.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [isMobile]);

  const imagePaste = useCommentImagePaste();
  const pendingCaretRef = useRef<number | null>(null);
  React.useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [text]);

  const replaceRange = (from: number, to: number, insert: string) => {
    const current = textareaRef.current?.value ?? text;
    pendingCaretRef.current = from + insert.length;
    handleTextChange(`${current.slice(0, from)}${insert}${current.slice(to)}`);
    textareaRef.current?.focus();
  };

  const getCaret = React.useCallback(() => textareaRef.current?.selectionStart ?? 0, []);
  const caretCoords = React.useCallback((position: number) => (textareaRef.current ? textareaCaretCoords(textareaRef.current, position) : null), []);
  const fieldPicker = useCommentFieldPicker({ text, getCaret, replaceRange, caretCoords });
  const commentKeys = useCommentEnterSubmit();

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    const pasted = imagePaste.takePastedImages(event.clipboardData, field.value, {
      start: field.selectionStart,
      end: field.selectionEnd,
    });
    if (!pasted) return;
    event.preventDefault();
    replaceRange(pasted.from, pasted.to, pasted.insertion);
  };

  const save = () => {
    // Attaching never waits for dictation: a busy session is finalized in the
    // background and its late transcript is appended to the draft below.
    const busy = confirmDictationIfBusy();
    if (!busy && !text.trim()) return;
    if (saving) return;
    const result = onSave(text, normalizeRange(stableRangeRef.current), busy ? { allowEmptyPlaceholder: true } : undefined);
    if (result === false) return;
    if (busy) {
      if (result && typeof result === 'object') {
        armHandoff(result);
      } else {
        // A host that reports no draft leaves the late transcript nowhere to
        // land: keep the field open instead of losing it.
        return;
      }
    }
    void imagePaste.attachCitedImages(text);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isIMECompositionEvent(event)) return;
    if (fieldPicker.handleKeyDown(event)) return;
    if (event.key === 'Enter' && commentKeys.shouldSubmit(event)) {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  const addToReview = async () => {
    if (!review || !text.trim() || addingToReview) return;
    setAddingToReview(true);
    try {
      await review.add(text, normalizeRange(stableRangeRef.current));
    } finally {
      setAddingToReview(false);
    }
  };

  const suggestionCode = review?.suggestionCode;
  const insertSuggestion = () => {
    if (!suggestionCode) return;
    const field = textareaRef.current;
    const from = field?.selectionStart ?? text.length;
    const to = field?.selectionEnd ?? text.length;
    const lead = from > 0 && text[from - 1] !== '\n' ? '\n' : '';
    replaceRange(from, to, `${lead}\`\`\`suggestion\n${suggestionCode()}\n\`\`\`\n`);
  };

  const handleSaveClick = (e: React.MouseEvent | React.TouchEvent | React.PointerEvent) => {
    e.stopPropagation();
    save();
  };

  const compactAttach = isMobile && Boolean(suggestionCode) && !saveLabel;

  const commentContext = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
      {fileLabel ? <span className="min-w-0 truncate font-medium text-foreground" title={fileLabel}>{baseName(fileLabel)}</span> : null}
      {rangeLabel ? <span className="shrink-0 whitespace-nowrap">{rangeLabel}</span> : null}
    </span>
  );

  return (
    <div
      className={cn(
        'w-full max-w-[min(100%,calc(var(--oc-editor-width,100vw)-var(--oc-editor-gutter-width,0px)))] font-sans',
        !floating && band && 'oc-inline-comment-band px-3 py-2',
        className
      )}
      style={{
        maxWidth: maxWidth ? `${Math.max(200, Math.floor(maxWidth))}px` : undefined,
        backgroundColor: floating || !band ? undefined : bandColor,
      }}
      data-comment-input="true"
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div
        className={cn(
          'relative text-foreground',
          floating
            ? 'oc-glass-popover oc-glass-floating flex items-end gap-2 rounded-3xl py-1 pe-1 ps-4'
            : 'oc-raised oc-field rounded-lg bg-[var(--surface-elevated)]',
        )}
      >
        {fieldPicker.picker}
        {isMobile && !floating ? <div className="px-3 pt-2">{commentContext}</div> : null}
        <textarea
          ref={textareaRef}
          rows={floating ? 1 : 2}
          value={text}
          onChange={(event) => {
            handleTextChange(event.target.value);
            fieldPicker.sync(event.target.value, event.target.selectionStart, !isPastedInput(event.nativeEvent));
          }}
          onSelect={(event) => fieldPicker.sync(event.currentTarget.value, event.currentTarget.selectionStart, false)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          enterKeyHint={commentKeys.returnKeySends ? 'send' : undefined}
          placeholder={isMobile
            ? t('inlineComment.input.placeholderShort')
            : t('inlineComment.input.placeholder', { shortcut: saveShortcut })}
          aria-label={ariaLabel}
          spellCheck
          className={cn(
            'min-w-0 resize-none bg-transparent text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground',
            floating ? 'flex-1 py-1.5' : 'block w-full px-3 pb-1 pt-2',
            isMobile && 'text-base leading-6'
          )}
          style={{ minHeight: 0 }}
        />
        {floating ? (
          <>
          <InlineDictationButton
            {...dictationProps}
            disabled={saving || addingToReview}
            buttonClassName={cn(
              'mb-0.5 flex shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none',
              isMobile ? 'h-9 w-9' : 'h-8 w-8'
            )}
            iconClassName="h-4 w-4"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleSaveClick}
                onPointerDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                disabled={!text.trim() && !dictationBusy}
                className={cn(
                  'mb-0.5 flex shrink-0 items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--primary-foreground)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-40',
                  isMobile ? 'h-9 w-9' : 'h-8 w-8'
                )}
                aria-label={t('inlineComment.actions.comment')}
              >
                <Icon name="attachment-2" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t('inlineComment.actions.comment')}</TooltipContent>
          </Tooltip>
          </>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5 pb-1.5 pe-1.5 ps-3">
            {isMobile ? null : commentContext}
            <div className={isMobile ? 'flex flex-1 flex-wrap items-center justify-end gap-1.5' : 'contents'}>
            {fileLabel && lineRange ? lineActions.map((entry) => {
              const runLineAction = () => void runGuestAction(entry, {
                kind: 'diff',
                action: entry.action.id,
                directory: resolveEffectiveDirectory() || null,
                path: fileLabel,
                startLine: lineRange.start,
                endLine: lineRange.end,
                ...(lineRange.side ? { side: lineRange.side } : {}),
              }, t);
              return isMobile ? (
                <Button key={`${entry.guest.id}:${entry.action.id}`} type="button" variant="ghost" size="sm" className="min-w-0 shrink gap-1.5 px-1.5 text-muted-foreground" onClick={runLineAction}>
                  <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="size-4 shrink-0" />
                  <span className="truncate">{entry.action.label}</span>
                </Button>
              ) : (
                <Tooltip key={`${entry.guest.id}:${entry.action.id}`}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground"
                      aria-label={entry.action.label}
                      onClick={runLineAction}
                    >
                      <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>{entry.action.label}</TooltipContent>
                </Tooltip>
              );
            }) : null}
            {suggestionCode && isMobile ? (
              <Button type="button" variant="ghost" size="sm" className="me-auto shrink-0 px-0 text-muted-foreground" onClick={insertSuggestion}>
                {t('review.action.suggest')}
              </Button>
            ) : suggestionCode ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" onClick={insertSuggestion} aria-label={t('review.action.suggest')}>
                    <Icon name="code-box" className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{t('review.action.suggest')}</TooltipContent>
              </Tooltip>
            ) : null}
            {review ? (
              <Button type="button" variant="outline" size={isMobile ? 'sm' : 'xs'} className="shrink-0" onClick={() => void addToReview()} disabled={!text.trim() || addingToReview}>
                {addingToReview ? <Spinner className="size-3.5" /> : null}
                {t('review.action.addToReview')}
              </Button>
            ) : null}
            <InlineDictationButton
              {...dictationProps}
              disabled={saving || addingToReview}
              buttonClassName="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none disabled:opacity-40"
              iconClassName="size-4"
            />
            <Button
              type="button"
              size={compactAttach ? 'icon' : isMobile ? 'sm' : 'xs'}
              className="shrink-0"
              aria-label={saveLabel ?? t('review.action.attach')}
              onClick={handleSaveClick}
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              disabled={(!text.trim() && !dictationBusy) || saving}
            >
              {saving ? <Spinner className="size-3.5" /> : saveLabel ? null : <Icon name="attachment-2" className="size-3.5" />}
              {compactAttach ? null : saveLabel ?? t('review.action.attach')}
              {isMobile ? null : <span className="text-[0.6875rem] opacity-70">{saveShortcut}</span>}
            </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
