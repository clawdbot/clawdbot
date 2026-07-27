import type { PluginHookReplyDispatchEvent } from "../../plugins/hook-types.js";

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
