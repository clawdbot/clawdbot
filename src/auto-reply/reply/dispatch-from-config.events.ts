import type { PluginHookReplyDispatchEvent } from "../../plugins/hook-types.js";
import type { CommandSessionMetadataChange } from "./command-session-metadata.js";
import type { ReplySessionBinding } from "./get-reply.types.js";

export type InternalReplyResolverOptions = {
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
};

export type PluginBindingTranscriptOwner = {
  agentId: string;
  expectedSessionId?: string;
  sessionKey: string;
  transcriptWriteBlocked?: true;
};

export function createReplyDispatchEvent(
  params: Omit<PluginHookReplyDispatchEvent, "shouldSendToolSummaries"> & {
    shouldSendToolSummaries: () => boolean;
  },
): PluginHookReplyDispatchEvent {
  const { shouldSendToolSummaries, ...event } = params;
  return Object.defineProperty(event, "shouldSendToolSummaries", {
    enumerable: true,
    get: shouldSendToolSummaries,
  }) as PluginHookReplyDispatchEvent;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.dispatchFromConfigTestApi")] = {
    createReplyDispatchEvent,
  };
}
