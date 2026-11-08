import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n';
import type { AssistantMessage, ToolInput, ToolPart } from '@/lib/opencode/model';
import type { TrackedShell } from '@/sync/background-shells';
import type { ShellRowProps } from './BackgroundShellsStrip';
import type { ShellOriginLookup } from './backgroundShellOrigin';

const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: passthrough,
  TooltipContent: passthrough,
  TooltipTrigger: passthrough,
}));
mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

const { findShellToolOrigin } = await import('./backgroundShellOrigin');
const { ShellRow } = await import('./BackgroundShellsStrip');

describe('findShellToolOrigin', () => {
  const assistantMessage: AssistantMessage = {
    id: 'msg_1',
    sessionID: 'ses_root',
    role: 'assistant',
    time: { created: 1 },
    agent: 'build',
    providerID: 'p',
    modelID: 'm',
  };

  const toolPart = (input: ToolInput, shellID: string, messageID = 'msg_1'): ToolPart => ({
    id: `call_${shellID}`,
    sessionID: 'ses_root',
    messageID,
    type: 'tool',
    callID: `call_${shellID}`,
    tool: 'shell',
    state: {
      status: 'completed',
      input,
      output: 'ok',
      metadata: { status: 'running', shellID },
      time: { start: 1, end: 2 },
    },
  });

  const stateWith = (parts: readonly ToolPart[]): ShellOriginLookup => ({
    message: { ses_root: [assistantMessage] },
    part: { msg_1: parts },
  });

  test('returns the model description and the message holding the call', () => {
    const state = stateWith([toolPart({ command: 'bun run dev', description: 'Start the dev server' }, 'sh_1')]);
    expect(findShellToolOrigin(state, 'ses_root', 'sh_1')).toEqual({
      description: 'Start the dev server',
      messageID: 'msg_1',
    });
  });

  test('returns only the message when the call carries no description', () => {
    const state = stateWith([toolPart({ command: 'bun run dev' }, 'sh_1')]);
    expect(findShellToolOrigin(state, 'ses_root', 'sh_1')).toEqual({ messageID: 'msg_1' });
  });

  test('ignores blank descriptions and foreign shells', () => {
    const state = stateWith([
      toolPart({ command: 'bun run dev', description: '   ' }, 'sh_1'),
      toolPart({ command: 'other', description: 'Other' }, 'sh_other', 'msg_1'),
    ]);
    expect(findShellToolOrigin(state, 'ses_root', 'sh_1')).toEqual({ messageID: 'msg_1' });
    expect(findShellToolOrigin(state, 'ses_root', 'sh_missing')).toEqual({});
    expect(findShellToolOrigin(state, 'ses_other', 'sh_1')).toEqual({});
  });
});

describe('ShellRow origin UI', () => {
  const testShell: TrackedShell = {
    id: 'sh_1',
    sessionID: 'ses_root',
    command: 'bun run dev --port 5391',
    file: '/tmp/sh_1.out',
    startedAt: Date.now(),
    directory: '/repo',
    background: true,
  };

  const renderRow = async (props: Partial<ShellRowProps>) => {
    const windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <I18nProvider>
          <ShellRow shell={testShell} fromSubagent={false} stopping={false} onStop={() => {}} onGoTo={() => {}} {...props} />
        </I18nProvider>,
      );
    });
    return { windowInstance, host, root };
  };

  test('without an origin the row shows the command and no jump button', async () => {
    const { windowInstance, host, root } = await renderRow({});
    try {
      expect(host.textContent).toContain('bun run dev --port 5391');
      expect(host.querySelector('button[aria-label^="Go to message"]')).toBeNull();
      expect(host.textContent).not.toContain('Start the dev server');
    } finally {
      await act(async () => root.unmount());
      await windowInstance.happyDOM.close();
    }
  });

  test('with a description the tooltip shows it and the jump button works by mouse and keyboard', async () => {
    const windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let jumped: { shellID: string; messageID: string } | null = null;
    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <ShellRow
              shell={testShell}
              fromSubagent={false}
              stopping={false}
              onStop={() => {}}
              description="Start the dev server"
              messageID="msg_1"
              onGoTo={(target, messageID) => {
                jumped = { shellID: target.id, messageID };
              }}
            />
          </I18nProvider>,
        );
      });
      expect(host.textContent).toContain('Start the dev server');
      expect(host.textContent).toContain('bun run dev --port 5391');
      // SAFETY: The selector names a button, so a match is an HTML button element.
      const jump = host.querySelector('button[aria-label="Go to message for bun run dev --port 5391"]') as HTMLButtonElement | null;
      expect(jump).not.toBeNull();
      expect(jump!.tagName).toBe('BUTTON');
      expect(jump!.disabled).toBe(false);
      await act(async () => jump!.click());
      expect(jumped).toEqual({ shellID: 'sh_1', messageID: 'msg_1' });
      jumped = null;
      jump!.focus();
      expect(document.activeElement).toBe(jump);
      await act(async () => {
        jump!.click();
      });
      expect(jumped).toEqual({ shellID: 'sh_1', messageID: 'msg_1' });
    } finally {
      await act(async () => root.unmount());
      await windowInstance.happyDOM.close();
    }
  });
});
