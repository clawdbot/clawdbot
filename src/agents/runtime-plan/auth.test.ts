// Runtime plan auth tests cover provider/auth-profile selection and plugin
// alias loading behavior for the auth portion of the plan.
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginRegistryMocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
    loadPluginMetadataSnapshot: vi.fn((params: unknown) => {
      const registry = loadManifestRegistry(params) ?? { plugins: [], diagnostics: [] };
      return {
        index: {
          plugins: registry.plugins.map((plugin: { id: string; origin?: string }) => ({
            pluginId: plugin.id,
            origin: plugin.origin ?? "global",
            enabled: true,
            enabledByDefault: true,
          })),
        },
        plugins: registry.plugins,
      };
    }),
  };
});

vi.mock("../../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

import { resetProviderAuthAliasMapCacheForTest } from "../provider-auth-aliases.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";

describe("buildAgentRuntimeAuthPlan", () => {
  beforeEach(() => {
    resetProviderAuthAliasMapCacheForTest();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("does not load provider auth aliases when plugins are disabled", () => {
    // Disabling alias support should avoid metadata loading entirely, not just
    // ignore aliases after doing plugin work.
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "alias-owner",
          origin: "global",
          providerAuthAliases: { fixture: "provider-two" },
        },
      ],
      diagnostics: [],
    });

    const plan = buildAgentRuntimeAuthPlan({
      provider: "fixture",
      authProfileProvider: "fixture",
      config: {},
      providerAuthAliasesEnabled: false,
    });

    expect(plan.providerForAuth).toBe("fixture");
    expect(plan.authProfileProviderForAuth).toBe("fixture");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("derives disabled provider auth aliases from plugin config", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [
        {
          id: "alias-owner",
          origin: "global",
          providerAuthAliases: { fixture: "provider-two" },
        },
      ],
      diagnostics: [],
    });

    const plan = buildAgentRuntimeAuthPlan({
      provider: "fixture",
      authProfileProvider: "fixture",
      config: { plugins: { enabled: false } },
    });

    expect(plan.providerForAuth).toBe("fixture");
    expect(plan.authProfileProviderForAuth).toBe("fixture");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });
});
