import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { ProviderPlugin } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolveDiscoveredProviderPluginIds: vi.fn(),
  resolvePluginProviders: vi.fn(),
  loadSource: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-metadata-snapshot.js")>();
  return {
    ...actual,
    loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  };
});

vi.mock("./providers.js", () => ({
  resolveDiscoveredProviderPluginIds: mocks.resolveDiscoveredProviderPluginIds,
}));

vi.mock("./providers.runtime.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("./source-loader.js", () => ({
  createPluginSourceLoader: () => mocks.loadSource,
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

function createManifestPluginWithoutDiscovery(params: {
  id: string;
  providerAuthEnvVars?: Record<string, string[]>;
}): PluginManifestRecord {
  const { providerDiscoverySource: _providerDiscoverySource, ...plugin } = createManifestPlugin(
    params.id,
  );
  return {
    ...plugin,
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
  bundledProviderAllowlistCompat?: boolean;
  onlyPluginIds?: string[];
} {
  const params = (mocks.resolvePluginProviders.mock.calls[index] as [unknown] | undefined)?.[0] as
    | {
        bundledProviderAllowlistCompat?: boolean;
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
  });

  it("falls back to full provider plugins when discovery entries only expose static catalogs", () => {
    const fullProvider = createProvider({ id: "deepseek", mode: "catalog" });
    mocks.loadSource.mockReturnValue(createProvider({ id: "deepseek", mode: "static" }));
    mocks.resolvePluginProviders.mockReturnValue([fullProvider]);

    expect(resolvePluginDiscoveryProvidersRuntime({})).toEqual([fullProvider]);
    expect(mocks.resolvePluginProviders).toHaveBeenCalledTimes(1);
    const params = requireResolvePluginProvidersParams();
    expect(params.bundledProviderAllowlistCompat).toBe(true);
    expect(params.onlyPluginIds).toEqual(["deepseek"]);
  });

  it("keeps unscoped discovery bounded for mixed live and static-only entries", () => {
    const codexEntryProvider = createProvider({ id: "codex", mode: "catalog" });
    const fullProviders = [
      createProvider({ id: "deepseek", mode: "catalog" }),
      createProvider({ id: "kilocode", mode: "catalog" }),
    ];
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
      modulePath.includes("/codex/")
        ? codexEntryProvider
        : createProvider({ id: "deepseek", mode: "static" }),
    );
    mocks.resolvePluginProviders.mockReturnValue(fullProviders);

    expect(
      resolvePluginDiscoveryProvidersRuntime({
        env: { KILOCODE_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      }),
    ).toEqual([{ ...codexEntryProvider, pluginId: "codex" }, ...fullProviders]);
    expect(mocks.resolvePluginProviders).toHaveBeenCalledTimes(1);
    const params = requireResolvePluginProvidersParams();
    expect(params.onlyPluginIds).toEqual(["deepseek", "kilocode"]);
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

    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env: {},
    });
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
