import { afterEach, describe, expect, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { routeTranscriptToDraft } from '@/components/dictation/commentDictationHandoff';
import { useCommentDictationPendingStore } from '@/stores/useCommentDictationPendingStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import {
    applyMobileCommentAttach,
    createMobileCommentDraftController,
    type MobileCommentAttachPlan,
} from '../mobileCommentDraft';

const scope = () => ({
    runtimeKey: getRuntimeKey(),
    directory: '/repo/main',
    sessionKey: 'session-1',
});

const quote = () => ({
    plainText: 'plain selection',
    markdownText: '**plain selection**',
    messageId: 'msg_1' as string | null,
});

const openDraft = () => {
    const controller = createMobileCommentDraftController();
    controller.setScope(scope());
    if (!controller.open(quote())) throw new Error('open rejected');
    return controller;
};

const targetOf = (plan: MobileCommentAttachPlan) => plan.target;

afterEach(() => {
    useInlineCommentDraftStore.setState({ drafts: {} });
    useCommentDictationPendingStore.setState({ pending: {} });
});

describe('mobile attach-while-busy handoff', () => {
    test('a new attach reports its draft id before the shell closes', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');

        let seenOpenInsideCallback = false;
        let stored: MobileCommentAttachPlan | null = null;
        const plan = controller.attach(open.generation, (storedPlan) => {
            stored = storedPlan;
            // The shell is still open here, so the dictation engine is still
            // mounted and the handoff keeps its stream instead of cancelling it.
            seenOpenInsideCallback = controller.getState().status === 'open';
        });

        expect(plan).not.toBeNull();
        expect(stored).not.toBeNull();
        expect(seenOpenInsideCallback).toBe(true);
        expect(plan?.draftId).toBeTruthy();
        expect((stored as unknown as MobileCommentAttachPlan)?.draftId).toBe(plan?.draftId);
        expect(controller.getState().status).toBe('closed');
    });

    test('a late transcript lands in the attached empty draft', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');

        let stored: MobileCommentAttachPlan | null = null;
        const plan = controller.attach(open.generation, (storedPlan) => {
            stored = storedPlan;
            if (storedPlan.draftId) useCommentDictationPendingStore.getState().markPending(storedPlan.draftId);
        });
        if (!plan?.draftId) throw new Error('expected draft id');

        expect(useInlineCommentDraftStore.getState().getDrafts(targetOf(plan))[0]?.text).toBe('');
        expect(routeTranscriptToDraft({ target: targetOf(plan), draftId: plan.draftId }, 'hello there')).toBe('appended');
        expect(useInlineCommentDraftStore.getState().getDrafts(targetOf(plan))[0]?.text).toBe('hello there ');
        expect(useCommentDictationPendingStore.getState().pending[plan.draftId]).toBeUndefined();
        expect((stored as MobileCommentAttachPlan | null)?.draftId).toBe(plan.draftId);
    });

    test('recording and transcribing both route: text typed before attach is kept', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('typed', open.generation);

        const plan = controller.attach(open.generation, (storedPlan) => {
            if (storedPlan.draftId) useCommentDictationPendingStore.getState().markPending(storedPlan.draftId);
        });
        if (!plan?.draftId) throw new Error('expected draft id');

        expect(routeTranscriptToDraft({ target: targetOf(plan), draftId: plan.draftId }, 'spoken')).toBe('appended');
        expect(useInlineCommentDraftStore.getState().getDrafts(targetOf(plan))[0]?.text).toBe('typed spoken ');
    });

    test('an edit attach routes to the same draft', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('first', open.generation);
        const first = controller.attach(open.generation);
        if (!first?.draftId) throw new Error('expected first draft id');
        const [draft] = useInlineCommentDraftStore.getState().getDrafts(targetOf(first));

        const editQuote = { plainText: draft.code, markdownText: draft.code, messageId: null };
        if (!controller.openEdit({ target: targetOf(first), draftId: draft.id, quote: editQuote, text: draft.text })) {
            throw new Error('openEdit rejected');
        }
        const editing = controller.getState();
        if (editing.status !== 'open') throw new Error('expected open');
        let stored: MobileCommentAttachPlan | null = null;
        const plan = controller.attach(editing.generation, (storedPlan) => {
            stored = storedPlan;
        });
        expect(plan?.draftId).toBe(draft.id);
        expect((stored as MobileCommentAttachPlan | null)?.draftId).toBe(draft.id);
    });

    test('parallel busy attaches stay separate', () => {
        const firstController = openDraft();
        const firstOpen = firstController.getState();
        if (firstOpen.status !== 'open') throw new Error('expected open');
        const first = firstController.attach(firstOpen.generation, (storedPlan) => {
            if (storedPlan.draftId) useCommentDictationPendingStore.getState().markPending(storedPlan.draftId);
        });
        if (!first?.draftId) throw new Error('expected first id');

        const secondController = openDraft();
        const secondOpen = secondController.getState();
        if (secondOpen.status !== 'open') throw new Error('expected open');
        // Same target: a second quote while the first transcript is in flight.
        const second = secondController.attach(secondOpen.generation, (storedPlan) => {
            if (storedPlan.draftId) useCommentDictationPendingStore.getState().markPending(storedPlan.draftId);
        });
        if (!second?.draftId) throw new Error('expected second id');
        expect(second.draftId).not.toBe(first.draftId);

        expect(routeTranscriptToDraft({ target: targetOf(second), draftId: second.draftId }, 'second')).toBe('appended');
        expect(routeTranscriptToDraft({ target: targetOf(first), draftId: first.draftId }, 'first')).toBe('appended');
        const texts = useInlineCommentDraftStore.getState().getDrafts(targetOf(first)).map((draft) => draft.text);
        expect(texts).toContain('first ');
        expect(texts).toContain('second ');
        expect(useCommentDictationPendingStore.getState().pending).toEqual({});
    });

    test('a refused attach never arms: the shell stays open', () => {
        const target = { directory: '/repo/main', sessionKey: 'session-1' };
        useInlineCommentDraftStore.getState().addDraft(target, {
            source: 'chat-quote', fileLabel: '', startLine: 1, endLine: 1,
            code: 'x'.repeat(800_000), language: '', text: '',
        });
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('y'.repeat(300_000), open.generation);

        let storedCalls = 0;
        expect(controller.attach(open.generation, () => { storedCalls += 1; })).toBeNull();
        expect(storedCalls).toBe(0);
        expect(controller.getState().status).toBe('open');
    });

    test('applyMobileCommentAttach returns the draft id', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('note', open.generation);
        const plan = controller.attach(open.generation);
        if (!plan?.draftId) throw new Error('expected draft id');
        expect(applyMobileCommentAttach({
            scope: scope(),
            target: plan.target,
            draftId: plan.draftId,
            draft: { source: 'chat-quote', fileLabel: '', startLine: 1, endLine: 1, code: 'q', language: '', text: 'updated' },
        })).toBe(plan.draftId);
    });
});
