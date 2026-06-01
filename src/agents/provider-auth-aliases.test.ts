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

import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  resetProviderAuthAliasMapCacheForTest,
  resolveProviderIdForAuth,
} from "./provider-auth-aliases.js";

describe("provider auth aliases", () => {
  beforeEach(() => {
    clearCurrentPluginMetadataSnapshot();
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
              provider: "openai",
              method: "oauth",
              choiceId: "openai",
              deprecatedChoiceIds: ["codex-cli", "openai-chatgpt-import"],
            },
          ],
        },
      ],
      diagnostics: [],
    });

    expect(resolveProviderIdForAuth("codex-cli")).toBe("openai");
    expect(resolveProviderIdForAuth("openai-chatgpt-import")).toBe("openai");
    expect(resolveProviderIdForAuth("openai")).toBe("openai");
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

  it("uses caller-provided metadata snapshots without loading plugin metadata", () => {
    const env = { HOME: "/home/test" } as NodeJS.ProcessEnv;
    const metadataSnapshot = {
      plugins: [],
    } as never;

    expect(
      resolveProviderIdForAuth("fixture", {
        config: {
          models: {
            providers: {
              fixture: {
                baseUrl: "http://127.0.0.1:1234/v1",
                api: "openai-responses",
                models: [],
              },
            },
          },
        },
        env,
        metadataSnapshot,
      }),
    ).toBe("fixture");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("preserves metadata auth aliases even when the alias is configured as a provider", () => {
    const env = { HOME: "/home/test" } as NodeJS.ProcessEnv;
    const metadataSnapshot = {
      plugins: [
        {
          id: "alias-owner",
          origin: "global",
          providerAuthAliases: { fixture: "provider-two" },
        },
      ],
    } as never;

    expect(
      resolveProviderIdForAuth("fixture", {
        config: {
          models: {
            providers: {
              fixture: {
                baseUrl: "http://127.0.0.1:1234/v1",
                api: "openai-responses",
                models: [],
              },
            },
          },
        },
        env,
        metadataSnapshot,
      }),
    ).toBe("provider-two");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });
});
