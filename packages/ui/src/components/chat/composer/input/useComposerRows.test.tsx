import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SessionDoneHintRow } from '@/components/chat/SessionDoneHintRow';
import { useUIStore } from '@/stores/useUIStore';
import { useComposerRows } from './useComposerRows';

type Deps = Parameters<typeof useComposerRows>[0];
type Rows = ReturnType<typeof useComposerRows>;

const noop = (): void => undefined;

// SAFETY: test-only stub for the hook's plain-data dependencies. The behavior
// assertions below read the real hook output, so a renamed or added dependency
// fails at runtime instead of silently passing.
const makeDeps = (overrides?: { isBtwActive?: boolean; newSessionDraftOpen?: boolean }): Deps => ({
  props: { active: true },
  draftText: { setMessage: noop },
  editorState: { composerRef: React.createRef() },
  i18n: { t: (key: string) => key },
  preferences: { isMobile: false },
  mobileShell: {
    mobileComposerExpanded: false,
    mobileShell: {
      expanded: false,
      focused: false,
      overlayHostBusy: false,
      dictationActive: false,
      expand: noop,
      onDictationActiveChange: noop,
      holdDictationSend: noop,
      onEditorFocus: noop,
      onEditorBlur: noop,
      skipNextOverlayCloseRestore: noop,
      cancelOverlayCloseRestore: noop,
    },
  },
  inlineContext: { hasDrafts: false, inlineDraftTarget: null },
  referenceActions: { openAttachmentByName: noop },
  sendAvailability: { hasContent: false, pendingFirstSend: null },
  sessionScope: {
    newSessionDraftOpen: overrides?.newSessionDraftOpen ?? false,
    isBtwActive: overrides?.isBtwActive ?? false,
    isBtwPanelVisible: false,
    hasPendingForm: false,
    currentSessionId: 'session-1',
    currentSessionDirectoryForSync: null,
    currentDirectory: '/test',
    setReviewDialogOpen: noop,
    sessionFolder: { tracked: false, missing: false, confirmed: true, recheck: noop, markMissing: noop, clearSendMark: noop },
    trustPausedDirectory: null,
    btwComposerSessionId: null,
  },
  queueState: { queuedMessages: [], parentMessageQueueTarget: null },
  draftTarget: { showDraftTargetSelectors: false, messageWaitsForSpace: false },
  selection: { currentAgentName: undefined, effectiveBtwSelection: { agent: undefined, model: null, variant: undefined } },
  queueActions: { handleQueuedMessageEdit: noop, handleQueuedMessageSend: noop },
  sessionLifecycle: { sessionPhase: 'idle', handleOpenMobilePanel: noop },
  editorActions: { handleCycleThinking: noop, handleOpenThinkingPanel: noop, handleCycleAgent: noop },
  referencePicker: { handleOpenAgentPanel: noop },
} as Deps);

// SAFETY: the composer rows are plain elements, so the walk only reads their
// children. A row that stops being an element fails the validity check first.
const elementChildren = (element: React.ReactElement): React.ReactNode =>
  (element.props as { children?: React.ReactNode }).children;

const hasDoneHintRow = (node: React.ReactNode): boolean => {
  if (!React.isValidElement(node)) return false;
  if (node.type === SessionDoneHintRow) return true;
  return React.Children.toArray(elementChildren(node)).some(hasDoneHintRow);
};

describe('done hint row gate', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  const seen: Rows[] = [];
  let previousPreference = true;

  const Probe: React.FC<{ deps: Deps }> = ({ deps }) => {
    seen.push(useComposerRows(deps));
    return null;
  };

  const renderTopRows = async (deps: Deps): Promise<React.ReactNode> => {
    seen.length = 0;
    await act(async () => {
      root.render(<Probe deps={deps} />);
    });
    const rows = seen.at(-1);
    if (!rows) throw new Error('Probe did not run');
    return rows.composerTopRows;
  };

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    previousPreference = useUIStore.getState().sessionWorkDoneHintEnabled;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useUIStore.setState({ sessionWorkDoneHintEnabled: previousPreference });
    await windowInstance.happyDOM.close();
  });

  test('mounts the done hint row while the preference is on', async () => {
    useUIStore.setState({ sessionWorkDoneHintEnabled: true });
    expect(hasDoneHintRow(await renderTopRows(makeDeps()))).toBe(true);
  });

  test('omits the done hint row while the preference is off', async () => {
    useUIStore.setState({ sessionWorkDoneHintEnabled: false });
    expect(hasDoneHintRow(await renderTopRows(makeDeps()))).toBe(false);
  });

  test('keeps hiding the done hint row in BTW while the preference is on', async () => {
    useUIStore.setState({ sessionWorkDoneHintEnabled: true });
    expect(hasDoneHintRow(await renderTopRows(makeDeps({ isBtwActive: true })))).toBe(false);
  });
});
