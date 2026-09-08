/**
 * Regression coverage for provider auth alias resolution.
 * Verifies plugin metadata aliases, origin priority, trust, and cache behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeclaredProviderOwnerIndex } from "../plugins/provider-owner-index.js";

const pluginRegistryMocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshotWithMetadata: vi.fn(() => ({ snapshot: { plugins: [] } })),
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
  loadPluginRegistrySnapshotWithMetadata:
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
}));

import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { InstalledPluginIndexRecord } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { snapshotReaderSlot } from "../plugins/plugin-metadata-snapshot-readers.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";
import { resolveProviderAuthAliasMap, resolveProviderIdForAuth } from "./provider-auth-aliases.js";

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
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 1,
    installRecords: {},
    plugins: params.plugins.map((plugin) => createInstalledPluginIndexRecord(plugin)),
    diagnostics: [],
  };
  return {
    policyHash,
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins: [...params.plugins], diagnostics: [] },
    plugins: params.plugins,
    diagnostics: [],
    byPluginId: new Map(params.plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId,
    declaredProviderOwners: buildDeclaredProviderOwnerIndex(params.plugins),
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
      modelIdNormalizationPolicies: new Map(),
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

async function prepareAliasSnapshot(plugins: PluginManifestRecord[]) {
  const readers = Object.getOwnPropertyDescriptors(snapshotReaderSlot);
  try {
    const metadata = await vi.importActual<typeof import("../plugins/plugin-metadata-snapshot.js")>(
      "../plugins/plugin-metadata-snapshot.js",
    );
    const source = createPluginMetadataSnapshot({ plugins });
    const snapshot = metadata.restorePluginMetadataSnapshot(
      metadata.rebasePluginMetadataSnapshotManifestRegistry(source, source.manifestRegistry),
    );
    return { metadata, snapshot };
  } finally {
    // importActual retains this fixture's mocked dependencies. Its readers must
    // not outlive the fixture or replace another file's provider metadata.
    for (const key of Reflect.ownKeys(snapshotReaderSlot)) {
      Reflect.deleteProperty(snapshotReaderSlot, key);
    }
    Object.defineProperties(snapshotReaderSlot, readers);
  }
}

describe("provider auth aliases", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      snapshot: { plugins: [] },
    });
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
  });

  it("does not enumerate alias metadata again after snapshot preparation", async () => {
    const enumerateAliases = vi.fn(Reflect.ownKeys);
    const { snapshot } = await prepareAliasSnapshot([
      createPluginManifestRecord({
        id: "selected",
        origin: "bundled",
        providerAuthAliases: { selected: "selected-provider" },
      }),
      createPluginManifestRecord({
        id: "unrelated",
        origin: "bundled",
        providerAuthAliases: new Proxy<Record<string, string>>(
          { unrelated: "unrelated-provider" },
          {
            ownKeys: enumerateAliases,
          },
        ),
      }),
    ]);
    enumerateAliases.mockClear();

    for (let repeat = 0; repeat < 8; repeat += 1) {
      expect(resolveProviderIdForAuth("selected", { metadataSnapshot: snapshot })).toBe(
        "selected-provider",
      );
      expect(resolveProviderIdForAuth("unrelated", { metadataSnapshot: snapshot })).toBe(
        "unrelated-provider",
      );
      expect(resolveProviderIdForAuth("missing", { metadataSnapshot: snapshot })).toBe("missing");
    }
    expect(enumerateAliases).not.toHaveBeenCalled();
  });

  it("preserves alias precedence, normalized collisions and eligible declaration order", async () => {
    const { snapshot } = await prepareAliasSnapshot([
      createPluginManifestRecord({
        id: "early-workspace",
        origin: "workspace",
        providerAuthAliases: { "early-only": "workspace", shared: "workspace" },
      }),
      createPluginManifestRecord({
        id: "first-global",
        origin: "global",
        providerAuthAliases: {
          "duplicate ": "later-raw-alias",
          duplicate: "first-raw-alias",
          middle: "first-global",
          shared: "global",
        },
        providerAuthChoices: [
          {
            provider: "choice-provider",
            method: "oauth",
            choiceId: "choice",
            deprecatedChoiceIds: ["legacy", "duplicate"],
          },
        ],
      }),
      createPluginManifestRecord({
        id: "later-bundled",
        origin: "bundled",
        providerAuthAliases: { shared: "bundled", tail: "bundled" },
      }),
      createPluginManifestRecord({
        id: "same-priority",
        origin: "global",
        providerAuthAliases: { middle: "later-global" },
      }),
      createPluginManifestRecord({
        id: "configured",
        origin: "config",
        providerAuthAliases: { shared: "configured" },
      }),
    ]);
    const withoutWorkspace = resolveProviderAuthAliasMap({ metadataSnapshot: snapshot });
    expect(Object.keys(withoutWorkspace)).toEqual([
      "duplicate",
      "middle",
      "shared",
      "legacy",
      "tail",
    ]);
    expect(withoutWorkspace).toEqual({
      duplicate: "first-raw-alias",
      middle: "first-global",
      shared: "configured",
      legacy: "choice-provider",
      tail: "bundled",
    });
    const withWorkspace = resolveProviderAuthAliasMap({
      config: { plugins: { allow: ["early-workspace"] } },
      metadataSnapshot: snapshot,
    });
    expect(Object.keys(withWorkspace)).toEqual([
      "early-only",
      "shared",
      "duplicate",
      "middle",
      "legacy",
      "tail",
    ]);
    for (const [alias, target] of Object.entries(withWorkspace)) {
      expect(
        resolveProviderIdForAuth(alias, {
          config: { plugins: { allow: ["early-workspace"] } },
          metadataSnapshot: snapshot,
        }),
      ).toBe(target);
    }
    const proto = resolveProviderAuthAliasMap({
      metadataSnapshot: {
        plugins: [
          createPluginManifestRecord({
            id: "prototype-alias",
            origin: "bundled",
            providerAuthAliases: { ["__proto__"]: "prototype-provider" },
          }),
        ],
      },
    });
    expect(Object.getPrototypeOf(withWorkspace)).toBeNull();
    expect(Object.getPrototypeOf(proto)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(proto, "__proto__")?.value).toBe("prototype-provider");
    withoutWorkspace.shared = "caller-mutation";
    expect(resolveProviderIdForAuth("shared", { metadataSnapshot: snapshot })).toBe("configured");
  });

  it("rechecks workspace trust against current config within one prepared snapshot", async () => {
    const { snapshot } = await prepareAliasSnapshot([
      createPluginManifestRecord({
        id: "first-workspace",
        origin: "workspace",
        providerAuthAliases: { shared: "first-provider" },
      }),
      createPluginManifestRecord({
        id: "second-workspace",
        origin: "workspace",
        providerAuthAliases: { shared: "second-provider" },
      }),
    ]);
    const config: NonNullable<Parameters<typeof resolveProviderIdForAuth>[1]>["config"] = {};
    const resolve = () =>
      resolveProviderIdForAuth("shared", { config, metadataSnapshot: snapshot });
    expect(resolve()).toBe("shared");
    config.plugins = { allow: ["first-workspace", "second-workspace"] };
    expect(resolve()).toBe("first-provider");
    config.plugins.deny = ["first-workspace"];
    expect(resolve()).toBe("second-provider");
    config.plugins.entries = { "second-workspace": { enabled: false } };
    expect(resolve()).toBe("shared");
    config.plugins = { slots: { contextEngine: "first-workspace" } };
    expect(resolve()).toBe("first-provider");
    config.plugins.enabled = false;
    expect(resolve()).toBe("shared");
    expect(
      resolveProviderIdForAuth("shared", {
        config,
        metadataSnapshot: snapshot,
        includeUntrustedWorkspacePlugins: true,
      }),
    ).toBe("first-provider");
  });

  it("keeps public partial metadata views fresh when the caller mutates them", () => {
    const aliases = { fixture: "first-provider" };
    const plugins = [
      createPluginManifestRecord({
        id: "mutable-view",
        origin: "global",
        providerAuthAliases: aliases,
      }),
    ];
    const metadataSnapshot = { plugins };
    expect(resolveProviderIdForAuth("fixture", { metadataSnapshot })).toBe("first-provider");
    aliases.fixture = "second-provider";
    expect(resolveProviderIdForAuth("fixture", { metadataSnapshot })).toBe("second-provider");
    plugins.push(
      createPluginManifestRecord({
        id: "added-view",
        origin: "bundled",
        providerAuthAliases: { added: "added-provider" },
      }),
    );
    expect(resolveProviderIdForAuth("added", { metadataSnapshot })).toBe("added-provider");
  });

  it("retains alias ownership through worker cloning, projection and metadata replacement", async () => {
    const { metadata, snapshot } = await prepareAliasSnapshot([
      createPluginManifestRecord({
        id: "first",
        origin: "bundled",
        providerAuthAliases: { fixture: "first-provider" },
      }),
      createPluginManifestRecord({
        id: "second",
        origin: "bundled",
        providerAuthAliases: { second: "second-provider" },
      }),
    ]);
    const { normalizePluginId: _normalizePluginId, ...serialized } = snapshot;
    const restored = metadata.restorePluginMetadataSnapshot(structuredClone(serialized));
    expect(resolveProviderAuthAliasMap({ metadataSnapshot: restored })).toEqual({
      fixture: "first-provider",
      second: "second-provider",
    });
    const projected = metadata.projectPluginMetadataSnapshot(restored, ["second"]);
    expect(resolveProviderIdForAuth("fixture", { metadataSnapshot: projected })).toBe("fixture");
    expect(resolveProviderIdForAuth("second", { metadataSnapshot: projected })).toBe(
      "second-provider",
    );
    const replacement = metadata.rebasePluginMetadataSnapshotManifestRegistry(restored, {
      plugins: [
        createPluginManifestRecord({
          id: "first",
          origin: "bundled",
          providerAuthAliases: { fixture: "replacement-provider" },
        }),
      ],
      diagnostics: [],
    });
    expect(resolveProviderIdForAuth("fixture", { metadataSnapshot: replacement })).toBe(
      "replacement-provider",
    );
    expect(resolveProviderIdForAuth("fixture", { metadataSnapshot: restored })).toBe(
      "first-provider",
    );
  });

  it("does not reuse implicit auth aliases across fresh operation owners", () => {
    const config = {};
    const env = { HOME: "/home/owner-test" };
    const firstOwner = createPluginCache();
    const secondOwner = createPluginCache();
    const snapshot = (target: string) =>
      createPluginMetadataSnapshot({
        config,
        plugins: [
          createPluginManifestRecord({
            id: "owner-fixture",
            origin: "bundled",
            providerAuthAliases: { fixture: target },
          }),
        ],
      });
    const firstSnapshot = snapshot("first-provider");
    const secondSnapshot = snapshot("second-provider");
    pluginRegistryMocks.loadPluginMetadataSnapshot.withImplementation(
      () => (getPluginCache() === firstOwner ? firstSnapshot : secondSnapshot),
      () => {
        expect(
          withPluginCache(firstOwner, () => resolveProviderIdForAuth("fixture", { config, env })),
        ).toBe("first-provider");
        expect(
          withPluginCache(secondOwner, () => resolveProviderIdForAuth("fixture", { config, env })),
        ).toBe("second-provider");
        expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(2);
      },
    );
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
