/**
 * Shared plugin-registry mock used by gateway server-agent tests.
 */
import { vi } from "vitest";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry as setActivePluginRegistryLocal } from "../plugins/runtime.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

const registryState: { registry: PluginRegistry } = {
  registry: createEmptyPluginRegistry(),
};

/** Installs the supplied registry into both gateway test and plugin runtime globals. */
export function setRegistry(registry: PluginRegistry) {
  registryState.registry = registry;
  setTestPluginRegistry(registry);
  setActivePluginRegistryLocal(registry);
}

vi.mock("./server-plugins.js", async () => {
  const actual = await vi.importActual<typeof import("./server-plugins.js")>("./server-plugins.js");
  const { setActivePluginRegistry: setActivePluginRegistryLocalLocal } =
    await import("../plugins/runtime.js");
  return {
    ...actual,
    loadGatewayPlugins: (params: { baseMethods: string[] }) => {
      setActivePluginRegistryLocalLocal(registryState.registry);
      return {
        pluginRegistry: registryState.registry,
        gatewayMethods: params.baseMethods ?? [],
      };
    },
    setFallbackGatewayContextResolver: vi.fn(),
  };
});
