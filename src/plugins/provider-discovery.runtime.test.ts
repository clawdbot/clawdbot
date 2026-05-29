import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { ProviderPlugin } from "./types.js";

const mocks = vi.hoisted(() => {
  const loadSource = vi.fn();
  const loaderCache = { kind: "provider-discovery-loader-cache", clear: vi.fn() };
  return {
    loadPluginMetadataSnapshot: vi.fn(),
    resolvePluginMetadataSnapshot: vi.fn(),
    resolveDiscoveredProviderPluginIds: vi.fn(),
    resolvePluginProviders: vi.fn(),
    loadSource,
    loaderCache,
    clearNativeRequireJavaScriptModuleCache: vi.fn(),
    createPluginModuleLoaderCache: vi.fn(() => loaderCache),
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
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("./plugin-module-loader-cache.js", () => ({
  createPluginModuleLoaderCache: mocks.createPluginModuleLoaderCache,
  getCachedPluginModuleLoader: mocks.getCachedPluginModuleLoader,
}));

vi.mock("./native-module-require.js", () => ({
  clearNativeRequireJavaScriptModuleCache: mocks.clearNativeRequireJavaScriptModuleCache,
}));

import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
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

function createManifestPluginWithModelCatalog(id: string): PluginManifestRecord {
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
              cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
            },
          ],
        },
      },
      discovery: { [id]: "static" },
    },
  };
}

