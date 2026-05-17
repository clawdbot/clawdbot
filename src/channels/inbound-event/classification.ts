import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationFacts } from "../turn/types.js";
import type { InboundEventKind } from "./kind.js";

export type ClassifyChannelInboundEventParams = {
  conversation: Pick<ConversationFacts, "kind">;
  unmentionedGroupPolicy?: InboundEventKind;
  wasMentioned?: boolean;
  hasControlCommand?: boolean;
  hasAbortRequest?: boolean;
  commandSource?: "native" | "text";
};

export function classifyChannelInboundEvent(
  params: ClassifyChannelInboundEventParams,
): InboundEventKind {
  if (params.unmentionedGroupPolicy !== "room_event") {
    return "user_request";
  }
  if (params.conversation.kind !== "group" && params.conversation.kind !== "channel") {
    return "user_request";
  }
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
