import { afterEach, describe, expect, it } from "vitest";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { __testing, clearPluginLoaderCache } from "./loader.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
});

function createRegistryWithPlugin(pluginId: string): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: pluginId,
    status: "loaded",
  } as never);
  return registry;
}

describe("getLoadedRuntimePluginRegistry", () => {
  it("treats an explicit empty plugin scope as empty", () => {
    setActivePluginRegistry(createRegistryWithPlugin("stale"), "stale", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBeUndefined();

    const emptyRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(emptyRegistry, "empty", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBe(emptyRegistry);
  });

  it("does not reuse workspace-agnostic registries for workspace-specific requests", () => {
    setActivePluginRegistry(createRegistryWithPlugin("demo"), "demo");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["demo"],
      }),
    ).toBeUndefined();
  });

  it("validates full loader cache compatibility when load options are provided", () => {
    const registry = createRegistryWithPlugin("demo");
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
        },
      },
      onlyPluginIds: ["demo"],
      workspaceDir: "/tmp/ws",
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions,
      }),
    ).toBe(registry);

    expect(
      getLoadedRuntimePluginRegistry({
        loadOptions: {
          ...loadOptions,
          config: {
            plugins: {
              allow: ["other"],
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});
