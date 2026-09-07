import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { GatewayClient } from "./client-types.js";

export function isSyntheticGatewayCaller(client: GatewayClient | null): boolean {
  return Boolean(
    client?.internal?.syntheticClient ||
    client?.internal?.agentToolCaller ||
    client?.internal?.agentRuntimeIdentity ||
    getGatewayToolCallerIdentity(),
  );
}

export function isIneligiblePersonalGatewayCaller(client: GatewayClient): boolean {
  const actor = client.internal?.operatorRoleActor;
  // Real shared-secret sockets carry a system actor and their owner profile.
  // A system actor alone or other delegated actors cannot authorize personal accounts.
  return (
    isSyntheticGatewayCaller(client) ||
    Boolean(actor && (actor.kind !== "system" || !client.authenticatedUserProfile))
  );
}
