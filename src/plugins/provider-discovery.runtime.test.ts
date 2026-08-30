/** Covers provider discovery runtime loading from plugin manifests and registries. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { ProviderPlugin } from "./types.js";

const mocks = vi.hoisted(() => {
  // Bind provider discovery to this file's mocks in non-isolated plugin workers.
  vi.resetModules();
  const loadSource = vi.fn();
  return {
    loadPluginMetadataSnapshot: vi.fn(),
    resolvePluginMetadataSnapshot: vi.fn(),
    resolveDiscoveredProviderPluginIds: vi.fn(),
    resolvePluginProvidersCore: vi.fn(),
    loadSource,
    getCachedPluginModuleLoader: vi.fn(() => loadSource),
  };
});

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-metadata-snapshot.js")>();
  return {
    ...actual,
    loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
    resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
  };
});

vi.mock("./providers.js", () => ({
  resolveDiscoveredProviderPluginIds: mocks.resolveDiscoveredProviderPluginIds,
}));

vi.mock("./providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

vi.mock("./plugin-module-loader-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-module-loader-cache.js")>()),
  getCachedPluginModuleLoader: mocks.getCachedPluginModuleLoader,
}));

import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";

function createManifestPlugin(id: string): PluginManifestRecord {
  return {
    id,
    enabledByDefault: true,
    channels: [],
    providers: [id],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/${id}`,
    source: "bundled",
    manifestPath: `/tmp/${id}/openclaw.plugin.json`,
    providerDiscoverySource: `/tmp/${id}/provider-discovery.ts`,
  };
}

function createManifestPluginWithModelCatalog(
  id: string,
  discovery: "static" | "refreshable" | "runtime" = "static",
): PluginManifestRecord {
  return {
    ...createManifestPluginWithoutDiscovery({ id }),
    modelCatalog: {
      providers: {
        [id]: {
          baseUrl: "https://catalog.example.test/v1",
          api: "openai-responses",
          models: [
            {
              id: "catalog-model",
              name: "Catalog Model",
              reasoning: true,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
              thinkingLevelMap: { off: null, minimal: "low", max: "max" },
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
            },
          ],
        },
      },
      discovery: { [id]: discovery },
    },
  };
}

function createManifestPluginWithMixedCatalogDiscovery(): PluginManifestRecord {
  return {
    ...createManifestPluginWithoutDiscovery({ id: "xiaomi" }),
    providers: ["xiaomi", "xiaomi-token-plan"],
    modelCatalog: {
      providers: {
        xiaomi: {
          baseUrl: "https://api.xiaomimimo.com/v1",
          api: "openai-completions",
          models: [
            {
              id: "mimo-v2-flash",
              name: "MiMo V2 Flash",
              input: ["text"],
              contextWindow: 262144,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
        "xiaomi-token-plan": {
          baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
          api: "openai-completions",
          models: [
            {
              id: "mimo-v2.5-pro",
              name: "MiMo V2.5 Pro",
              input: ["text"],
              contextWindow: 1048576,
              maxTokens: 32000,
              cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
            },
          ],
        },
      },
      discovery: {
        xiaomi: "static",
        "xiaomi-token-plan": "runtime",
      },
    },
  };
}

function createManifestPluginWithRuntimeDiscoveryOnly(id: string): PluginManifestRecord {
  return {
    ...createManifestPluginWithoutDiscovery({ id }),
    modelCatalog: {
      discovery: { [id]: "runtime" },
    },
  };
}

function createManifestPluginWithEntryAndRuntimeDiscovery(): PluginManifestRecord {
  return {
    ...createManifestPlugin("mixed-entry"),
    providers: ["mixed-entry", "runtime-owned"],
    modelCatalog: {
      discovery: { "runtime-owned": "runtime" },
    },
  };
}

function createManifestPluginWithoutDiscovery(params: {
  id: string;
  setupProviders?: NonNullable<PluginManifestRecord["setup"]>["providers"];
}): PluginManifestRecord {
  const { providerDiscoverySource: _providerDiscoverySource, ...plugin } = createManifestPlugin(
    params.id,
  );
  return {
    ...plugin,
    ...(params.setupProviders ? { setup: { providers: params.setupProviders } } : {}),
  };
}

function createProvider(params: { id: string; mode: "static" | "catalog" }): ProviderPlugin {
  const hook = {
    run: async () => ({
      provider: {
        baseUrl: "https://example.test/v1",
        models: [],
      },
    }),
  };
  return {
    id: params.id,
    label: params.id,
    auth: [],
    ...(params.mode === "static" ? { staticCatalog: hook } : { catalog: hook }),
  };
}

function requireResolvePluginProvidersParams(index = 0): {
  onlyPluginIds?: string[];
} {
  const params = (
    mocks.resolvePluginProvidersCore.mock.calls[index] as [unknown] | undefined
  )?.[0] as
    | {
        onlyPluginIds?: string[];
      }
    | undefined;
  if (!params) {
    throw new Error(`resolvePluginProvidersCore call ${index} missing`);
  }
  return params;
}

function requireDiscoveredProviderIdsParams(index = 0): {
  registry?: unknown;
  manifestRegistry?: unknown;
} {
  const params = (
    mocks.resolveDiscoveredProviderPluginIds.mock.calls[index] as [unknown] | undefined
  )?.[0] as
    | {
        registry?: unknown;
        manifestRegistry?: unknown;
      }
    | undefined;
  if (!params) {
    throw new Error(`resolveDiscoveredProviderPluginIds call ${index} missing`);
  }
  return params;
}

describe("resolvePluginDiscoveryProvidersRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["deepseek"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPlugin("deepseek")],
        diagnostics: [],
      },
    });
    mocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: { pluginMetadataSnapshot?: unknown }) =>
        params?.pluginMetadataSnapshot ?? mocks.loadPluginMetadataSnapshot(params),
    );
  });

  it("uses static provider catalog entries without loading the full plugin", () => {
    const staticProvider = createProvider({ id: "deepseek", mode: "static" });
    mocks.loadSource.mockReturnValue(staticProvider);

    expect(resolvePluginDiscoveryProvidersRuntime({})).toEqual([
      { ...staticProvider, pluginId: "deepseek" },
    ]);
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("does not synthesize manifest entry providers for runtime-discovered catalogs", () => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["token-plan"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithModelCatalog("token-plan", "runtime")],
        diagnostics: [],
      },
    });

    expect(resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true })).toStrictEqual(
      [],
    );
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("does not synthesize manifest entry providers for refreshable catalogs", () => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["token-plan"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithModelCatalog("token-plan", "refreshable")],
        diagnostics: [],
      },
    });

    expect(resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true })).toStrictEqual(
      [],
    );
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("loads the full plugin for refreshable manifest catalog rows", () => {
    const refreshableProvider = createProvider({ id: "token-plan", mode: "catalog" });
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["token-plan"]);
    mocks.resolvePluginProvidersCore.mockReturnValue([refreshableProvider]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithModelCatalog("token-plan", "refreshable")],
        diagnostics: [],
      },
    });

    expect(resolvePluginDiscoveryProvidersRuntime({})).toStrictEqual([refreshableProvider]);
    expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(["token-plan"]);
  });

  it("loads the full plugin when one manifest catalog provider is runtime-owned", () => {
    const runtimeProvider = createProvider({ id: "xiaomi-token-plan", mode: "catalog" });
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["xiaomi"]);
    mocks.resolvePluginProvidersCore.mockReturnValue([runtimeProvider]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithMixedCatalogDiscovery()],
        diagnostics: [],
      },
    });

    expect(resolvePluginDiscoveryProvidersRuntime({})).toStrictEqual([runtimeProvider]);
    expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledOnce();
  });

  it("keeps static manifest entries available for mixed runtime-catalog plugins", () => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["xiaomi"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithMixedCatalogDiscovery()],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true });

    expect(providers.map((provider) => provider.id)).toEqual(["xiaomi"]);
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("counts mixed static manifest entries for entries-only complete coverage", () => {
    const entryProvider = createProvider({ id: "deepseek", mode: "static" });
    mocks.loadSource.mockReturnValue(entryProvider);
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["deepseek", "xiaomi"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [
          createManifestPlugin("deepseek"),
          createManifestPluginWithMixedCatalogDiscovery(),
        ],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({
      discoveryEntriesOnly: true,
      requireCompleteDiscoveryEntryCoverage: true,
    });

    expect(providers.map((provider) => provider.id)).toEqual(["xiaomi", "deepseek"]);
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("loads mixed runtime-catalog plugins even when other static entries exist", () => {
    const runtimeProvider = createProvider({ id: "xiaomi-token-plan", mode: "catalog" });
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["deepseek", "xiaomi"]);
    mocks.resolvePluginProvidersCore.mockReturnValue([runtimeProvider]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [
          createManifestPluginWithModelCatalog("deepseek"),
          createManifestPluginWithMixedCatalogDiscovery(),
        ],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({});

    expect(providers.map((provider) => provider.id)).toEqual(["deepseek", "xiaomi-token-plan"]);
    expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(["xiaomi"]);
  });

  it("loads runtime-only catalog plugins declared without manifest rows", () => {
    const runtimeProvider = createProvider({ id: "runtime-only", mode: "catalog" });
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["deepseek", "runtime-only"]);
    mocks.resolvePluginProvidersCore.mockReturnValue([runtimeProvider]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [
          createManifestPluginWithModelCatalog("deepseek"),
          createManifestPluginWithRuntimeDiscoveryOnly("runtime-only"),
        ],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({});

    expect(providers.map((provider) => provider.id)).toEqual(["deepseek", "runtime-only"]);
    expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(["runtime-only"]);
  });

  it("scopes full loading for a single runtime-only catalog plugin without manifest rows", () => {
    const runtimeProvider = createProvider({ id: "runtime-only", mode: "catalog" });
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["runtime-only"]);
    mocks.resolvePluginProvidersCore.mockReturnValue([runtimeProvider]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithRuntimeDiscoveryOnly("runtime-only")],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({});

    expect(providers.map((provider) => provider.id)).toEqual(["runtime-only"]);
    expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(["runtime-only"]);
  });

  it("full-loads runtime-owned catalog plugins even when they have discovery entries", () => {
    const entryProvider = createProvider({ id: "mixed-entry", mode: "static" });
    const runtimeProvider = createProvider({ id: "runtime-owned", mode: "catalog" });
    mocks.loadSource.mockReturnValue(entryProvider);
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["mixed-entry"]);
    mocks.resolvePluginProvidersCore.mockReturnValue([runtimeProvider]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithEntryAndRuntimeDiscovery()],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({});

    expect(providers.map((provider) => provider.id)).toEqual(["runtime-owned"]);
    expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(["mixed-entry"]);
  });

  it("loads discovery entries through the native-capable module loader", () => {
    const staticProvider = createProvider({ id: "deepseek", mode: "static" });
    mocks.loadSource.mockReturnValue(staticProvider);

    expect(resolvePluginDiscoveryProvidersRuntime({})).toEqual([
      { ...staticProvider, pluginId: "deepseek" },
    ]);

    expect(mocks.getCachedPluginModuleLoader).toHaveBeenCalledOnce();
    const calls = mocks.getCachedPluginModuleLoader.mock.calls as unknown[][];
    const params = calls[0]?.[0] as
      | {
          modulePath?: string;
          importerUrl?: string;
          loaderFilename?: string;
          preferBuiltDist?: boolean;
          tryNative?: boolean;
        }
      | undefined;
    expect(params).toEqual(
      expect.objectContaining({
        modulePath: "/tmp/deepseek/provider-discovery.ts",
        importerUrl: expect.stringContaining("provider-discovery.runtime"),
        loaderFilename: expect.stringContaining("provider-discovery.runtime"),
        preferBuiltDist: true,
      }),
    );
    expect(params?.tryNative).toBeUndefined();
  });

  it("keeps unscoped discovery bounded for mixed live and static-only entries", () => {
    const codexEntryProvider = createProvider({ id: "codex", mode: "catalog" });
    const deepseekEntryProvider = createProvider({ id: "deepseek", mode: "static" });
    const fullProviders = [createProvider({ id: "kilocode", mode: "catalog" })];
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue([
      "codex",
      "deepseek",
      "kilocode",
      "unused",
    ]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [
          createManifestPlugin("codex"),
          createManifestPlugin("deepseek"),
          createManifestPluginWithoutDiscovery({
            id: "kilocode",
            setupProviders: [{ id: "kilocode", envVars: ["KILOCODE_API_KEY"] }],
          }),
          createManifestPluginWithoutDiscovery({
            id: "unused",
            setupProviders: [{ id: "unused", envVars: ["UNUSED_API_KEY"] }],
          }),
        ],
        diagnostics: [],
      },
    });
    mocks.loadSource.mockImplementation((modulePath: string) =>
      modulePath.includes("/codex/") ? codexEntryProvider : deepseekEntryProvider,
    );
    mocks.resolvePluginProvidersCore.mockReturnValue(fullProviders);

    expect(
      resolvePluginDiscoveryProvidersRuntime({
        env: { KILOCODE_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      }),
    ).toEqual([
      { ...codexEntryProvider, pluginId: "codex" },
      { ...deepseekEntryProvider, pluginId: "deepseek" },
      ...fullProviders,
    ]);
    expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
    const params = requireResolvePluginProvidersParams();
    expect(params.onlyPluginIds).toEqual(["kilocode"]);
  });

  it("falls back to full provider plugins when setup provider env vars are configured", () => {
    const codexEntryProvider = createProvider({ id: "codex", mode: "catalog" });
    const fullProviders = [createProvider({ id: "kilocode", mode: "catalog" })];
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["codex", "kilocode"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [
          createManifestPlugin("codex"),
          createManifestPluginWithoutDiscovery({
            id: "kilocode",
            setupProviders: [{ id: "kilocode", envVars: ["KILOCODE_API_KEY"] }],
          }),
        ],
        diagnostics: [],
      },
    });
    mocks.loadSource.mockReturnValue(codexEntryProvider);
    mocks.resolvePluginProvidersCore.mockReturnValue(fullProviders);

    expect(
      resolvePluginDiscoveryProvidersRuntime({
        env: { KILOCODE_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      }),
    ).toEqual([{ ...codexEntryProvider, pluginId: "codex" }, ...fullProviders]);
    expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
    const params = requireResolvePluginProvidersParams();
    expect(params.onlyPluginIds).toEqual(["kilocode"]);
  });

  it("shares one metadata snapshot between provider id discovery and entry loading", () => {
    const registry = { plugins: [] };
    const manifestRegistry = {
      plugins: [createManifestPlugin("deepseek")],
      diagnostics: [],
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: registry,
      manifestRegistry,
    });
    mocks.loadSource.mockReturnValue(createProvider({ id: "deepseek", mode: "catalog" }));

    resolvePluginDiscoveryProvidersRuntime({ config: {}, env: {} as NodeJS.ProcessEnv });

    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        env: {},
      }),
    );
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
    expect(mocks.resolveDiscoveredProviderPluginIds).toHaveBeenCalledTimes(1);
    const params = requireDiscoveredProviderIdsParams();
    expect(params.registry).toBe(registry);
    expect(params.manifestRegistry).toBe(manifestRegistry);
  });

  it("uses a provided plugin metadata snapshot without rebuilding registry metadata", () => {
    const registry = { plugins: [] };
    const manifestRegistry = {
      plugins: [createManifestPlugin("deepseek")],
      diagnostics: [],
    };
    mocks.loadSource.mockReturnValue(createProvider({ id: "deepseek", mode: "catalog" }));

    const providers = resolvePluginDiscoveryProvidersRuntime({
      config: {},
      env: {} as NodeJS.ProcessEnv,
      pluginMetadataSnapshot: {
        index: registry as never,
        manifestRegistry,
      },
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("deepseek");
    expect(providers[0]?.pluginId).toBe("deepseek");

    expect(mocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(mocks.resolveDiscoveredProviderPluginIds).toHaveBeenCalledTimes(1);
    const params = requireDiscoveredProviderIdsParams();
    expect(params.registry).toBe(registry);
    expect(params.manifestRegistry).toBe(manifestRegistry);
  });

  it("returns static-only discovery entries for callers that explicitly request them", () => {
    const staticProvider = createProvider({ id: "deepseek", mode: "static" });
    mocks.loadSource.mockReturnValue(staticProvider);

    const providers = resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("deepseek");
    expect(providers[0]?.pluginId).toBe("deepseek");
    expect(providers[0]?.staticCatalog).toBe(staticProvider.staticCatalog);
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("returns synthetic-auth discovery entries only when explicitly requested", () => {
    const syntheticProvider: ProviderPlugin = {
      id: "claude-cli",
      label: "Claude CLI",
      auth: [],
      resolveSyntheticAuth: () => ({
        apiKey: "synthetic-token",
        source: "test",
        mode: "oauth",
      }),
    };
    mocks.loadSource.mockReturnValue(syntheticProvider);

    expect(resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true })).toEqual([]);
    const providers = resolvePluginDiscoveryProvidersRuntime({
      discoveryEntriesOnly: true,
      includeSyntheticAuthProviders: true,
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: "claude-cli", pluginId: "deepseek" });
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("returns manifest model catalogs as static discovery entries", async () => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["openai"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithModelCatalog("openai")],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true });

    expect(providers.map((provider) => provider.id)).toEqual(["openai"]);
    expect(providers[0]?.pluginId).toBe("openai");
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
    await expect(
      providers[0]?.staticCatalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).resolves.toEqual({
      providers: {
        openai: {
          baseUrl: "https://catalog.example.test/v1",
          api: "openai-responses",
          models: [
            expect.objectContaining({
              id: "catalog-model",
              name: "Catalog Model",
              reasoning: true,
              thinkingLevelMap: { off: null, minimal: "low", max: "max" },
            }),
          ],
        },
      },
    });
  });

  it("does not expose runtime-only manifest model catalogs as static discovery entries", () => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["xiaomi-token-plan"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithModelCatalog("xiaomi-token-plan", "runtime")],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true });

    expect(providers).toStrictEqual([]);
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("can omit manifest model catalogs from static discovery entries", () => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["openai"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithModelCatalog("openai")],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({
      discoveryEntriesOnly: true,
      includeManifestModelCatalogProviders: false,
    });

    expect(providers).toStrictEqual([]);
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing",
      cost: undefined,
      expectedCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      name: "partial",
      cost: { input: 3, output: 15, cacheRead: 0.3 },
      expectedCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    },
  ])("defaults only $name manifest model cost components", async ({ cost, expectedCost }) => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["anthropic"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [
          {
            ...createManifestPluginWithModelCatalog("anthropic"),
            modelCatalog: {
              providers: {
                anthropic: {
                  baseUrl: "https://api.anthropic.com",
                  api: "anthropic-messages",
                  models: [
                    {
                      id: "claude-sonnet-4-6",
                      name: "Claude Sonnet 4.6",
                      reasoning: true,
                      input: ["text"],
                      contextWindow: 200000,
                      maxTokens: 64000,
                      ...(cost ? { cost } : {}),
                    },
                  ],
                },
              },
              discovery: { anthropic: "static" },
            },
          },
        ],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true });

    await expect(
      providers[0]?.staticCatalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).resolves.toEqual({
      providers: {
        anthropic: expect.objectContaining({
          models: [
            expect.objectContaining({
              id: "claude-sonnet-4-6",
              cost: expectedCost,
            }),
          ],
        }),
      },
    });
  });

  it("ignores manifest model catalogs that cannot form valid models.json providers", () => {
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["anthropic"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [
          {
            ...createManifestPluginWithModelCatalog("anthropic"),
            modelCatalog: {
              providers: {
                "claude-cli": {
                  models: [
                    {
                      id: "claude-sonnet-4-6",
                      name: "Claude Sonnet 4.6",
                      reasoning: true,
                      input: ["text"],
                      contextWindow: 200000,
                      maxTokens: 64000,
                    },
                  ],
                },
                anthropic: {
                  baseUrl: "https://api.anthropic.com",
                  api: "anthropic-messages",
                  models: [
                    {
                      id: "claude-sonnet-4-6",
                      name: "Claude Sonnet 4.6",
                      reasoning: true,
                      input: ["text"],
                      contextWindow: 200000,
                      maxTokens: 64000,
                    },
                  ],
                },
              },
              discovery: { "claude-cli": "static", anthropic: "static" },
            },
          },
        ],
        diagnostics: [],
      },
    });

    const providers = resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true });

    expect(providers.map((provider) => provider.id)).toEqual(["anthropic"]);
  });

  it.each(["static", "runtime", "refreshable"] as const)(
    "keeps scoped providers without entries beside a %s manifest catalog",
    (discovery) => {
      const dynamicProvider = createProvider({ id: "minimax", mode: "catalog" });
      mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["minimax", "openai"]);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        index: { plugins: [] },
        manifestRegistry: {
          plugins: [
            createManifestPluginWithoutDiscovery({ id: "minimax" }),
            createManifestPluginWithModelCatalog("openai", discovery),
          ],
          diagnostics: [],
        },
      });
      mocks.resolvePluginProvidersCore.mockImplementation(
        ({ onlyPluginIds }: { onlyPluginIds: string[] }) =>
          [dynamicProvider, createProvider({ id: "openai", mode: "catalog" })].filter((provider) =>
            onlyPluginIds.includes(provider.id),
          ),
      );

      const providers = resolvePluginDiscoveryProvidersRuntime({
        onlyPluginIds: ["minimax", "openai"],
      });

      expect(providers.map((provider) => provider.id).toSorted()).toEqual(["minimax", "openai"]);
      expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
      expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(
        discovery === "static" ? ["minimax"] : ["minimax", "openai"],
      );
    },
  );

  it.each([
    { discovery: "runtime" as const, credential: true },
    { discovery: "runtime" as const, credential: false },
    { discovery: "refreshable" as const, credential: true },
    { discovery: "refreshable" as const, credential: false },
  ])(
    "bounds unscoped $discovery discovery with missing-entry credential=$credential",
    ({ discovery, credential }) => {
      mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["router", "manifest"]);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        index: { plugins: [] },
        manifestRegistry: {
          plugins: [
            createManifestPluginWithoutDiscovery({
              id: "router",
              setupProviders: [{ id: "router", envVars: ["ROUTER_API_KEY"] }],
            }),
            createManifestPluginWithModelCatalog("manifest", discovery),
          ],
          diagnostics: [],
        },
      });
      mocks.resolvePluginProvidersCore.mockImplementation(
        ({ onlyPluginIds }: { onlyPluginIds: string[] }) =>
          onlyPluginIds.map((id) => createProvider({ id, mode: "catalog" })),
      );

      const providers = resolvePluginDiscoveryProvidersRuntime({
        env: credential ? { ROUTER_API_KEY: "catalog-test-key" } : {},
      });
      expect(providers.map((provider) => provider.id)).toEqual(
        credential ? ["manifest", "router"] : ["manifest"],
      );
    },
  );

  it.each(
    [
      { scope: "selected", expectedFullIds: ["broken", "healthy"] },
      { scope: "unscoped", expectedFullIds: ["healthy"] },
      { scope: "entries-only", expectedFullIds: [] },
    ].flatMap(({ scope, expectedFullIds }) =>
      ["first", "last"].map((failurePosition) => ({ scope, expectedFullIds, failurePosition })),
    ),
  )(
    "recovers discarded discovery entries with $scope scope when failure is $failurePosition",
    ({ scope, expectedFullIds, failurePosition }) => {
      const healthy = {
        ...createManifestPlugin("healthy"),
        setup: { providers: [{ id: "healthy", envVars: ["HEALTHY_API_KEY"] }] },
      };
      const broken = createManifestPlugin("broken");
      mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["static", "healthy", "broken"]);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        index: { plugins: [] },
        manifestRegistry: {
          plugins: [
            createManifestPluginWithModelCatalog("static"),
            ...(failurePosition === "first" ? [broken, healthy] : [healthy, broken]),
          ],
          diagnostics: [],
        },
      });
      mocks.loadSource.mockImplementation((modulePath: string) => {
        if (modulePath === broken.providerDiscoverySource) {
          throw new Error("discovery entry unavailable");
        }
        return { ...createProvider({ id: "healthy", mode: "catalog" }), label: "entry" };
      });
      const fullProviders = expectedFullIds.map((id) => ({
        ...createProvider({ id, mode: "catalog" }),
        label: `full:${id}`,
      }));
      mocks.resolvePluginProvidersCore.mockReturnValue(fullProviders);

      const providers = resolvePluginDiscoveryProvidersRuntime({
        env: { HEALTHY_API_KEY: "catalog-test-key" },
        ...(scope === "unscoped" ? {} : { onlyPluginIds: ["static", "healthy", "broken"] }),
        discoveryEntriesOnly: scope === "entries-only",
      });

      expect(providers.map(({ id, label }) => [id, label])).toEqual([
        ["static", "static"],
        ...fullProviders.map(({ id, label }) => [id, label]),
      ]);
      if (expectedFullIds.length === 0) {
        expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
      } else {
        expect(mocks.resolvePluginProvidersCore).toHaveBeenCalledOnce();
        expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(expectedFullIds);
      }
    },
  );

  it("does not fall back to full plugin loading when discovery entries are requested only", () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [createManifestPluginWithoutDiscovery({ id: "deepseek" })],
        diagnostics: [],
      },
    });

    expect(resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true })).toStrictEqual(
      [],
    );
    expect(resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true })).toStrictEqual(
      [],
    );
    expect(mocks.resolvePluginProvidersCore).not.toHaveBeenCalled();
  });
});
