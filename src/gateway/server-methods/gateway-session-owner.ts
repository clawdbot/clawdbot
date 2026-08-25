import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import type { GatewayClient } from "./types.js";

/** Resolve the canonical authenticated owner shared by Gateway session surfaces. */
export function resolveGatewaySessionOwnerKey(client: GatewayClient | null): string | undefined {
  const profileId = client?.authenticatedUserProfile?.profileId.trim();
  if (profileId) {
    return `user:${profileId}`;
  }
  // A GitHub-backed connection has no durable owner until immutable profile sync succeeds.
  if (isGatewayClientProfilePending(client)) {
    return undefined;
  }
  const userId = client?.authenticatedUserId?.trim();
  if (userId) {
    return `user:${userId}`;
  }
  const deviceId = client?.connect.device?.id.trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }
  const connId = client?.connId?.trim();
  return connId ? `connection:${connId}` : undefined;
}
