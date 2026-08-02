// Internal state and live registry view for the global hook runner.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { HookRunner } from "./hooks.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type {
  PluginRegistry,
  PluginTrustedToolPolicyRegistryRegistration,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

type TrustedPolicyHookRunnerRegistry = GlobalHookRunnerRegistry & {
  trustedToolPolicies?: PluginTrustedToolPolicyRegistryRegistration[];
};

type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: TrustedPolicyHookRunnerRegistry | null;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

export function getHookRunnerGlobalState(): HookRunnerGlobalState {
  return resolveGlobalSingleton<HookRunnerGlobalState>(hookRunnerGlobalStateKey, () => ({
    hookRunner: null,
    registry: null,
  }));
}

function resolveRootHookRegistry(
  state: HookRunnerGlobalState,
): TrustedPolicyHookRunnerRegistry | null {
  const activeRegistry = getActivePluginRegistry();
  if (activeRegistry) {
    return activeRegistry;
  }
  if (state.registry && !isPluginRegistryRetired(state.registry as PluginRegistry)) {
    return state.registry;
  }
  return null;
}

function resolveHookRegistry(state: HookRunnerGlobalState): TrustedPolicyHookRunnerRegistry | null {
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const rootRegistry = resolveRootHookRegistry(state);
  if (!scopedRegistry || scopedRegistry === rootRegistry) {
    return scopedRegistry ?? rootRegistry;
  }
  if (!rootRegistry) {
    return scopedRegistry;
  }

  // A handle overlays only the contributions it actually carries. A partial or
  // failed handle must not hide root hooks or trusted policy from the same plugin.
  const scopedPluginIds = new Set(scopedRegistry.plugins.map((plugin) => plugin.id));
  const scopedLegacyHookEvents = new Map<string, Set<string>>();
  for (const hook of scopedRegistry.hooks) {
    if (!Array.isArray(hook.events)) {
      continue;
    }
    const events = scopedLegacyHookEvents.get(hook.pluginId) ?? new Set<string>();
    for (const event of hook.events) {
      events.add(event);
    }
    scopedLegacyHookEvents.set(hook.pluginId, events);
  }
  const scopedTypedHooks = new Set(
    scopedRegistry.typedHooks.map((hook) => `${hook.pluginId}\0${hook.hookName}`),
  );
  const scopedTrustedPolicies = new Set(
    (scopedRegistry.trustedToolPolicies ?? []).map(
      (entry) => `${entry.pluginId}\0${entry.policy.id}`,
    ),
  );
  const trustedToolPolicies = [
    ...(rootRegistry.trustedToolPolicies ?? []).filter(
      (entry) => !scopedTrustedPolicies.has(`${entry.pluginId}\0${entry.policy.id}`),
    ),
    ...(scopedRegistry.trustedToolPolicies ?? []),
  ].toSorted((left, right) => {
    const leftRank = left.origin === "bundled" ? 0 : 1;
    const rightRank = right.origin === "bundled" ? 0 : 1;
    return leftRank - rightRank;
  });
  return {
    hooks: [
      ...rootRegistry.hooks.flatMap((hook) => {
        const scopedEvents = scopedLegacyHookEvents.get(hook.pluginId);
        if (!scopedEvents || !Array.isArray(hook.events)) {
          return hook;
        }
        const events = hook.events.filter((event) => !scopedEvents.has(event));
        return events.length === 0 ? [] : [{ ...hook, events }];
      }),
      ...scopedRegistry.hooks,
    ],
    typedHooks: [
      ...rootRegistry.typedHooks.filter(
        (hook) => !scopedTypedHooks.has(`${hook.pluginId}\0${hook.hookName}`),
      ),
      ...scopedRegistry.typedHooks,
    ],
    plugins: [
      ...rootRegistry.plugins.filter((plugin) => !scopedPluginIds.has(plugin.id)),
      ...scopedRegistry.plugins,
    ],
    trustedToolPolicies,
  };
}

export function createLiveHookRegistryFacade(
  state: HookRunnerGlobalState,
): TrustedPolicyHookRunnerRegistry {
  // The runner object stays stable while these getters select the current request
  // handle or process root on every dispatch.
  return {
    get hooks() {
      return resolveHookRegistry(state)?.hooks ?? [];
    },
    get typedHooks() {
      return resolveHookRegistry(state)?.typedHooks ?? [];
    },
    get plugins() {
      return resolveHookRegistry(state)?.plugins ?? [];
    },
    get trustedToolPolicies() {
      return resolveHookRegistry(state)?.trustedToolPolicies ?? [];
    },
  };
}

/** Get the registry view that backs global hook dispatch. */
export function getGlobalHookRunnerRegistry(): TrustedPolicyHookRunnerRegistry | null {
  const state = getHookRunnerGlobalState();
  return resolveHookRegistry(state) ? createLiveHookRegistryFacade(state) : null;
}
