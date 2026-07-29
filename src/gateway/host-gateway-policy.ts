import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";

export const HOST_GATEWAY_POLICY_BLOCKED = "HOST_GATEWAY_POLICY_BLOCKED";

export type HostGatewayActionState = "enabled" | "disabled" | "brokered";

export type HostGatewayActionPolicy = {
  state: HostGatewayActionState;
  reason?: string;
};

export type HostGatewayPolicy = {
  version: 1;
  defaults?: {
    action?: HostGatewayActionState;
  };
  actions?: Readonly<Record<string, HostGatewayActionPolicy>>;
};

type HostGatewayPolicyClient = {
  connect?: { role?: string };
  internal?: { syntheticClient?: true };
};

export function authorizeHostGatewayPolicyForMethod(params: {
  policy?: HostGatewayPolicy;
  client: HostGatewayPolicyClient | null;
  method: string;
}): ErrorShape | null {
  const { policy, client, method } = params;
  if (!policy || !client?.connect || client.internal?.syntheticClient) {
    return null;
  }
  if (client.connect.role !== "operator") {
    return null;
  }

  const action = resolveHostGatewayActionPolicy(policy, method);
  const state = action?.state ?? policy.defaults?.action ?? "enabled";
  if (state === "enabled") {
    return null;
  }

  return errorShape(
    ErrorCodes.FORBIDDEN,
    state === "brokered"
      ? `host policy requires brokered gateway method: ${method}`
      : `host policy blocks gateway method: ${method}`,
    {
      details: {
        code: HOST_GATEWAY_POLICY_BLOCKED,
        method,
        state,
        ...(action?.reason ? { reason: action.reason } : {}),
      },
    },
  );
}

function resolveHostGatewayActionPolicy(
  policy: HostGatewayPolicy,
  method: string,
): HostGatewayActionPolicy | undefined {
  const actions = policy.actions;
  if (!actions) {
    return undefined;
  }
  const exact = actions[method];
  if (exact) {
    return exact;
  }

  const parts = method.split(".");
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const wildcard = actions[`${parts.slice(0, index).join(".")}.*`];
    if (wildcard) {
      return wildcard;
    }
  }
  return actions["*"];
}
