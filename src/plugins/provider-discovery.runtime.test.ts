import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { ProviderPlugin } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(),
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  resolveDiscoveredProviderPluginIds: vi.fn(),
  resolvePluginProviders: vi.fn(),
  loadSource: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: mocks.loadPluginRegistrySnapshot,
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: mocks.loadPluginManifestRegistryForInstalledIndex,
}));

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

describe("resolvePluginDiscoveryProvidersRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    mocks.resolveDiscoveredProviderPluginIds.mockReturnValue(["deepseek"]);
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [createManifestPlugin("deepseek")],
      diagnostics: [],
    });
  });

  it("falls back to full provider plugins when discovery entries only expose static catalogs", () => {
    const fullProvider = createProvider({ id: "deepseek", mode: "catalog" });
    mocks.loadSource.mockReturnValue(createProvider({ id: "deepseek", mode: "static" }));
    mocks.resolvePluginProviders.mockReturnValue([fullProvider]);

    expect(resolvePluginDiscoveryProvidersRuntime({})).toEqual([fullProvider]);
    expect(mocks.resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        bundledProviderAllowlistCompat: true,
        onlyPluginIds: ["deepseek"],
      }),
    );
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
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
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
    expect(mocks.resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["deepseek", "kilocode"],
      }),
    );
  });

  it("shares one registry snapshot and manifest registry between provider id discovery and entry loading", () => {
    const registry = { plugins: [] };
    const manifestRegistry = {
      plugins: [createManifestPlugin("deepseek")],
      diagnostics: [],
    };
    mocks.loadPluginRegistrySnapshot.mockReturnValue(registry);
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
    mocks.loadSource.mockReturnValue(createProvider({ id: "deepseek", mode: "catalog" }));

    resolvePluginDiscoveryProvidersRuntime({ config: {}, env: {} as NodeJS.ProcessEnv });

    expect(mocks.loadPluginRegistrySnapshot).toHaveBeenCalledOnce();
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith({
      index: registry,
      config: {},
      workspaceDir: undefined,
      env: {},
      includeDisabled: true,
    });
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledOnce();
    expect(mocks.resolveDiscoveredProviderPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({
        registry,
        manifestRegistry,
      }),
    );
  });

  it("uses a provided plugin metadata snapshot without rebuilding registry metadata", () => {
    const registry = { plugins: [] };
    const manifestRegistry = {
      plugins: [createManifestPlugin("deepseek")],
      diagnostics: [],
    };
    mocks.loadSource.mockReturnValue(createProvider({ id: "deepseek", mode: "catalog" }));

    expect(
      resolvePluginDiscoveryProvidersRuntime({
        config: {},
        env: {} as NodeJS.ProcessEnv,
        pluginMetadataSnapshot: {
          index: registry as never,
          manifestRegistry,
        },
      }),
    ).toEqual([
      expect.objectContaining({
        id: "deepseek",
        pluginId: "deepseek",
      }),
    ]);

    expect(mocks.loadPluginRegistrySnapshot).not.toHaveBeenCalled();
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    expect(mocks.resolveDiscoveredProviderPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({
        registry,
        manifestRegistry,
      }),
    );
  });

  it("returns static-only discovery entries for callers that explicitly request them", () => {
    const staticProvider = createProvider({ id: "deepseek", mode: "static" });
    mocks.loadSource.mockReturnValue(staticProvider);

    expect(resolvePluginDiscoveryProvidersRuntime({ discoveryEntriesOnly: true })).toEqual([
      expect.objectContaining({
        id: "deepseek",
        pluginId: "deepseek",
        staticCatalog: staticProvider.staticCatalog,
      }),
    ]);
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
  });
});
