import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import type { AssistantPhase } from "../shared/chat-message-content.js";
import "./embedded-agent-subscribe.handlers.messages.js";
import type { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.handlers.types.js";

type AssistantStreamDataParams = {
  text?: string;
  delta?: string;
  replace?: boolean;
  mediaUrls?: string[];
  mediaUrl?: string;
  phase?: AssistantPhase;
  itemId?: string;
};

type AssistantStreamData = {
  text: string;
  delta: string;
  replace?: true;
  mediaUrls?: string[];
  phase?: AssistantPhase;
  itemId?: string;
};

type EmbeddedSubscribeMessagesTestApi = {
  buildAssistantStreamData(params: AssistantStreamDataParams): AssistantStreamData;
  recordPendingAssistantReplyDirectives(
    state: Pick<EmbeddedAgentSubscribeState, "pendingAssistantReplyDirectives">,
    parsed: ReplyDirectiveParseResult | null | undefined,
  ): void;
  resolveSilentReplyFallbackText(params: {
    text: unknown;
    messagingToolSentTexts: string[];
  }): string;
};

function getTestApi(): EmbeddedSubscribeMessagesTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedSubscribeMessagesTestApi")
  ];
  if (!api) {
    throw new Error("embedded subscribe messages test API is unavailable");
  }
  return api as EmbeddedSubscribeMessagesTestApi;
}

export function buildAssistantStreamData(params: AssistantStreamDataParams): AssistantStreamData {
  return getTestApi().buildAssistantStreamData(params);
}

export function recordPendingAssistantReplyDirectives(
  state: Pick<EmbeddedAgentSubscribeState, "pendingAssistantReplyDirectives">,
  parsed: ReplyDirectiveParseResult | null | undefined,
): void {
  getTestApi().recordPendingAssistantReplyDirectives(state, parsed);
}

export function resolveSilentReplyFallbackText(params: {
  text: unknown;
  messagingToolSentTexts: string[];
}): string {
  return getTestApi().resolveSilentReplyFallbackText(params);
}
