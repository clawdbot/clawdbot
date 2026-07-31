import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";

export const HOST_GATEWAY_POLICY_BLOCKED = "HOST_GATEWAY_POLICY_BLOCKED";

export type HostGatewayActionState = "enabled" | "disabled" | "brokered";

export type HostPolicyDecisionState = HostGatewayActionState | "readOnly";

export type HostPolicyDecision = {
  state: HostPolicyDecisionState;
  reason?: string;
  source?: string;
  broker?: string;
};

export type HostGatewayActionPolicy = HostPolicyDecision & {
  state: HostGatewayActionState;
};

export type HostGatewayPolicy = {
  version: 1;
  defaults?: {
    action?: HostGatewayActionState;
    setting?: HostPolicyDecisionState;
  };
  actions?: Readonly<Record<string, HostGatewayActionPolicy>>;
  settings?: Readonly<Record<string, HostPolicyDecision>>;
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

  const action = resolveHostPolicyDecision(policy.actions, method);
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
        ...(action?.source ? { source: action.source } : {}),
        ...(action?.broker ? { broker: action.broker } : {}),
      },
    },
  );
}

export function resolveHostPolicyDecision<TDecision extends HostPolicyDecision>(
  decisions: Readonly<Record<string, TDecision>> | undefined,
  key: string,
): TDecision | undefined {
  if (!decisions) {
    return undefined;
  }
  const exact = decisions[key];
  if (exact) {
    return exact;
  }

  const parts = key.split(".");
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const wildcard = decisions[`${parts.slice(0, index).join(".")}.*`];
    if (wildcard) {
      return wildcard;
    }
  }
  return resolveWildcardHostPolicyDecision(decisions, key);
}

function resolveWildcardHostPolicyDecision<TDecision extends HostPolicyDecision>(
  decisions: Readonly<Record<string, TDecision>>,
  key: string,
): TDecision | undefined {
  let match: { pattern: string; decision: TDecision } | undefined;
  for (const [pattern, decision] of Object.entries(decisions)) {
    if (!pattern.includes("*") || pattern === "*") {
      continue;
    }
    if (!hostPolicyPatternMatches(pattern, key)) {
      continue;
    }
    if (!match || patternSpecificity(pattern) > patternSpecificity(match.pattern)) {
      match = { pattern, decision };
    }
  }
  return match?.decision ?? decisions["*"];
}

function hostPolicyPatternMatches(pattern: string, key: string): boolean {
  const patternParts = pattern.split(".");
  const keyParts = key.split(".");
  if (patternParts.length !== keyParts.length) {
    return false;
  }
  return patternParts.every((part, index) => part === "*" || part === keyParts[index]);
}

function patternSpecificity(pattern: string): number {
  return pattern
    .split(".")
    .filter((part) => part !== "*")
    .join(".").length;
}
