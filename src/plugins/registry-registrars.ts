import { createCapabilityRegistrars } from "./registry-registrars-capabilities.js";
import { createHostRegistrars } from "./registry-registrars-host.js";
import { createMemoryRegistrars } from "./registry-registrars-memory.js";
import { createNetworkRegistrars } from "./registry-registrars-network.js";
import { createOperationRegistrars } from "./registry-registrars-operations.js";
import { createProviderRegistrars } from "./registry-registrars-providers.js";
import { createToolHookRegistrars } from "./registry-registrars-tools-hooks.js";
import type { PluginRegistryState } from "./registry-state.js";

/** Compose domain registrars over one explicit mutable registry state. */
export function createPluginRegistrars(state: PluginRegistryState) {
  return {
    ...createCapabilityRegistrars(state),
    ...createToolHookRegistrars(state),
    ...createNetworkRegistrars(state),
    ...createProviderRegistrars(state),
    ...createOperationRegistrars(state),
    ...createHostRegistrars(state),
    ...createMemoryRegistrars(state),
    registerModelCatalogProvider: state.registerModelCatalogProvider,
  };
}

export type PluginRegistrars = ReturnType<typeof createPluginRegistrars>;
