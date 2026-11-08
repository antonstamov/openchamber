import { readBackgroundShellID } from '@/lib/opencode/background-shell';
import { isShellTool, shellDescription } from '@/lib/opencode/tools';
import type { Message, Part } from '@/lib/opencode/model';

export type ShellOrigin = {
  /** The model's `input.description` on the tool call that started the command, when provided. */
  description?: string;
  /** The message that holds that tool call, for the existing message-link jump. */
  messageID?: string;
};

/**
 * The minimal transcript slice the origin join reads. `State` satisfies this;
 * tests build it directly without a full store.
 */
export type ShellOriginLookup = {
  message: Record<string, readonly Message[] | undefined>;
  part: Record<string, readonly Part[] | undefined>;
};

/**
 * The tool call that started one background command, if the loaded transcript
 * holds it: its human description and its message.
 *
 * A `shell.started` event carries no description, so callers join the shell
 * index (`shellID`, `sessionID` in `@/sync/background-shells`) with the
 * transcript: the completed `shell` tool part whose metadata names the same
 * `shellID`.
 */
export const findShellToolOrigin = (
  state: ShellOriginLookup,
  sessionID: string,
  shellID: string,
): ShellOrigin => {
  const messages = state.message[sessionID];
  if (!messages) return {};
  for (const message of messages) {
    const parts = state.part[message.id];
    if (!parts) continue;
    for (const part of parts) {
      if (part.type !== 'tool' || !isShellTool(part.tool)) continue;
      if (readBackgroundShellID(part) !== shellID) continue;
      const description = part.state.status === 'completed' || part.state.status === 'running'
        ? shellDescription(part.state.input)
        : undefined;
      return description ? { description, messageID: part.messageID } : { messageID: part.messageID };
    }
  }
  return {};
};
