import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import type { User } from "../internal/discord.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
  shouldIgnoreStaleDiscordRouteBinding,
} from "./route-resolution.js";

let conversationRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>
  | undefined;

async function loadConversationRuntime() {
  conversationRuntimePromise ??= import("openclaw/plugin-sdk/conversation-binding-runtime");
  return await conversationRuntimePromise;
}

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
  const bindingConversationId = params.isDirectMessage
    ? (resolveDiscordConversationIdentity({
        isDirectMessage: true,
        userId: params.author.id,
      }) ?? `user:${params.author.id}`)
    : params.messageChannelId;
  let runtimeRoute = conversationRuntime.resolveRuntimeConversationBindingRoute({
    route,
    conversation: {
      channel: "discord",
      accountId: params.preflight.accountId,
      conversationId: bindingConversationId,
      parentConversationId: params.earlyThreadParentId,
    },
  });
  if (
    shouldIgnoreStaleDiscordRouteBinding({
      bindingRecord: runtimeRoute.bindingRecord,
      route,
    })
  ) {
    logVerbose(
      `discord: ignoring stale route binding for conversation ${bindingConversationId} (${runtimeRoute.bindingRecord?.targetSessionKey} -> ${route.sessionKey})`,
    );
    runtimeRoute = {
      bindingRecord: null,
      route,
    };
  }
  let threadBinding = runtimeRoute.bindingRecord ?? undefined;
  const configuredRoute =
    threadBinding == null
      ? conversationRuntime.resolveConfiguredBindingRoute({
          cfg: params.preflight.cfg,
          route,
          conversation: {
            channel: "discord",
            accountId: params.preflight.accountId,
            conversationId: params.messageChannelId,
            parentConversationId: params.earlyThreadParentId,
          },
        })
      : null;
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
