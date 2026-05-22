import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const scopeRegistryKey = Symbol.for("openclaw.agentHarnessTaskRuntimeScope.registry");

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

export function createAgentHarnessTaskRuntimeScope(params: {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
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
