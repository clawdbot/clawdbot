import type { GatewayClient } from "../server-methods/shared-types.js";
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
