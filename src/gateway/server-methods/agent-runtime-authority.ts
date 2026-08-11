import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

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

export function ensureActiveAgentRuntimeAuthority(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  respond: RespondFn;
}): boolean {
  if (hasActiveAgentRuntimeAuthority(params.client, params.context)) {
    return true;
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
  );
  return false;
}
