import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function hasActiveAgentRuntimeAuthority(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">,
): boolean {
  const identity = client?.internal?.agentRuntimeIdentity;
  const validate = context.validateAgentRuntimeApprovalAuthority;
  // Production dispatch always supplies the validator. Lightweight direct-handler
  // contexts have no live authority owner and therefore no identity to invalidate.
  return !identity || !validate || validate(identity);
}

export function assertActiveAgentRuntimeAuthority(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">,
): void {
  if (!hasActiveAgentRuntimeAuthority(client, context)) {
    throw new TypeError("agent runtime authority is no longer active");
  }
}
