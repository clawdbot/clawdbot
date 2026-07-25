// Covers active runtime plugin registry state and reset behavior.
import { afterEach, describe, expect, it } from "vitest";
import {
  getLoadedRuntimePluginRegistry,
  listLoadedRuntimePluginIdsAcrossSurfaces,
} from "./active-runtime-registry.js";
import { clearPluginLoaderCache } from "./loader.test-fixtures.js";
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

  it("does not treat disabled plugin records as an empty plugin scope", () => {
    const disabledRegistry = createEmptyPluginRegistry();
    disabledRegistry.plugins.push({
      id: "disabled",
      status: "disabled",
    } as never);
    setActivePluginRegistry(disabledRegistry, "disabled", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: [],
      }),
    ).toBeUndefined();
  });

  it("does not treat diagnostics as loaded plugin records", () => {
    const failedRegistry = createEmptyPluginRegistry();
    failedRegistry.plugins.push({
      id: "failed",
      status: "error",
    } as never);
    failedRegistry.diagnostics.push({
      level: "error",
      pluginId: "failed",
      message: "failed to load",
    } as never);
    setActivePluginRegistry(failedRegistry, "failed", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["failed"],
      }),
    ).toBeUndefined();
  });

  it("does not treat setup-only registrations as loaded plugin records", () => {
    const setupRegistry = createEmptyPluginRegistry();
    setupRegistry.plugins.push({
      id: "setup-only",
      status: "disabled",
    } as never);
    setupRegistry.channelSetups.push({
      pluginId: "setup-only",
    } as never);
    setActivePluginRegistry(setupRegistry, "setup-only", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["setup-only"],
      }),
    ).toBeUndefined();
  });

  it("does not treat deferred plugin metadata as a loaded runtime", () => {
    const deferredRegistry = createEmptyPluginRegistry();
    deferredRegistry.plugins.push({
      id: "deferred",
      format: "openclaw",
      imported: false,
      status: "loaded",
    } as never);
    setActivePluginRegistry(deferredRegistry, "deferred", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["deferred"],
      }),
    ).toBeUndefined();
    expect(listLoadedRuntimePluginIdsAcrossSurfaces()).not.toContain("deferred");
  });

  it("accepts metadata-only bundle plugins as loaded runtimes", () => {
    const bundleRegistry = createEmptyPluginRegistry();
    bundleRegistry.plugins.push({
      id: "bundle",
      format: "bundle",
      imported: false,
      status: "loaded",
    } as never);
    setActivePluginRegistry(bundleRegistry, "bundle", "default", "/tmp/ws");

    expect(
      getLoadedRuntimePluginRegistry({
        workspaceDir: "/tmp/ws",
        requiredPluginIds: ["bundle"],
      }),
    ).toBe(bundleRegistry);
    expect(listLoadedRuntimePluginIdsAcrossSurfaces()).toContain("bundle");
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
});
