// Packed Plugin Sdk Type Smoke script supports OpenClaw repository automation.
import {
  inspectConversationBinding,
  type ConversationBindingInspection,
} from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
type PublicPluginSdkModules = [
  typeof import("openclaw/plugin-sdk/core"),
  typeof import("openclaw/plugin-sdk/channel-entry-contract"),
  typeof import("openclaw/plugin-sdk/config-contracts"),
  typeof import("openclaw/plugin-sdk/plugin-entry"),
  typeof import("openclaw/plugin-sdk/runtime-env"),
];

const resolvedModules = null as unknown as PublicPluginSdkModules;
const routeOwnerResolver: NonNullable<ChannelMessagingAdapter["resolveConversationRouteOwner"]> = ({
  accountId,
  conversation,
}) => {
  const inspection: ConversationBindingInspection = inspectConversationBinding({
    channel: "fixture-channel",
    accountId,
    conversationId: conversation.target ?? conversation.peerId,
  });
  return inspection.status === "unavailable" ? { kind: "unavailable" } : undefined;
};

void resolvedModules;
void routeOwnerResolver;
