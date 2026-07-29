/**
 * Channel inbound event classifier.
 *
 * Decides whether group/channel activity should wake the agent or remain a passive room event.
 */
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationFacts } from "../turn/types.js";
import type { InboundEventKind } from "./kind.js";

/**
 * Facts needed to classify whether inbound room activity should wake the agent.
 */
export type ClassifyChannelInboundEventParams = {
  conversation: Pick<ConversationFacts, "kind">;
  unmentionedGroupPolicy?: InboundEventKind;
  wasMentioned?: boolean;
  hasControlCommand?: boolean;
  hasAbortRequest?: boolean;
  commandSource?: "native" | "text";
};

/**
 * Classifies an inbound channel event as an actionable request or passive room event.
 */
export function classifyChannelInboundEvent(
  params: ClassifyChannelInboundEventParams,
): InboundEventKind {
  if (params.unmentionedGroupPolicy !== "room_event") {
    return "user_request";
  }
  if (params.conversation.kind !== "group" && params.conversation.kind !== "channel") {
    return "user_request";
  }
  // Native commands, mentions, control commands, and aborts are explicit user intent even when
  // unmentioned group traffic would otherwise be treated as passive room activity.
  if (
    params.wasMentioned === true ||
    params.hasControlCommand === true ||
    params.hasAbortRequest === true ||
    params.commandSource === "native"
  ) {
    return "user_request";
  }
  return "room_event";
}

/**
 * Resolves the configured policy for unmentioned group/channel inbound events.
 */
export function resolveUnmentionedGroupInboundPolicy(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): InboundEventKind {
  const agentGroupChat = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.groupChat
    : undefined;
  if (agentGroupChat && Object.hasOwn(agentGroupChat, "unmentionedInbound")) {
    return agentGroupChat.unmentionedInbound ?? "user_request";
  }
  return params.cfg.messages?.groupChat?.unmentionedInbound ?? "user_request";
}
