// Telegram plugin module implements conversation route behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
  type ConfiguredBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  resolveAgentRoute,
  resolveThreadSessionKeys,
  buildAgentMainSessionKey,
  sanitizeAgentId,
} from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  shouldUseTelegramDmThreadSession,
} from "./bot/helpers.js";
import {
  resolveTelegramDirectPeerId,
  resolveTelegramNamedAccountBaseSessionKey,
} from "./dm-session-key.js";

type TelegramResolvedRoute = ReturnType<typeof resolveAgentRoute>;
type ConfiguredTelegramBinding = NonNullable<ConfiguredBindingRouteResult["bindingResolution"]>;

type TelegramConversationBindingMode =
  | { kind: "none" }
  | {
      kind: "configured";
      binding: ConfiguredTelegramBinding;
      sessionKey: string;
    }
  | {
      kind: "runtime-bound";
      sessionKey: string;
    }
  | { kind: "plugin-owned-runtime" };

type TelegramConversationRouteResult = {
  route: TelegramResolvedRoute;
  bindingMode: TelegramConversationBindingMode;
};

export function resolveTelegramConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: number | string;
  isGroup: boolean;
  resolvedThreadId?: number;
  replyThreadId?: number;
  senderId?: string | number | null;
  topicAgentId?: string | null;
}): TelegramConversationRouteResult {
  const peerId = params.isGroup
    ? buildTelegramGroupPeerId(params.chatId, params.resolvedThreadId)
    : resolveTelegramDirectPeerId({ chatId: params.chatId, senderId: params.senderId });
  const parentPeer = buildTelegramParentPeer({
    isGroup: params.isGroup,
    resolvedThreadId: params.resolvedThreadId,
    chatId: params.chatId,
  });
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: peerId,
    },
    parentPeer,
  });

  const rawTopicAgentId = params.topicAgentId?.trim();
  if (rawTopicAgentId) {
    // Preserve the configured topic agent ID so topic-bound sessions stay stable
    // even when that agent is not present in the current config snapshot.
    const topicAgentId = sanitizeAgentId(rawTopicAgentId);
    const sessionKey = normalizeLowercaseStringOrEmpty(
      buildAgentSessionKey({
        agentId: topicAgentId,
        channel: "telegram",
        accountId: params.accountId,
        peer: { kind: params.isGroup ? "group" : "direct", id: peerId },
        dmScope: params.cfg.session?.dmScope,
        identityLinks: params.cfg.session?.identityLinks,
      }),
    );
    const mainSessionKey = normalizeLowercaseStringOrEmpty(
      buildAgentMainSessionKey({
        agentId: topicAgentId,
      }),
    );
    route = {
      ...route,
      agentId: topicAgentId,
      sessionKey,
      mainSessionKey,
      lastRoutePolicy: deriveLastRoutePolicy({
        sessionKey,
        mainSessionKey,
      }),
    };
    logVerbose(
      `telegram: topic route override: topic=${params.resolvedThreadId ?? params.replyThreadId} agent=${topicAgentId} sessionKey=${route.sessionKey}`,
    );
  }

  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route,
    conversation: {
      channel: "telegram",
      accountId: params.accountId,
      conversationId: peerId,
      parentConversationId: params.isGroup ? String(params.chatId) : undefined,
    },
  });
  route = configuredRoute.route;
  let bindingMode: TelegramConversationBindingMode = configuredRoute.bindingResolution
    ? {
        kind: "configured",
        binding: configuredRoute.bindingResolution,
        sessionKey: configuredRoute.boundSessionKey ?? route.sessionKey,
      }
    : { kind: "none" };

  const runtimeBindingConversationId =
    params.replyThreadId != null
      ? `${params.chatId}:topic:${params.replyThreadId}`
      : String(params.chatId);
  const runtimeRoute = resolveRuntimeConversationBindingRoute({
    route,
    conversation: {
      channel: "telegram",
      accountId: params.accountId,
      conversationId: runtimeBindingConversationId,
    },
  });
  route = runtimeRoute.route;
  if (runtimeRoute.bindingRecord) {
    bindingMode = runtimeRoute.boundSessionKey
      ? { kind: "runtime-bound", sessionKey: runtimeRoute.boundSessionKey }
      : { kind: "plugin-owned-runtime" };
    logVerbose(
      runtimeRoute.boundSessionKey
        ? `telegram: routed via bound conversation ${runtimeBindingConversationId} -> ${runtimeRoute.boundSessionKey}`
        : `telegram: plugin-bound conversation ${runtimeBindingConversationId}`,
    );
  }

  return {
    route,
    bindingMode,
  };
}

export function resolveTelegramConversationBaseSessionKey(
  params: Parameters<typeof resolveTelegramNamedAccountBaseSessionKey>[1],
): string {
  return resolveTelegramNamedAccountBaseSessionKey(
    resolveDefaultTelegramAccountId(params.cfg),
    params,
  );
}

export function resolveTelegramTargetSession(params: {
  cfg: OpenClawConfig;
  route: TelegramResolvedRoute;
  chatId: number | string;
  isGroup: boolean;
  senderId?: string | number | null;
  dmThreadId?: number;
  botHasTopicsEnabled?: boolean;
}): string {
  const baseSessionKey = resolveTelegramConversationBaseSessionKey(params);
  const threadKeys =
    shouldUseTelegramDmThreadSession({
      dmThreadId: params.dmThreadId,
      botHasTopicsEnabled: params.botHasTopicsEnabled,
    }) && params.dmThreadId != null
      ? resolveThreadSessionKeys({
          baseSessionKey,
          threadId: `${params.chatId}:${params.dmThreadId}`,
        })
      : null;
  return threadKeys?.sessionKey ?? baseSessionKey;
}
