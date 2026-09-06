// Resolves task runtime scope for agent harness launches.
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const scopeRegistryKey = Symbol.for("openclaw.agentHarnessTaskRuntimeScope.registry");

// Host-issued scopes prevent plugins from fabricating requester ownership for task runs.
type ScopeRegistry = {
  hostIssuedScopes: WeakSet<object>;
};

type GlobalWithScopeRegistry = typeof globalThis & {
  [scopeRegistryKey]?: ScopeRegistry;
};

function getScopeRegistry(): ScopeRegistry {
  const globalState = globalThis as GlobalWithScopeRegistry;
  globalState[scopeRegistryKey] ??= {
    hostIssuedScopes: new WeakSet<object>(),
  };
  return globalState[scopeRegistryKey];
}

export type AgentHarnessTaskRuntimeScope = {
  readonly requesterSessionKey: string;
  readonly requesterOrigin?: DeliveryContext;
};

/** Creates a host-issued task runtime scope for agent harness task execution. */
export function createAgentHarnessTaskRuntimeScope(params: {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  gatewayContextResolver?: GatewayContextResolver;
}): AgentHarnessTaskRuntimeScope {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    throw new Error("Agent harness task runtime scope requires requesterSessionKey");
  }
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const scope: AgentHarnessTaskRuntimeScope = {
    requesterSessionKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
  };
  getScopeRegistry().hostIssuedScopes.add(scope);
  bindGatewayContextResolver(scope, params.gatewayContextResolver);
  return scope;
}

export function assertAgentHarnessTaskRuntimeScope(
  scope: AgentHarnessTaskRuntimeScope,
): AgentHarnessTaskRuntimeScope {
  if (!getScopeRegistry().hostIssuedScopes.has(scope)) {
    throw new Error("Agent harness task runtime requires a host-issued scope");
  }
  return scope;
}
