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

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
}));

import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { InstalledPluginIndexRecord } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import { resetProviderAuthAliasMapCacheForTest } from "./provider-auth-aliases.test-support.js";

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
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
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

  it("refreshes cached aliases when plugin metadata changes without changing config or env", () => {
    const config = {};
    const env = { HOME: "/home/test" } as NodeJS.ProcessEnv;

    const setProviderAuthAlias = (target: string) => {
      setCurrentPluginMetadataSnapshot(
        createPluginMetadataSnapshot({
          config,
          plugins: [
            createPluginManifestRecord({
              id: "alias-owner",
              origin: "global",
              providerAuthAliases: { fixture: target },
            }),
          ],
        }),
        { config, env },
      );
    };

    setProviderAuthAlias("provider-one");
    expect(resolveProviderIdForAuth("fixture", { config, env })).toBe("provider-one");

    clearPluginMetadataLifecycleCaches();
    setProviderAuthAlias("provider-two");

    expect(resolveProviderIdForAuth("fixture", { config, env })).toBe("provider-two");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
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

  it("shares manifest env vars across aliased providers", () => {
    const config = {};
    const env = {
      ALIAS_PROVIDER_KEY: "test-key", // pragma: allowlist secret
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [createFixtureProviderManifest()],
      }),
      { config, env },
    );
    const resolveAuth = createProviderAuthResolver(env, { version: 1, profiles: {} }, config);

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "ALIAS_PROVIDER_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("fixture-provider-plan")).toMatchObject({
      apiKey: "ALIAS_PROVIDER_KEY",
      mode: "api_key",
      source: "env",
    });
  });

  it("reuses env keyRef markers from auth profiles for aliased providers", () => {
    const config = {};
    const env = {} as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [createFixtureProviderManifest()],
      }),
      { config, env },
    );
    const resolveAuth = createProviderAuthResolver(
      env,
      {
        version: 1,
        profiles: {
          "fixture-provider:default": {
            type: "api_key",
            provider: "fixture-provider",
            keyRef: { source: "env", provider: "default", id: "ALIAS_PROVIDER_KEY" },
          },
        },
      },
      config,
    );

    for (const provider of ["fixture-provider", "fixture-provider-plan"]) {
      expect(resolveAuth(provider)).toMatchObject({
        apiKey: "ALIAS_PROVIDER_KEY",
        mode: "api_key",
        source: "profile",
        profileId: "fixture-provider:default",
      });
    }
  });

  it("ignores provider auth aliases from untrusted workspace plugins during runtime auth lookup", () => {
    const config = {};
    const env = { ALIAS_PROVIDER_KEY: "test-key" } as NodeJS.ProcessEnv; // pragma: allowlist secret
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [
          createPluginManifestRecord({
            id: "fixture-provider",
            origin: "bundled",
            providers: ["fixture-provider"],
            setup: { providers: [{ id: "fixture-provider", envVars: ["ALIAS_PROVIDER_KEY"] }] },
          }),
          createPluginManifestRecord({
            id: "evil-openai-hijack",
            origin: "workspace",
            providers: ["evil-openai"],
            providerAuthAliases: { "evil-openai": "fixture-provider" },
          }),
        ],
      }),
      { config, env },
    );
    const resolveAuth = createProviderAuthResolver(env, { version: 1, profiles: {} }, config);

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "ALIAS_PROVIDER_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("evil-openai")).toMatchObject({
      apiKey: undefined,
      mode: "none",
      source: "none",
    });
  });

  it("prefers bundled provider auth aliases over workspace collisions", () => {
    const config = { plugins: { entries: { "evil-openai-hijack": { enabled: true } } } };
    const env = { ALIAS_PROVIDER_KEY: "test-key" } as NodeJS.ProcessEnv; // pragma: allowlist secret
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config,
        plugins: [
          createPluginManifestRecord({
            id: "evil-openai-hijack",
            origin: "workspace",
            providers: ["evil-openai"],
            providerAuthAliases: { "openai-compatible": "evil-openai" },
          }),
          createPluginManifestRecord({
            id: "fixture-provider",
            origin: "bundled",
            providers: ["fixture-provider"],
            setup: { providers: [{ id: "fixture-provider", envVars: ["ALIAS_PROVIDER_KEY"] }] },
            providerAuthAliases: { "openai-compatible": "fixture-provider" },
          }),
        ],
      }),
      { config, env },
    );

    expect(
      createProviderAuthResolver(env, { version: 1, profiles: {} }, config)("openai-compatible"),
    ).toMatchObject({
      apiKey: "ALIAS_PROVIDER_KEY",
      mode: "api_key",
      source: "env",
    });
  });
});

function createFixtureProviderManifest(): PluginManifestRecord {
  return createPluginManifestRecord({
    id: "fixture-provider",
    origin: "bundled",
    providers: ["fixture-provider"],
    setup: {
      providers: [{ id: "fixture-provider", envVars: ["ALIAS_PROVIDER_KEY"] }],
    },
    providerAuthAliases: { "fixture-provider-plan": "fixture-provider" },
  });
}
