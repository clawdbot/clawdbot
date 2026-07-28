// Resolves task runtime scope for agent harness launches.
import type { PluginHookSubagentRequester } from "../plugins/hook-types.js";
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
  readonly requesterPresentation?: PluginHookSubagentRequester;
};

/** Creates a host-issued task runtime scope for agent harness task execution. */
export function createAgentHarnessTaskRuntimeScope(params: {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterPresentation?: PluginHookSubagentRequester;
}): AgentHarnessTaskRuntimeScope {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    throw new Error("Agent harness task runtime scope requires requesterSessionKey");
  }
  const requesterOrigin = freezeOptional(normalizeDeliveryContext(params.requesterOrigin));
  const requesterPresentation = freezeOptional(
    normalizeRequesterPresentation(params.requesterPresentation),
  );
  const scope: AgentHarnessTaskRuntimeScope = Object.freeze({
    requesterSessionKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(requesterPresentation ? { requesterPresentation } : {}),
  });
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

function normalizeRequesterPresentation(
  requester: PluginHookSubagentRequester | undefined,
): PluginHookSubagentRequester | undefined {
  if (!requester) {
    return undefined;
  }
  const normalized: PluginHookSubagentRequester = {};
  for (const key of ["channel", "accountId", "to"] as const) {
    const value = requester[key]?.trim();
    if (value) {
      normalized[key] = value;
    }
  }
  for (const key of ["threadId", "channelId", "messageId"] as const) {
    const value = normalizeRequesterIdentity(requester[key]);
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeRequesterIdentity(
  value: string | number | undefined,
): string | number | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function freezeOptional<T extends object>(value: T | undefined): Readonly<T> | undefined {
  return value ? Object.freeze(value) : undefined;
}
