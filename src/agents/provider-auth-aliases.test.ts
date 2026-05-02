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

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

import {
  resetProviderAuthAliasMapCacheForTest,
  resolveProviderIdForAuth,
} from "./provider-auth-aliases.js";

describe("provider auth aliases", () => {
  beforeEach(() => {
    resetProviderAuthAliasMapCacheForTest();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("treats deprecated auth choice ids as provider auth aliases", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          providerAuthChoices: [
            {
              provider: "openai-codex",
              method: "oauth",
              choiceId: "openai-codex",
              deprecatedChoiceIds: ["codex-cli", "openai-codex-import"],
            },
          ],
        },
      ],
      diagnostics: [],
    });

    expect(resolveProviderIdForAuth("codex-cli")).toBe("openai-codex");
    expect(resolveProviderIdForAuth("openai-codex-import")).toBe("openai-codex");
    expect(resolveProviderIdForAuth("openai-codex")).toBe("openai-codex");
  });

  it("does not reuse aliases across env-resolved plugin roots", () => {
    const env = {
      HOME: "/home/one",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry
      .mockReturnValueOnce({
        plugins: [
          {
            id: "one",
            origin: "global",
            providerAuthAliases: { fixture: "provider-one" },
          },
        ],
        diagnostics: [],
      })
      .mockReturnValueOnce({
        plugins: [
          {
            id: "two",
            origin: "global",
            providerAuthAliases: { fixture: "provider-two" },
          },
        ],
        diagnostics: [],
      });

    expect(resolveProviderIdForAuth("fixture", { config: {}, env })).toBe("provider-one");
    env.HOME = "/home/two";
    expect(resolveProviderIdForAuth("fixture", { config: {}, env })).toBe("provider-two");
    expect(pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(
      2,
    );
  });
});
