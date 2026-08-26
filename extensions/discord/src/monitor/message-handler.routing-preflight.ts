import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Discord plugin module implements message handler.routing preflight behavior.
import { resolveDiscordRuntimeBindingConversationId } from "../conversation-identity.js";
import type { User } from "../internal/discord.js";
import { resolveDiscordConversationBindingRoute } from "./conversation-binding-route.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";

const loadConversationRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/conversation-binding-runtime"),
);

export async function resolveDiscordPreflightRoute(params: {
  preflight: DiscordMessagePreflightParams;
  author: User;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  messageChannelId: string;
  memberRoleIds: string[];
  earlyThreadParentId?: string;
}) {
  const conversationRuntime = await loadConversationRuntime();
  const route = resolveDiscordConversationRoute({
    cfg: params.preflight.cfg,
    accountId: params.preflight.accountId,
    guildId: params.preflight.data.guild_id ?? undefined,
    memberRoleIds: params.memberRoleIds,
    peer: buildDiscordRoutePeer({
      isDirectMessage: params.isDirectMessage,
      isGroupDm: params.isGroupDm,
      directUserId: params.author.id,
      conversationId: params.messageChannelId,
    }),
    parentConversationId: params.earlyThreadParentId,
  });
  const bindingConversationId = resolveDiscordRuntimeBindingConversationId({
    isDirectMessage: params.isDirectMessage,
    isGroupDm: params.isGroupDm,
    userId: params.author.id,
    channelId: params.messageChannelId,
  });
  const { runtimeRoute, configuredRoute } = resolveDiscordConversationBindingRoute({
    cfg: params.preflight.cfg,
    route,
    accountId: params.preflight.accountId,
    runtimeConversationId: bindingConversationId,
    configuredConversationId: params.messageChannelId,
    parentConversationId: params.earlyThreadParentId,
  });
  let threadBinding = runtimeRoute.bindingRecord ?? undefined;
  const configuredBinding = configuredRoute?.bindingResolution ?? null;
  if (!threadBinding && configuredBinding) {
    threadBinding = configuredBinding.record;
  }
  const boundSessionKey = conversationRuntime.isPluginOwnedSessionBindingRecord(threadBinding)
    ? ""
    : (runtimeRoute.boundSessionKey ?? threadBinding?.targetSessionKey?.trim());
  const effectiveRoute = runtimeRoute.boundSessionKey
    ? runtimeRoute.route
    : resolveDiscordEffectiveRoute({
        route,
        boundSessionKey,
        configuredRoute,
        matchedBy: "binding.channel",
      });

  return {
    conversationRuntime,
    threadBinding,
    configuredBinding,
    boundSessionKey,
    effectiveRoute,
    boundAgentId: boundSessionKey ? effectiveRoute.agentId : undefined,
    baseSessionKey: effectiveRoute.sessionKey,
  };
}
