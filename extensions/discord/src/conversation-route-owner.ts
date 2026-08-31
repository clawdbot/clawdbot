import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveThreadBindingSpawnPolicy } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveDiscordRuntimeBindingConversationId } from "./conversation-identity.js";
import { resolveDiscordConversationBindingRoute } from "./monitor/conversation-binding-route.js";
import { resolveDiscordConversationRoute } from "./monitor/route-resolution.js";

export function inspectDiscordConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    threadId?: string;
    nativeChannelId?: string;
    context?: {
      parentPeerId?: string;
      guildId?: string;
      memberRoleIds?: string[];
    };
  };
}) {
  const direct = params.conversation.kind === "direct";
  const nativeConversationId = params.conversation.nativeChannelId ?? params.conversation.peerId;
  const threadConversationId = direct ? undefined : params.conversation.threadId;
  const runtimeConversationId =
    threadConversationId ??
    resolveDiscordRuntimeBindingConversationId({
      isDirectMessage: direct,
      isGroupDm: params.conversation.kind === "group",
      userId: direct ? params.conversation.peerId : undefined,
      channelId: nativeConversationId,
    });
  const route = resolveDiscordConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId: params.conversation.context?.guildId,
    memberRoleIds: params.conversation.context?.memberRoleIds,
    peer: { kind: params.conversation.kind, id: params.conversation.peerId },
    parentConversationId: params.conversation.context?.parentPeerId,
  });
  const { runtimeRoute, configuredRoute } = resolveDiscordConversationBindingRoute({
    cfg: params.cfg,
    route,
    accountId: params.accountId,
    runtimeConversationId,
    configuredConversationId: threadConversationId ?? nativeConversationId,
    parentConversationId: params.conversation.context?.parentPeerId,
    touchBinding: false,
  });
  if (
    !runtimeRoute.bindingOwnerAvailable &&
    resolveThreadBindingSpawnPolicy({
      cfg: params.cfg,
      channel: "discord",
      accountId: params.accountId,
      kind: "subagent",
    }).enabled
  ) {
    return { kind: "unavailable" as const };
  }
  if (runtimeRoute.pluginId) {
    return {
      kind: "plugin" as const,
      pluginId: runtimeRoute.pluginId,
      fallbackAgentId: route.agentId,
    };
  }
  return {
    kind: "agent" as const,
    agentId: runtimeRoute.boundAgentId ?? configuredRoute?.boundAgentId ?? route.agentId,
  };
}