function createManifestPluginWithoutDiscovery(params: {
  id: string;
  providerAuthEnvVars?: Record<string, string[]>;
  setupProviders?: NonNullable<PluginManifestRecord["setup"]>["providers"];
}): PluginManifestRecord {
  const { providerDiscoverySource: _providerDiscoverySource, ...plugin } = createManifestPlugin(
    params.id,
  );
  return {
    ...plugin,
    ...(params.setupProviders ? { setup: { providers: params.setupProviders } } : {}),
    ...(params.providerAuthEnvVars ? { providerAuthEnvVars: params.providerAuthEnvVars } : {}),
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
  const params = (mocks.resolvePluginProviders.mock.calls[index] as [unknown] | undefined)?.[0] as
    | {
        onlyPluginIds?: string[];
      }
    | undefined;
  if (!params) {
    throw new Error(`resolvePluginProviders call ${index} missing`);
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
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
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
          cache?: unknown;
          modulePath?: string;
          importerUrl?: string;
          loaderFilename?: string;
          preferBuiltDist?: boolean;
          tryNative?: boolean;
        }
      | undefined;
    expect(params).toEqual(
      expect.objectContaining({
        cache: mocks.loaderCache,
        modulePath: "/tmp/deepseek/provider-discovery.ts",
        importerUrl: expect.stringContaining("provider-discovery.runtime"),
        loaderFilename: expect.stringContaining("provider-discovery.runtime"),
        preferBuiltDist: true,
      }),
    );
    expect(params?.tryNative).toBeUndefined();
  });

  it("clears the discovery module loader cache with plugin metadata lifecycle caches", () => {
    const staticProvider = createProvider({ id: "deepseek", mode: "static" });
    mocks.loadSource.mockReturnValue(staticProvider);

    resolvePluginDiscoveryProvidersRuntime({});
    clearPluginMetadataLifecycleCaches();

    expect(mocks.loaderCache.clear).toHaveBeenCalledOnce();
    expect(mocks.clearNativeRequireJavaScriptModuleCache).toHaveBeenCalledWith(
      "/tmp/deepseek/provider-discovery.ts",
      { dependencyRoot: "/tmp/deepseek" },
    );
  });

  it("clears bundled dist discovery chunks from the dist root", () => {
    const staticProvider = createProvider({ id: "deepseek", mode: "static" });
    mocks.loadSource.mockReturnValue(staticProvider);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [
          {
            ...createManifestPlugin("deepseek"),
            rootDir: "/tmp/openclaw/dist/extensions/deepseek",
            manifestPath: "/tmp/openclaw/dist/extensions/deepseek/openclaw.plugin.json",
            providerDiscoverySource: "/tmp/openclaw/dist/extensions/deepseek/provider-discovery.js",
          },
        ],
        diagnostics: [],
      },
    });

    resolvePluginDiscoveryProvidersRuntime({});
    clearPluginMetadataLifecycleCaches();

    expect(mocks.clearNativeRequireJavaScriptModuleCache).toHaveBeenCalledWith(
      "/tmp/openclaw/dist/extensions/deepseek/provider-discovery.js",
      { dependencyRoot: "/tmp/openclaw/dist" },
    );
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
            providerAuthEnvVars: { kilocode: ["KILOCODE_API_KEY"] },
          }),
          createManifestPluginWithoutDiscovery({
            id: "unused",
            providerAuthEnvVars: { unused: ["UNUSED_API_KEY"] },
          }),
        ],
        diagnostics: [],
      },
    });
    mocks.loadSource.mockImplementation((modulePath: string) =>
      modulePath.includes("/codex/") ? codexEntryProvider : deepseekEntryProvider,
    );
    mocks.resolvePluginProviders.mockReturnValue(fullProviders);

    expect(
      resolvePluginDiscoveryProvidersRuntime({
        env: { KILOCODE_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      }),
    ).toEqual([
      { ...codexEntryProvider, pluginId: "codex" },
      { ...deepseekEntryProvider, pluginId: "deepseek" },
      ...fullProviders,
    ]);
    expect(mocks.resolvePluginProviders).toHaveBeenCalledTimes(1);
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
    mocks.resolvePluginProviders.mockReturnValue(fullProviders);

    expect(
      resolvePluginDiscoveryProvidersRuntime({
        env: { KILOCODE_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      }),
    ).toEqual([{ ...codexEntryProvider, pluginId: "codex" }, ...fullProviders]);
    expect(mocks.resolvePluginProviders).toHaveBeenCalledTimes(1);
    const params = requireResolvePluginProvidersParams();
    expect(params.onlyPluginIds).toEqual(["kilocode"]);
  });

  it("enables bundled provider Vitest compat when falling back from discovery entries", () => {
    const fullProviders = [createProvider({ id: "deepseek", mode: "catalog" })];
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue([]);
    mocks.resolvePluginProviders.mockReturnValue(fullProviders);

    expect(
      resolvePluginDiscoveryProvidersRuntime({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        onlyPluginIds: ["deepseek"],
      }),
    ).toEqual(fullProviders);

    expect(mocks.resolvePluginProviders).toHaveBeenCalledTimes(1);
    expect(requireResolvePluginProvidersParams()).toEqual(
      expect.objectContaining({
        bundledProviderVitestCompat: true,
        onlyPluginIds: ["deepseek"],
      }),
    );
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
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
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
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
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
            }),
          ],
        },
      },
    });
  });

  it("defaults missing manifest model costs for static discovery entries", async () => {
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
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

  it("keeps manifest catalogs and loads only scoped plugins that have no entry", () => {
    const dynamicProvider = createProvider({ id: "minimax", mode: "catalog" });
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["minimax", "openai"]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      manifestRegistry: {
        plugins: [
          createManifestPluginWithoutDiscovery({ id: "minimax" }),
          createManifestPluginWithModelCatalog("openai"),
        ],
        diagnostics: [],
      },
    });
    mocks.resolvePluginProviders.mockReturnValue([dynamicProvider]);

    const providers = resolvePluginDiscoveryProvidersRuntime({
      onlyPluginIds: ["minimax", "openai"],
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "minimax"]);
    expect(mocks.resolvePluginProviders).toHaveBeenCalledTimes(1);
    expect(requireResolvePluginProvidersParams().onlyPluginIds).toEqual(["minimax"]);
  });

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
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
  });
});
