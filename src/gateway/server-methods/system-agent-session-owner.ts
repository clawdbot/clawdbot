import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
import type { GatewayClient } from "./types.js";

export function resolveSystemAgentSessionOwnerKey(params: {
  delegation?: { agentId?: string; sessionKey?: string };
  client: GatewayClient | null;
}): string | undefined {
  const delegationKey = resolveSystemAgentDelegationKey(params.delegation);
  if (delegationKey !== undefined) {
    // Delegation is a host-only cross-connection owner from the regular-agent tool path.
    return delegationKey;
  }
  const profileId = params.client?.authenticatedUserProfile?.profileId.trim();
  if (profileId) {
    return `user:${profileId}`;
  }
  // A GitHub-backed alias is not an owner until immutable profile sync succeeds.
  const userId = params.client?.authenticatedUserId?.trim();
  if (userId && !params.client?.authenticatedGitHubIdentitySync) {
    return `user:${userId}`;
  }
  const deviceId = params.client?.connect.device?.id.trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }
  const connId = params.client?.connId?.trim();
  return connId ? `connection:${connId}` : undefined;
}
