/** Native composition entry for ordinary, restricted, and cold provider-hook loading. */
import { createExternalAuthRuntime } from "../agents/auth-profiles/external-auth.js";
import { createAuthProfileStoreRuntime } from "../agents/auth-profiles/store.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { resolveAllowedModelRefCore } from "../agents/model-selection-resolve.js";
import { createPluginCapabilityCatalogContext } from "./capability-catalog-context.js";
import { isPluginRegistryLoadInFlight } from "./loader-cache.js";
import {
  loadOpenClawPluginsCore,
  type InternalPluginLoadOverrides,
  type NativePluginLoadBindings,
} from "./loader-runtime-core.js";
import { createPluginRuntimeRegistryResolver } from "./loader-runtime-registry.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { createProviderAuthAvailability } from "./provider-auth-availability-core.js";
import { createProviderExternalAuthResolver } from "./provider-external-auth-core.js";
import { createProviderHookRuntime } from "./provider-hook-runtime-core.js";
import { createProviderRegistryResolver } from "./providers.runtime-core.js";
import { PluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import type { PluginRegistry } from "./registry-types.js";
import { createRuntimeModelAuth } from "./runtime/runtime-model-auth.js";
import type { PluginRuntime } from "./runtime/types.js";

// Construction only binds callbacks. No profile reads, plugin loads, or network work occur here.
// Hoisted entry functions let cold auth discovery re-enter this same binding without a module cycle.
export const resolveRuntimePluginRegistry =
  createPluginRuntimeRegistryResolver(loadOpenClawPlugins);
const providerRegistry = Object.freeze(
  createProviderRegistryResolver({
    loadOpenClawPlugins,
    resolveRuntimePluginRegistry,
    isPluginRegistryLoadInFlight,
  }),
);
const providerHooks = Object.freeze(createProviderHookRuntime(providerRegistry));
const externalProfiles = Object.freeze(createProviderExternalAuthResolver(providerHooks));
const externalAuth = Object.freeze(
  createExternalAuthRuntime(externalProfiles.resolveExternalAuthProfilesWithPlugins),
);
const authStore = Object.freeze(createAuthProfileStoreRuntime(externalAuth));
const authAvailability = Object.freeze(createProviderAuthAvailability(authStore));
let modelAuth: NativePluginLoadBindings["modelAuth"] | undefined;
let modelConfig: NativePluginLoadBindings["modelConfig"] | undefined;
let capabilityCatalogContext: NativePluginLoadBindings["capabilityCatalogContext"] | undefined;
// Imports of store/hook facades must not construct unrelated policy surfaces.
// Consumers share immutable defaults and retain their own mutable method views.
const loaderBindings: NativePluginLoadBindings = Object.freeze({
  get modelAuth() {
    return (modelAuth ??= Object.freeze(
      createRuntimeModelAuth({
        ensureAuthProfileStore: authStore.ensureAuthProfileStore,
        isProviderApiKeyConfigured: authAvailability.isProviderApiKeyConfigured,
      }),
    ));
  },
  get modelConfig() {
    return (modelConfig ??= Object.freeze({
      resolveDefaultModelForAgent,
      resolveAllowedModelRef: resolveAllowedModelRefCore,
    }));
  },
  get capabilityCatalogContext() {
    return (capabilityCatalogContext ??= createPluginCapabilityCatalogContext(authAvailability));
  },
});

type NativePluginBindings = {
  providerRegistry: ReturnType<typeof createProviderRegistryResolver>;
  providerHooks: ReturnType<typeof createProviderHookRuntime>;
  externalProfiles: ReturnType<typeof createProviderExternalAuthResolver>;
  externalAuth: ReturnType<typeof createExternalAuthRuntime>;
  authStore: ReturnType<typeof createAuthProfileStoreRuntime>;
  authAvailability: ReturnType<typeof createProviderAuthAvailability>;
};
export const nativePluginBindings: Readonly<NativePluginBindings> = Object.freeze({
  providerRegistry,
  providerHooks,
  externalProfiles,
  externalAuth,
  authStore,
  authAvailability,
});

export function resolvePluginCapabilityCatalogContext() {
  return loaderBindings.capabilityCatalogContext;
}
export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  return loadOpenClawPluginsCore(options, loaderBindings);
}

/** Acquires a fresh discovery registry; release waits for its registration resources. */
export async function acquirePluginRegistryForInspection(
  options: Omit<PluginLoadOptions, "activate" | "cache"> = {},
): Promise<{ registry: PluginRegistry; release: () => Promise<void> }> {
  const resources = new PluginRegistryInspectionResources();
  try {
    const registry = loadOpenClawPluginsCore(
      { ...options, activate: false, cache: false },
      loaderBindings,
      undefined,
      resources,
    );
    return { registry, release: () => resources.release() };
  } catch (error) {
    try {
      await resources.release();
    } catch (disposalError) {
      throw new AggregateError(
        [error, disposalError],
        "Plugin inspection failed and its resources could not be disposed",
        { cause: disposalError },
      );
    }
    throw error;
  }
}

export function loadOpenClawPluginsWithInternalOverrides(
  options: PluginLoadOptions & { cache: false },
  overrides: Omit<InternalPluginLoadOverrides, "runtime"> & {
    runtime: Pick<PluginRuntime, "config"> &
      Partial<Pick<PluginRuntime, "modelAuth" | "modelConfig">>;
  },
): PluginRegistry {
  const runtimeModelAuth = overrides.runtime.modelAuth ??
    options.runtimeOptions?.modelAuth ?? { ...loaderBindings.modelAuth };
  const runtimeModelConfig = overrides.runtime.modelConfig ??
    options.runtimeOptions?.modelConfig ?? { ...loaderBindings.modelConfig };
  // Policy facets stay getter-only; their method views remain mutable per runtime.
  const runtime = {
    config: overrides.runtime.config,
    get modelAuth() {
      return runtimeModelAuth;
    },
    get modelConfig() {
      return runtimeModelConfig;
    },
  };
  // Preserve supplied lazy services without reading their getters during registration.
  const runtimeDescriptors = Object.getOwnPropertyDescriptors(overrides.runtime);
  delete runtimeDescriptors.modelAuth;
  delete runtimeDescriptors.modelConfig;
  Object.defineProperties(runtime, runtimeDescriptors);
  return loadOpenClawPluginsCore(options, loaderBindings, { ...overrides, runtime });
}

export function resolveNativePluginModelAuth(): PluginRuntime["modelAuth"] {
  return { ...loaderBindings.modelAuth };
}
export function resolveNativePluginModelConfig(): PluginRuntime["modelConfig"] {
  return { ...loaderBindings.modelConfig };
}
