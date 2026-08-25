import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
import { resolveGatewaySessionOwnerKey } from "./gateway-session-owner.js";
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
  return resolveGatewaySessionOwnerKey(params.client);
}
