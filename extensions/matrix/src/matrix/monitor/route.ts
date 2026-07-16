import { buildAgentSessionKey, deriveLastRoutePolicy } from "openclaw/plugin-sdk/routing";
import {
  getSessionBindingService,
  resolveAgentIdFromSessionKey,
  resolveConfiguredAcpBindingRecord,
  type PluginRuntime,
} from "../../runtime-api.js";
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

function shouldApplyMatrixPerRoomDmSessionScope(params: {
  isDirectMessage: boolean;
  configuredSessionKey?: string;
}): boolean {
  return params.isDirectMessage && !params.configuredSessionKey;
}

export function resolveMatrixInboundRoute(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  senderId: string;
  isDirectMessage: boolean;
  dmSessionScope?: "per-user" | "per-room";
  threadId?: string;
  eventTs?: number;
  resolveAgentRoute: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
}): {
  route: MatrixResolvedRoute;
  configuredBinding: ReturnType<typeof resolveConfiguredAcpBindingRecord>;
  runtimeBindingId: string | null;
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
  const sessionBindingService = getSessionBindingService();
  const runtimeBinding = sessionBindingService.resolveByConversation({
    channel: "matrix",
    accountId: params.accountId,
    conversationId: bindingConversationId,
    parentConversationId: bindingParentConversationId,
  });
  const boundSessionKey = runtimeBinding?.targetSessionKey?.trim();

  if (runtimeBinding && boundSessionKey) {
    return {
      route: {
        ...baseRoute,
        sessionKey: boundSessionKey,
        agentId: resolveAgentIdFromSessionKey(boundSessionKey) || baseRoute.agentId,
        lastRoutePolicy: deriveLastRoutePolicy({
          sessionKey: boundSessionKey,
          mainSessionKey: baseRoute.mainSessionKey,
        }),
        matchedBy: "binding.channel",
      },
      configuredBinding: null,
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
          agentId:
            resolveAgentIdFromSessionKey(configuredSessionKey) ||
            configuredBinding.spec.agentId ||
            baseRoute.agentId,
          lastRoutePolicy: deriveLastRoutePolicy({
            sessionKey: configuredSessionKey,
            mainSessionKey: baseRoute.mainSessionKey,
          }),
          matchedBy: "binding.channel" as const,
        }
      : baseRoute;

  const dmSessionKey = shouldApplyMatrixPerRoomDmSessionScope({
    isDirectMessage: params.isDirectMessage,
    configuredSessionKey,
  })
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
      runtimeBindingId: null,
    };
  }

  return {
    route: routeWithDmScope,
    configuredBinding,
    runtimeBindingId: null,
  };
}
