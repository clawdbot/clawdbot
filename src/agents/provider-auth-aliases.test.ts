/**
 * Regression coverage for provider auth alias resolution.
 * Verifies plugin metadata aliases, origin priority, trust, and cache behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginRegistryMocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
    resolveInstalledManifestRegistryIndexFingerprint: vi.fn(() => "test-index"),
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
  resolveInstalledManifestRegistryIndexFingerprint:
    pluginRegistryMocks.resolveInstalledManifestRegistryIndexFingerprint,
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
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { InstalledPluginIndexRecord } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  resetProviderAuthAliasMapCacheForTest,
  resolveProviderIdForAuth,
} from "./provider-auth-aliases.js";

function createPluginManifestRecord(
  plugin: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id" | "origin">,
): PluginManifestRecord {
  return {
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    rootDir: `/plugins/${plugin.id}`,
    source: `/plugins/${plugin.id}`,
    manifestPath: `/plugins/${plugin.id}/.codex-plugin/plugin.json`,
    ...plugin,
  };
}

function createInstalledPluginIndexRecord(
  plugin: PluginManifestRecord,
): InstalledPluginIndexRecord {
  return {
    pluginId: plugin.id,
    manifestPath: plugin.manifestPath,
    manifestHash: `${plugin.id}:manifest`,
    rootDir: plugin.rootDir,
    origin: plugin.origin,
    enabled: true,
    enabledByDefault: true,
    startup: {
      sidecar: false,
      memory: false,
      deferConfiguredChannelFullLoadUntilAfterListen: false,
      agentHarnesses: [],
    },
    compat: [],
  };
}

function createPluginMetadataSnapshot(params: {
  config?: Parameters<typeof resolveInstalledPluginIndexPolicyHash>[0];
  plugins: readonly PluginManifestRecord[];
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  return {
    policyHash,
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: params.plugins.map((plugin) => createInstalledPluginIndexRecord(plugin)),
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins: [...params.plugins], diagnostics: [] },
    plugins: params.plugins,
    diagnostics: [],
    byPluginId: new Map(params.plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: params.plugins.length,
      manifestPluginCount: params.plugins.length,
    },
  };
}

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
    const metadataSnapshot = createPluginMetadataSnapshot({
      plugins: [
        createPluginManifestRecord({
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
        }),
      ],
    });

    expect(resolveProviderIdForAuth("codex-cli", { metadataSnapshot })).toBe("openai");
    expect(resolveProviderIdForAuth("openai-chatgpt-import", { metadataSnapshot })).toBe("openai");
    expect(resolveProviderIdForAuth("openai", { metadataSnapshot })).toBe("openai");
  });

  it("does not reuse aliases across env-resolved plugin roots", () => {
    const config = {};
    const env = {
      HOME: "/home/one",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [
          createPluginManifestRecord({
            id: "one",
            origin: "global",
            providerAuthAliases: { fixture: "provider-one" },
          }),
        ],
      }),
      { config, env },
    );

    expect(resolveProviderIdForAuth("fixture", { config, env })).toBe("provider-one");
    env.HOME = "/home/two";
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [
          createPluginManifestRecord({
            id: "two",
            origin: "global",
            providerAuthAliases: { fixture: "provider-two" },
          }),
        ],
      }),
      { config, env },
    );

    expect(resolveProviderIdForAuth("fixture", { config, env })).toBe("provider-two");
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
