import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Message, Part, Session, SyntheticMessage, TextPart, UserMessage } from '@/lib/opencode/model';
import { CONTEXT_METADATA_KEY, readContextPart } from '@/lib/messages/contextParts';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { ChatColumnSessionContext } from '../chatColumnSession';
import type { BtwPanelState } from './useBtwPanelState';
import { BtwPanel } from './BtwPanel';
import { filterBtwTailMessages } from '@/lib/btw';
import { attachSyntheticContext } from '../lib/attachSyntheticContext';
import type { ChatMessageEntry } from '../lib/turns/types';

const SESSION = 'ses_fork';

const entry = (info: Message, parts: Part[] = []): ChatMessageEntry => ({ info, parts });

const textPart = (messageID: string, text: string): TextPart => ({
    id: `${messageID}-p`,
    sessionID: SESSION,
    messageID,
    type: 'text',
    text,
});

const userMessage = (id: string, text: string): ChatMessageEntry => {
    const info: UserMessage = { id, sessionID: SESSION, role: 'user', time: { created: 1 } };
    return entry(info, [textPart(id, text)]);
};

// An inline comment the composer attached, as the server echoes it: its own
// synthetic message right before the prompt.
const commentContext = (id: string): ChatMessageEntry => {
    const info: SyntheticMessage = {
        id,
        sessionID: SESSION,
        role: 'synthetic',
        time: { created: 1 },
        text: 'Comment on `app.ts` lines 1-2:\n```ts\nconst a = 1\n```\n\nwhy?',
        metadata: {
            [CONTEXT_METADATA_KEY]: {
                kind: 'code-comment',
                source: 'file',
                fileLabel: 'app.ts',
                startLine: 1,
                endLine: 2,
                language: 'ts',
                code: 'const a = 1',
                text: 'why?',
            },
        },
    };
    return entry(info);
};

// The BTW sheet shows the fork's tail (everything after the inherited-history
// boundary). The tail must fold the question's attached context back onto its
// prompt, the way the main transcript does: otherwise the sheet shows the
// prompt text alone while the same session opened on its own shows the quotes.
describe('btw tail context', () => {
    test('folds the fork question’s attached comments into its bubble', () => {
        const boundary = userMessage('u0', 'parent work');
        const context = commentContext('msg_1');
        const question = userMessage('msg_2', 'btw question');
        const records = [boundary, context, question];

        const tail = filterBtwTailMessages(records, boundary.info.id);
        expect(tail.map((record) => record.info.id)).toEqual(['msg_1', 'msg_2']);

        const folded = attachSyntheticContext(tail);
        expect(folded).toHaveLength(1);
        expect(folded[0]?.info.id).toBe('msg_2');
        expect(folded[0]?.parts).toHaveLength(2);
        expect(readContextPart(folded[0]!.parts[0]!)?.kind).toBe('code-comment');
        expect(folded[0]?.parts[1]).toBe(question.parts[0]!);
    });

    test('keeps inherited context out of the fold', () => {
        const inherited = commentContext('s0');
        const boundary = userMessage('u0', 'parent work');
        const context = commentContext('msg_1');
        const question = userMessage('msg_2', 'btw question');

        const folded = attachSyntheticContext(filterBtwTailMessages(
            [inherited, boundary, context, question],
            boundary.info.id,
        ));

        expect(folded).toHaveLength(1);
        expect(folded[0]?.info.id).toBe('msg_2');
        expect(folded[0]?.parts).toHaveLength(2);
    });
});

