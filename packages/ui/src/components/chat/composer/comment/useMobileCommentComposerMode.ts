
import React from 'react';
import { flushSync } from 'react-dom';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

import type { MobileComposerShell } from '../state/useMobileComposerShell';
import { useMobileCommentComposerController, useMobileCommentDraft } from './MobileCommentComposerContext';
import type { MobileCommentComposerHandlers } from './MobileCommentComposer';
import type { MobileCommentAttachPlan, MobileCommentScope } from './mobileCommentDraft';

export interface MobileCommentModeOptions {
    isMobile: boolean;
    runtimeKey: string;
    directory: string | null;
    sessionKey: string | null;
    mobileShell: MobileComposerShell;
}

export interface MobileCommentMode {
    active: boolean;
    draft: ReturnType<typeof useMobileCommentDraft>;
    handlers: MobileCommentComposerHandlers;
    submit(): void;
    /** The shell's handoff-aware attach; the form submit delegates to it so a
     * busy dictation takes the same route as the attach button. */
    shellAttachRef: React.MutableRefObject<(() => MobileCommentAttachPlan | null) | null>;
}

export function useMobileCommentComposerMode(options: MobileCommentModeOptions): MobileCommentMode {
    const { isMobile, runtimeKey, directory, sessionKey, mobileShell } = options;
    const { t } = useI18n();
    const controller = useMobileCommentComposerController();
    const draft = useMobileCommentDraft(controller);
    const active = isMobile && draft.status === 'open';

    const scope = React.useMemo<MobileCommentScope | null>(
        () => (!runtimeKey || !directory || !sessionKey
            ? null
            : { runtimeKey, directory, sessionKey }),
        [directory, runtimeKey, sessionKey],
    );
    React.useLayoutEffect(() => {
        controller?.setScope(scope);
        return () => controller?.setScope(null);
    }, [controller, scope]);

    const prevActiveRef = React.useRef(false);
    React.useEffect(() => {
        if (active && !prevActiveRef.current && mobileShell.dictationActive) {
            mobileShell.onDictationActiveChange(false);
        }
        prevActiveRef.current = active;
    }, [active, mobileShell]);

    // Attach inside the tap: expand() flushes the shell swap and focuses the
    // restored composer in the same call stack, as iOS requires for the soft
    // keyboard. A stale or scope-mismatched open restores nothing.
    // `onStored` runs after the draft is written but before the shell closes,
    // so an attach-while-busy can arm its dictation handoff while the engine
    // is still mounted.
    const attach = React.useCallback((generation: number, text?: string, onStored?: (plan: MobileCommentAttachPlan) => void) => {
        if (!controller) return null;
        let plan: MobileCommentAttachPlan | null = null;
        flushSync(() => {
            plan = (text === undefined
                ? controller.attach(generation, onStored)
                : controller.insertAndAttach(text, generation, onStored));
        });
        if (plan) {
            mobileShell.expand();
        } else {
            const open = controller.getState();
            if (open.status === 'open' && open.generation === generation) {
                toast.error(t('inlineComment.toast.noRoom'));
            }
        }
        return plan;
    }, [controller, mobileShell, t]);

    const cancel = React.useCallback((generation: number) => {
        if (!controller) return;
        let closed = false;
        flushSync(() => {
            closed = controller.cancel(generation);
        });
        if (closed) mobileShell.expand();
    }, [controller, mobileShell]);

    // The shell registers its handoff-aware attach (confirm + arm around the
    // raw attach above); the form submit delegates to it so both paths share
    // one route. Without a shell (or before it registers) fall back to raw.
    const shellAttachRef = React.useRef<(() => MobileCommentAttachPlan | null) | null>(null);
    const submit = React.useCallback(() => {
        if (shellAttachRef.current) {
            shellAttachRef.current();
            return;
        }
        if (!controller) return;
        const open = controller.getState();
        if (open.status === 'open') attach(open.generation);
    }, [attach, controller]);

    const handlers = React.useMemo<MobileCommentComposerHandlers>(() => {
        if (draft.status !== 'open') {
            const noop = () => undefined;
            const noopAttach = () => null;
            return {
                onTextChange: noop,
                onCancel: noop,
                onAttach: noopAttach,
                onDictationInsert: noop,
                onDictationInsertAndSend: noopAttach,
                onEditorFocus: noop,
                onEditorBlur: noop,
                onDictationActiveChange: noop,
            };
        }
        const generation = draft.generation;
        return {
            onTextChange: (text) => controller?.setText(text, generation),
            onCancel: () => cancel(generation),
            onAttach: (onStored) => attach(generation, undefined, onStored),
            onDictationInsert: (text) => controller?.insertText(text, generation),
            onDictationInsertAndSend: (text, onStored) => attach(generation, text, onStored),
            onEditorFocus: mobileShell.onEditorFocus,
            onEditorBlur: mobileShell.onEditorBlur,
            onDictationActiveChange: mobileShell.onDictationActiveChange,
        };
    }, [attach, cancel, controller, draft, mobileShell]);

    return { active, draft, handlers, submit, shellAttachRef };
}
