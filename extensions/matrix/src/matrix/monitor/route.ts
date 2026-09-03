// Matrix plugin module implements route behavior.
import { resolveConfiguredAcpBindingRecord } from "openclaw/plugin-sdk/acp-binding-resolve-runtime";
import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/routing";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixThreadSessionKeys } from "./threads.js";

type MatrixResolvedRoute = ReturnType<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>;

function resolveMatrixDmSessionKey(params: {
  accountId: string;
  agentId: string;
  roomId: string;
  dmSessionScope?: "per-user" | "per-room";
  fallbackSessionKey: string;
}): string {
  if (params.dmSessionScope !== "per-room") {
    return params.fallbackSessionKey;
  }
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: "matrix",
    accountId: params.accountId,
    peer: {
      kind: "channel",
      id: params.roomId,
    },
  });
}

export function resolveMatrixInboundRoute(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  senderId: string;
  isDirectMessage: boolean;
  dmSessionScope?: "per-user" | "per-room";
  threadId?: string;
  resolveAgentRoute: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
}): {
  route: MatrixResolvedRoute;
  configuredBinding: ReturnType<typeof resolveConfiguredAcpBindingRecord>;
  bindingOwnerAvailable: boolean;
  runtimeBindingId: string | null;
  pluginId?: string;
} {
  const baseRoute = params.resolveAgentRoute({
    cfg: params.cfg,
    channel: "matrix",
    accountId: params.accountId,
    peer: {
      kind: params.isDirectMessage ? "direct" : "channel",
      id: params.isDirectMessage ? params.senderId : params.roomId,
    },
    // Matrix DMs are still sender-addressed first, but the room ID remains a
    // useful fallback binding key for generic route matching.
    parentPeer: params.isDirectMessage
      ? {
          kind: "channel",
          id: params.roomId,
        }
      : undefined,
  });
  const bindingConversationId = params.threadId ?? params.roomId;
  const bindingParentConversationId = params.threadId ? params.roomId : undefined;
  const bindingRef = {
    channel: "matrix",
    accountId: params.accountId,
    conversationId: bindingConversationId,
    parentConversationId: bindingParentConversationId,
  };
  const runtimeRoute = resolveRuntimeConversationBindingRoute({
    route: baseRoute,
    conversation: bindingRef,
    touchBinding: false,
  });
  const runtimeBinding = runtimeRoute.bindingRecord;

  if (runtimeBinding && runtimeRoute.boundSessionKey) {
    return {
      route: runtimeRoute.route,
      configuredBinding: null,
      bindingOwnerAvailable: true,
      runtimeBindingId: runtimeBinding.bindingId,
    };
  }

  const configuredBinding =
    runtimeBinding == null
      ? resolveConfiguredAcpBindingRecord({
          cfg: params.cfg,
          channel: "matrix",
          accountId: params.accountId,
          conversationId: bindingConversationId,
          parentConversationId: bindingParentConversationId,
        })
      : null;
  const configuredSessionKey = configuredBinding?.record.targetSessionKey?.trim();

  const effectiveRoute =
    configuredBinding && configuredSessionKey
      ? {
          ...baseRoute,
          sessionKey: configuredSessionKey,
          agentId: resolveAgentIdFromSessionKey(
            configuredSessionKey,
            configuredBinding.spec.agentId,
          ),
          lastRoutePolicy: deriveLastRoutePolicy({
            sessionKey: configuredSessionKey,
            mainSessionKey: baseRoute.mainSessionKey,
          }),
          matchedBy: "binding.channel" as const,
        }
      : baseRoute;

  const dmSessionKey =
    params.isDirectMessage && !configuredSessionKey
      ? resolveMatrixDmSessionKey({
          accountId: params.accountId,
          agentId: effectiveRoute.agentId,
          roomId: params.roomId,
          dmSessionScope: params.dmSessionScope,
          fallbackSessionKey: effectiveRoute.sessionKey,
        })
      : effectiveRoute.sessionKey;
  const routeWithDmScope =
    dmSessionKey === effectiveRoute.sessionKey
      ? effectiveRoute
      : {
          ...effectiveRoute,
          sessionKey: dmSessionKey,
          lastRoutePolicy: "session" as const,
        };

  // When no binding overrides the session key, isolate threads into their own sessions.
  if (!configuredBinding && !configuredSessionKey && params.threadId) {
    const threadKeys = resolveMatrixThreadSessionKeys({
      baseSessionKey: routeWithDmScope.sessionKey,
      threadId: params.threadId,
      parentSessionKey: routeWithDmScope.sessionKey,
    });
    return {
      route: {
        ...routeWithDmScope,
        sessionKey: threadKeys.sessionKey,
        mainSessionKey: threadKeys.parentSessionKey ?? routeWithDmScope.sessionKey,
        lastRoutePolicy: deriveLastRoutePolicy({
          sessionKey: threadKeys.sessionKey,
          mainSessionKey: threadKeys.parentSessionKey ?? routeWithDmScope.sessionKey,
        }),
      },
      configuredBinding,
      bindingOwnerAvailable: runtimeRoute.bindingOwnerAvailable ?? true,
      runtimeBindingId: runtimeBinding?.bindingId ?? null,
      pluginId: runtimeRoute.pluginId,
    };
  }

  return {
    route: routeWithDmScope,
    configuredBinding,
    bindingOwnerAvailable: runtimeRoute.bindingOwnerAvailable ?? true,
    runtimeBindingId: runtimeBinding?.bindingId ?? null,
    pluginId: runtimeRoute.pluginId,
  };
}
