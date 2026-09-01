// Internal state and live registry view for the global hook runner.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { HookRunner } from "./hooks.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type {
  PluginExternalApprovalVerifierRegistration,
  PluginRegistry,
  PluginTrustedToolPolicyRegistryRegistration,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";

type TrustedPolicyHookRunnerRegistry = GlobalHookRunnerRegistry & {
  trustedToolPolicies?: PluginTrustedToolPolicyRegistryRegistration[];
  externalApprovalVerifiers?: PluginExternalApprovalVerifierRegistration[];
};

type HookRunnerGlobalState = {
  hookRunner: HookRunner | null;
  registry: TrustedPolicyHookRunnerRegistry | null;
};

const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

export function getHookRunnerGlobalState(): HookRunnerGlobalState {
  return resolveGlobalSingleton<HookRunnerGlobalState>(
    hookRunnerGlobalStateKey,
    () => ({
      hookRunner: null,
      registry: null,
    }),
    (state) => {
      state.registry = null;
    },
    "plugin-registry",
  );
}

function resolveRootHookRegistry(
  state: HookRunnerGlobalState,
): TrustedPolicyHookRunnerRegistry | null {
  const activeRegistry = getActivePluginRegistry();
  const initializedRegistry =
    state.registry && !isPluginRegistryRetired(state.registry as PluginRegistry)
      ? state.registry
      : null;
  if (!initializedRegistry || initializedRegistry === activeRegistry) {
    return activeRegistry ?? initializedRegistry;
  }
  // SDK consumers can initialize an isolated hook registry while a process root
  // exists. Preserve both sources, with the explicit initialization on top.
  return overlayHookRegistries(activeRegistry, initializedRegistry);
}

function overlayHookRegistries(
  baseRegistry: TrustedPolicyHookRunnerRegistry | null,
  overlayRegistry: TrustedPolicyHookRunnerRegistry | null,
): TrustedPolicyHookRunnerRegistry | null {
  if (!overlayRegistry || overlayRegistry === baseRegistry) {
    return baseRegistry;
  }
  if (!baseRegistry) {
    return overlayRegistry;
  }

  // Each higher-precedence source overlays only the contributions it carries. A
  // partial or failed source must not hide unrelated fail-closed hooks or policy.
  const overlayPluginIds = new Set(overlayRegistry.plugins.map((plugin) => plugin.id));
  const overlayLegacyHookEvents = new Map<string, Set<string>>();
  for (const hook of overlayRegistry.hooks) {
    if (!Array.isArray(hook.events)) {
      continue;
    }
    const events = overlayLegacyHookEvents.get(hook.pluginId) ?? new Set<string>();
    for (const event of hook.events) {
      events.add(event);
    }
    overlayLegacyHookEvents.set(hook.pluginId, events);
  }
  const overlayTypedHooks = new Set(
    overlayRegistry.typedHooks.map((hook) => `${hook.pluginId}\0${hook.hookName}`),
  );
  const overlayTrustedPolicies = new Set(
    (overlayRegistry.trustedToolPolicies ?? []).map(
      (entry) => `${entry.pluginId}\0${entry.policy.id}`,
    ),
  );
  const trustedToolPolicies = [
    ...(baseRegistry.trustedToolPolicies ?? []).filter(
      (entry) => !overlayTrustedPolicies.has(`${entry.pluginId}\0${entry.policy.id}`),
    ),
    ...(overlayRegistry.trustedToolPolicies ?? []),
  ].toSorted((left, right) => {
    const leftRank = left.origin === "bundled" ? 0 : 1;
    const rightRank = right.origin === "bundled" ? 0 : 1;
    return leftRank - rightRank;
  });
  // External approval verifiers follow the same overlay contract: a source
  // that carries a verifier for a plugin replaces the base entry for that
  // plugin only, keeping one live owner per plugin id.
  const overlayExternalVerifierPluginIds = new Set(
    (overlayRegistry.externalApprovalVerifiers ?? []).map((entry) => entry.pluginId),
  );
  const externalApprovalVerifiers = [
    ...(baseRegistry.externalApprovalVerifiers ?? []).filter(
      (entry) => !overlayExternalVerifierPluginIds.has(entry.pluginId),
    ),
    ...(overlayRegistry.externalApprovalVerifiers ?? []),
  ];
  return {
    hooks: [
      ...baseRegistry.hooks.flatMap((hook) => {
        const overlayEvents = overlayLegacyHookEvents.get(hook.pluginId);
        if (!overlayEvents || !Array.isArray(hook.events)) {
          return hook;
        }
        const events = hook.events.filter((event) => !overlayEvents.has(event));
        return events.length === 0 ? [] : [{ ...hook, events }];
      }),
      ...overlayRegistry.hooks,
    ],
    typedHooks: [
      ...baseRegistry.typedHooks.filter(
        (hook) => !overlayTypedHooks.has(`${hook.pluginId}\0${hook.hookName}`),
      ),
      ...overlayRegistry.typedHooks,
    ],
    plugins: [
      ...baseRegistry.plugins.filter((plugin) => !overlayPluginIds.has(plugin.id)),
      ...overlayRegistry.plugins,
    ],
    trustedToolPolicies,
    externalApprovalVerifiers,
  };
}

function resolveHookRegistry(state: HookRunnerGlobalState): TrustedPolicyHookRunnerRegistry | null {
  const generationRegistry = getPluginRuntimeGenerationRegistry();
  if (generationRegistry) {
    return generationRegistry;
  }
  return overlayHookRegistries(
    resolveRootHookRegistry(state),
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? null,
  );
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
    get externalApprovalVerifiers() {
      return resolveHookRegistry(state)?.externalApprovalVerifiers ?? [];
    },
  };
}

/** Get the registry view that backs global hook dispatch. */
export function getGlobalHookRunnerRegistry(): TrustedPolicyHookRunnerRegistry | null {
  const state = getHookRunnerGlobalState();
  return resolveHookRegistry(state) ? createLiveHookRegistryFacade(state) : null;
}

/** Resolve the verifier owned by the same live plugin registry selected for hook dispatch. */
export function getPluginExternalApprovalVerifier(
  pluginId: string,
): PluginExternalApprovalVerifierRegistration | null {
  return (
    getGlobalHookRunnerRegistry()?.externalApprovalVerifiers?.find(
      (registration) => registration.pluginId === pluginId,
    ) ?? null
  );
}
