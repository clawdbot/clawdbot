import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { GatewayClient, GatewayRequestContext } from "../server-methods/shared-types.js";
import type { AgentTurnPrincipal } from "./types.js";

/** Captures the transport identity without rebuilding its trusted metadata. */
export function captureAgentTurnPrincipal(client: GatewayClient | null): AgentTurnPrincipal | null {
  if (!client) {
    return null;
  }
  return {
    authenticatedUserId: client.authenticatedUserId,
    authenticatedUserProfile: client.authenticatedUserProfile,
    connId: client.connId,
    connect: client.connect,
    internal: client.internal,
    isDeviceTokenAuth: client.isDeviceTokenAuth,
  };
}

/** Preserve capability-gated tool-event observation across agent turn entry paths. */
export function resolveAgentTurnRunObserver(params: {
  principal: AgentTurnPrincipal | null;
  registerToolEventRecipient: GatewayRequestContext["registerToolEventRecipient"];
}): ((runId: string) => void) | undefined {
  const connId = params.principal?.connId;
  return connId &&
    hasGatewayClientCap(params.principal?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS)
    ? (runId) => params.registerToolEventRecipient(runId, connId)
    : undefined;
}
