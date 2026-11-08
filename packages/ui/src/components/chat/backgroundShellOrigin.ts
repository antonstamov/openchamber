import { readBackgroundShellID } from '@/lib/opencode/background-shell';
import { isShellTool } from '@/lib/opencode/tools';
import type { Message, Part } from '@/lib/opencode/model';

export type ShellOrigin = {
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
 * holds it: its message.
 *
 * Callers join the shell index (`shellID`, `sessionID` in
 * `@/sync/background-shells`) with the transcript: the `shell` tool part whose
 * metadata names the same `shellID`.
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
      return { messageID: part.messageID };
    }
  }
  return {};
};
