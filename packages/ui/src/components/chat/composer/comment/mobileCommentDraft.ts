
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInlineCommentDraftStore, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { appendInlineText } from '../text';

export interface MobileCommentScope {
    runtimeKey: string;
    directory: string;
    sessionKey: string;
}

export interface MobileCommentQuote {
    plainText: string;
    markdownText: string;
    messageId: string | null;
    anchor?: ChatQuoteAnchor | null;
}

export type MobileCommentDraft =
    | { status: 'closed' }
    | {
        status: 'open';
        scope: MobileCommentScope;
        quote: MobileCommentQuote;
        text: string;
        generation: number;
        draftId?: string;
    };

export interface MobileCommentAttachPlan {
    scope: MobileCommentScope;
    target: InlineCommentDraftTarget;
    draftId?: string;
    draft: {
        source: 'chat-quote';
        fileLabel: string;
        startLine: number;
        endLine: number;
        code: string;
        language: string;
        text: string;
        anchor?: ChatQuoteAnchor;
    };
}

export const CLOSED_MOBILE_COMMENT_DRAFT: MobileCommentDraft = { status: 'closed' };

export const mobileCommentQuotePreview = (plainText: string): string =>
    plainText.trim();

export const isSameMobileCommentScope = (a: MobileCommentScope, b: MobileCommentScope): boolean =>
    a.runtimeKey === b.runtimeKey && a.directory === b.directory && a.sessionKey === b.sessionKey;

export interface MobileCommentDraftController {
    getState(): MobileCommentDraft;
    subscribe(listener: () => void): () => void;
    setScope(scope: MobileCommentScope | null): void;
    getScope(): MobileCommentScope | null;
    open(quote: MobileCommentQuote): boolean;
    openEdit(edit: { target: InlineCommentDraftTarget; draftId: string; quote: MobileCommentQuote; text: string }): boolean;
    cancel(generation?: number): boolean;
    setText(text: string, generation: number): void;
    insertText(text: string, generation: number): void;
    /**
     * Store the open comment exactly once and close only after acceptance.
     * Rejection returns null and preserves the comment for editing or retry.
     * `onStored` runs after the draft is written but before the shell closes,
     * so an attach-while-busy can arm its dictation handoff while the engine
     * is still mounted; the unmount then keeps the stream instead of
     * cancelling it.
     */
    attach(generation: number, onStored?: (plan: MobileCommentAttachPlan) => void): MobileCommentAttachPlan | null;
    /**
     * Dictation's insert-and-attach, atomic under one generation check: a
     * stale completion neither appends its text nor attaches the newer
     * comment that replaced the caller's.
     */
    insertAndAttach(text: string, generation: number, onStored?: (plan: MobileCommentAttachPlan) => void): MobileCommentAttachPlan | null;
}

export function createMobileCommentDraftController(): MobileCommentDraftController {
    let state: MobileCommentDraft = CLOSED_MOBILE_COMMENT_DRAFT;
    let scope: MobileCommentScope | null = null;
    let generation = 0;
    const listeners = new Set<() => void>();

    const update = (next: MobileCommentDraft) => {
        if (next === state) return;
        state = next;
        for (const listener of listeners) listener();
    };

    const planOf = (open: Extract<MobileCommentDraft, { status: 'open' }>): MobileCommentAttachPlan => ({
        scope: open.scope,
        target: { directory: open.scope.directory, sessionKey: open.scope.sessionKey },
        draftId: open.draftId,
        draft: {
            source: 'chat-quote',
            fileLabel: open.quote.messageId ?? '',
            startLine: 1,
            endLine: 1,
            code: open.quote.markdownText,
            language: '',
            text: open.text.trim(),
            anchor: open.quote.anchor ?? undefined,
        },
    });

    const canOpen = (current: MobileCommentScope | null): current is MobileCommentScope =>
        Boolean(current && current.runtimeKey === getRuntimeKey() && current.directory && current.sessionKey);

    const attachInner = (atGeneration: number, text?: string, onStored?: (plan: MobileCommentAttachPlan) => void): MobileCommentAttachPlan | null => {
        if (state.status !== 'open' || state.generation !== atGeneration) return null;
        if (!scope || scope.runtimeKey !== getRuntimeKey() || !isSameMobileCommentScope(scope, state.scope)) {
            update(CLOSED_MOBILE_COMMENT_DRAFT);
            return null;
        }
        const pending = text === undefined ? state : { ...state, text: appendInlineText(state.text, text) };
        const plan = planOf(pending);
        if (plan.draftId && !useInlineCommentDraftStore.getState().getDrafts(plan.target).some((draft) => draft.id === plan.draftId)) {
            update(CLOSED_MOBILE_COMMENT_DRAFT);
            return null;
        }
        const storedId = applyMobileCommentAttach(plan);
        if (!storedId) {
            update(pending);
            return null;
        }
        const storedPlan = storedId === plan.draftId ? plan : { ...plan, draftId: storedId };
        onStored?.(storedPlan);
        update(CLOSED_MOBILE_COMMENT_DRAFT);
        return storedPlan;
    };

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        setScope(nextScope) {
            scope = nextScope;
            if (state.status === 'open' && (!scope || !isSameMobileCommentScope(state.scope, scope))) {
                update(CLOSED_MOBILE_COMMENT_DRAFT);
            }
        },
        getScope: () => scope,
        open(quote) {
            if (!canOpen(scope)) return false;
            if (!quote.markdownText.trim()) return false;
            generation += 1;
            update({ status: 'open', scope, quote, text: '', generation });
            return true;
        },
        openEdit({ target, draftId, quote, text }) {
            if (!canOpen(scope)) return false;
            if (target.directory !== scope.directory || target.sessionKey !== scope.sessionKey) return false;
            generation += 1;
            update({ status: 'open', scope, quote, text, generation, draftId });
            return true;
        },
        cancel(atGeneration) {
            if (state.status !== 'open') return false;
            if (atGeneration !== undefined && state.generation !== atGeneration) return false;
            update(CLOSED_MOBILE_COMMENT_DRAFT);
            return true;
        },
        setText(text, atGeneration) {
            if (state.status !== 'open' || state.generation !== atGeneration) return;
            if (state.text === text) return;
            update({ ...state, text });
        },
        insertText(text, atGeneration) {
            if (state.status !== 'open' || state.generation !== atGeneration) return;
            const next = appendInlineText(state.text, text);
            if (next === state.text) return;
            update({ ...state, text: next });
        },
        attach: (generation, onStored) => attachInner(generation, undefined, onStored),
        insertAndAttach(text, atGeneration, onStored) {
            return attachInner(atGeneration, text, onStored);
        },
    };
}

/**
 * Write an attach plan into the inline comment draft store. The runtime is
 * verified against the scope captured at open: the store keys by the CURRENT
 * runtime, so a plan from before a runtime switch must be dropped, not filed
 * under the new runtime's namespace. Directory and session are written exactly
 * as captured from the visible composer. An edit plan updates only the text.
 * Returns the draft id the transcript handoff routes to, or null when refused.
 */
export function applyMobileCommentAttach(plan: MobileCommentAttachPlan): string | null {
    if (plan.scope.runtimeKey !== getRuntimeKey()) return null;
    const store = useInlineCommentDraftStore.getState();
    if (plan.draftId) return store.updateDraft(plan.target, plan.draftId, { text: plan.draft.text }) ? plan.draftId : null;
    return store.addDraft(plan.target, plan.draft);
}
