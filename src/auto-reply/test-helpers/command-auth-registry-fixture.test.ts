import { beforeEach, describe, expect, it } from "vitest";
import { registerEmbeddingProvider } from "../../plugins/embedding-providers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import { installDiscordRegistryHooks } from "./command-auth-registry-fixture.js";

describe.each(["cold", "populated"])("command-auth fixture with a %s predecessor", (mode) => {
  beforeEach(({ onTestFinished }) => {
    const ambient = captureActivePluginRegistrySnapshot();
    onTestFinished(() => rollbackStagedPluginRegistry(ambient));
    const registry = createEmptyPluginRegistry();
    const entries = registry.embeddingProviders;
    const entry = {
      pluginId: "predecessor",
      source: "test",
      provider: { id: "predecessor", create: async () => ({ provider: null }) },
    };
    entries.push(entry);
    stageActivePluginRegistry(registry, "predecessor-cache", "gateway-bindable", "/predecessor");
    if (mode === "cold") {
      // Retire only this test's scratch registry, never the ambient predecessor.
      rollbackStagedPluginRegistry({
        activeRegistry: null,
        key: null,
        workspaceDir: null,
        runtimeSubagentMode: "default",
      });
    }
    const previous = captureActivePluginRegistrySnapshot();
    const authority = previous.activeRegistry
      ? capturePluginLifecycleAuthority(previous.activeRegistry)
      : undefined;
    const expectedAuthority = mode === "populated" ? true : undefined;
    expect(authority?.()).toBe(expectedAuthority);
    // Registered before the fixture's cleanup: Vitest runs finished hooks as a stack.
    onTestFinished(() => {
      expect(captureActivePluginRegistrySnapshot()).toEqual(previous);
      expect(getActivePluginRegistry()).toBe(previous.activeRegistry);
      expect(authority?.()).toBe(expectedAuthority);
      expect(registry.embeddingProviders).toBe(entries);
      expect(entries).toEqual([entry]);
    });
  });

  installDiscordRegistryHooks();

  it("restores the predecessor after a caller mutates its separate fixture", () => {
    const registry = getActivePluginRegistry();
    expect(registry?.channels.map((entry) => entry.plugin.id)).toEqual(["discord", "whatsapp"]);
    expect(registry?.embeddingProviders).toEqual([]);
    registerEmbeddingProvider({ id: "fixture-only", create: async () => ({ provider: null }) });
    expect(registry?.embeddingProviders.map((entry) => entry.provider.id)).toEqual([
      "fixture-only",
    ]);
  });
});