describe('btw sheet folding', () => {
    const PARENT_DIRECTORY = '/repo/chat';
    const FORK_DIRECTORY = '/repo/fork';
    const PARENT_ID = 'ses_parent';
    const FORK_ID = 'ses_fork';
    const BOUNDARY_ID = 'u0';
    const CONTEXT_ID = 'msg_1';
    const QUESTION_ID = 'msg_2';

    const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
    const theme = getDefaultTheme(false);
    const themeContext: ThemeContextValue = {
        currentTheme: theme,
        availableThemes: [theme],
        setTheme: unexpectedThemeChange,
        customThemesLoading: false,
        reloadCustomThemes: unexpectedThemeChange,
        importTheme: unexpectedThemeChange,
        deleteImportedTheme: unexpectedThemeChange,
        customThemeIds: [],
        isSystemPreference: false,
        setSystemPreference: unexpectedThemeChange,
        themeMode: 'light',
        setThemeMode: unexpectedThemeChange,
        lightThemeId: theme.metadata.id,
        darkThemeId: getDefaultTheme(true).metadata.id,
        setLightThemePreference: unexpectedThemeChange,
        setDarkThemePreference: unexpectedThemeChange,
    };

    const session: Session = {
        id: FORK_ID,
        parentID: PARENT_ID,
        projectID: 'project',
        directory: FORK_DIRECTORY,
        title: 'btw: question',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
    };

    const panel: BtwPanelState = {
        parentPromoted: false,
        btwSessionId: FORK_ID,
        btwDirectory: FORK_DIRECTORY,
        boundaryMessageID: BOUNDARY_ID,
        collapsed: false,
        creating: false,
        pending: false,
    };

    let happyWindow: Window;
    let previous: Array<readonly [string, PropertyDescriptor | undefined]>;
    let root: Root;
    let container: HTMLElement;

    beforeEach(() => {
        happyWindow = new Window({ url: 'http://localhost' });
        const globals = {
            window: happyWindow,
            document: happyWindow.document,
            navigator: happyWindow.navigator,
            localStorage: happyWindow.localStorage,
            customElements: happyWindow.customElements,
            Node: happyWindow.Node,
            Text: happyWindow.Text,
            NodeList: happyWindow.NodeList,
            Element: happyWindow.Element,
            HTMLElement: happyWindow.HTMLElement,
            SVGElement: happyWindow.SVGElement,
            Event: happyWindow.Event,
            CustomEvent: happyWindow.CustomEvent,
            MouseEvent: happyWindow.MouseEvent,
            requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
            cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
            getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
            ResizeObserver: happyWindow.ResizeObserver,
            MutationObserver: happyWindow.MutationObserver,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        previous = Object.keys(globals).map(
            (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
        );
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        }
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        await happyWindow.happyDOM.abort();
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    test('the sheet shows the question’s attached comment quotes', async () => {
        const sdk = OpenCode.make({
            baseUrl: 'http://localhost',
            fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
        });
        const tree = (
            <SyncProvider sdk={sdk} directory={PARENT_DIRECTORY}>
                <I18nProvider>
                    <ThemeSystemContext.Provider value={themeContext}>
                        <TooltipProvider>
                            <ChatColumnSessionContext.Provider value={{ sessionId: PARENT_ID, directory: PARENT_DIRECTORY }}>
                                <BtwPanel parentSessionId={PARENT_ID} panel={panel} hidden={false} onExit={() => {}} />
                            </ChatColumnSessionContext.Provider>
                        </TooltipProvider>
                    </ThemeSystemContext.Provider>
                </I18nProvider>
            </SyncProvider>
        );
        await act(async () => { root.render(tree); });

        const stores = getSyncChildStores();
        stores.ensureChild(PARENT_DIRECTORY, { bootstrap: false });
        const fork = stores.ensureChild(FORK_DIRECTORY, { bootstrap: false });
        const boundary: Message = { id: BOUNDARY_ID, sessionID: FORK_ID, role: 'user', time: { created: 1 } };
        const context: Message = {
            id: CONTEXT_ID,
            sessionID: FORK_ID,
            role: 'synthetic',
            time: { created: 1 },
            text: 'Comment on `app.ts` lines 1-2:\n```ts\nconst a = 1\n```\n\nwhy?',
            metadata: {
                [CONTEXT_METADATA_KEY]: {
                    kind: 'code-comment',
                    source: 'file',
                    fileLabel: 'app.ts',
                    startLine: 1,
                    endLine: 2,
                    language: 'ts',
                    code: 'const a = 1',
                    text: 'why?',
                },
            },
        };
        const question: Message = { id: QUESTION_ID, sessionID: FORK_ID, role: 'user', time: { created: 1 } };
        await act(async () => {
            fork.setState({
                session: [session],
                message: { [FORK_ID]: [boundary, context, question] },
                part: {
                    [BOUNDARY_ID]: [{ id: `${BOUNDARY_ID}-p`, sessionID: FORK_ID, messageID: BOUNDARY_ID, type: 'text', text: 'parent work' }],
                    [QUESTION_ID]: [{ id: `${QUESTION_ID}-p`, sessionID: FORK_ID, messageID: QUESTION_ID, type: 'text', text: 'btw question' }],
                },
            });
        });

        const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]:not([aria-haspopup])');
        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => { toggle?.click(); });

        const sheet = container.textContent ?? '';
        expect(sheet).toContain('btw question');
        expect(sheet).toContain('const a = 1');
        expect(sheet).toContain('why?');
    });
});
