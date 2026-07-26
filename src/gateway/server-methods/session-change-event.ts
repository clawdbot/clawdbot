// Shared sessions.changed broadcaster for gateway RPC and chat-command mutations.
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { buildGatewaySessionEventFields } from "../session-event-payload.js";
import { invalidateSessionSharingSnapshot } from "../session-sharing.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import type { GatewayRequestContext } from "./types.js";

type SessionChangedPayload = {
  sessionKey?: string;
  agentId?: string;
  reason: string;
  compacted?: boolean;
};

export function resolveSessionMessageSubscriptionKey(params: {
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): string {
  const agentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : params.canonicalKey === "global" && params.defaultAgentId
      ? normalizeAgentId(params.defaultAgentId)
      : undefined;
  // Global session message subscriptions need per-agent channels to avoid cross-agent fanout.
  return params.canonicalKey === "global" && agentId
    ? `agent:${agentId}:global`
    : params.canonicalKey;
}

export function emitSessionsChanged(
  context: Pick<
    GatewayRequestContext,
    | "broadcastToConnIds"
    | "chatAbortControllers"
    | "getRuntimeConfig"
    | "getSessionEventSubscriberConnIds"
    | "getSessionMessageSubscriberConnIds"
  >,
  payload: SessionChangedPayload,
) {
  invalidateSessionSharingSnapshot(payload.sessionKey);
  const evSubs = context.getSessionEventSubscriberConnIds();
  const isTeardown =
    payload.reason === "reset" || payload.reason === "delete" || payload.reason === "new";

  if (isTeardown) {
    let msgSubs: ReadonlySet<string> = new Set<string>();
    if (payload.sessionKey) {
      const subscriptionKey = resolveSessionMessageSubscriptionKey({
        canonicalKey: payload.sessionKey,
        agentId: payload.agentId,
        defaultAgentId: resolveDefaultAgentId(context.getRuntimeConfig()),
      });
      msgSubs = context.getSessionMessageSubscriberConnIds?.(subscriptionKey) ?? new Set();
    }
    const drainConnIds = new Set<string>([...evSubs, ...msgSubs]);

    if (drainConnIds.size > 0 && payload.sessionKey) {
      context.broadcastToConnIds(
        "socket.drain",
        {
          sessionKey: payload.sessionKey,
          reason: payload.reason,
          ts: Date.now(),
          ...(payload.sessionKey === "global" && payload.agentId
            ? { agentId: payload.agentId }
            : {}),
        },
        drainConnIds,
      );
    }
  }

  const connIds = evSubs;
  if (connIds.size === 0) {
    return;
  }
  const sessionRow = payload.sessionKey
    ? loadGatewaySessionRow(
        payload.sessionKey,
        payload.sessionKey === "global" && payload.agentId
          ? { agentId: payload.agentId }
          : undefined,
      )
    : null;
  const defaultAgentId = resolveDefaultAgentId(context.getRuntimeConfig());
  const activeRunState = sessionRow
    ? resolveVisibleActiveSessionRunState({
        context,
        requestedKey: payload.sessionKey ?? sessionRow.key,
        canonicalKey: sessionRow.key,
        sessionId: sessionRow.sessionId,
        agentId: sessionRow.key === "global" ? payload.agentId : undefined,
        defaultAgentId,
      })
    : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            ...buildGatewaySessionEventFields({
              sessionRow,
              agentId: payload.agentId,
              hasActiveRun: activeRunState?.active,
              activeRunIds: activeRunState?.runIds,
            }),
            effectiveFastMode: sessionRow.effectiveFastMode,
            effectiveFastModeSource: sessionRow.effectiveFastModeSource,
            fastAutoOnSeconds: sessionRow.fastAutoOnSeconds,
            traceLevel: sessionRow.traceLevel,
            pluginExtensions: sessionRow.pluginExtensions,
          }
        : {}),
    },
    connIds,
    {
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      dropIfSlow: true,
      // Scope only to a concrete key; a `[undefined]` scope filters no connection
      // correctly and would strip draft gating, so fall back to an unscoped send.
      ...(sessionRow?.key ? { sessionKeys: [sessionRow.key] } : {}),
    },
  );
}
