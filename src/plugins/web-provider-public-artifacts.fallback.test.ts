import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: vi.fn(() => null),
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: vi.fn(() => null),
  loadBundledWebSearchProviderEntriesFromDir: vi.fn(),
  loadBundledWebFetchProviderEntriesFromDir: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
}));

vi.mock("./web-search-providers.shared.js", () => ({
  resolveBundledWebSearchResolutionConfig: (params: { config?: unknown }) => ({
    config: params.config,
  }),
}));

vi.mock("./web-fetch-providers.shared.js", () => ({
  resolveBundledWebFetchResolutionConfig: (params: { config?: unknown }) => ({
    config: params.config,
  }),
}));

vi.mock("./web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts:
    mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts:
    mocks.resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  loadBundledWebSearchProviderEntriesFromDir: mocks.loadBundledWebSearchProviderEntriesFromDir,
  loadBundledWebFetchProviderEntriesFromDir: mocks.loadBundledWebFetchProviderEntriesFromDir,
}));

const {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} = await import("./web-provider-public-artifacts.js");

describe("web provider public artifact manifest fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "fallback-search",
          origin: "bundled",
          rootDir: "/tmp/fallback-search",
          contracts: { webSearchProviders: ["fallback-search"] },
        },
        {
          id: "fallback-fetch",
          origin: "bundled",
          rootDir: "/tmp/fallback-fetch",
          contracts: { webFetchProviders: ["fallback-fetch"] },
        },
      ],
    });
    mocks.loadBundledWebSearchProviderEntriesFromDir.mockReturnValue([
      { id: "fallback-search", pluginId: "fallback-search" },
    ]);
    mocks.loadBundledWebFetchProviderEntriesFromDir.mockReturnValue([
      { id: "fallback-fetch", pluginId: "fallback-fetch" },
    ]);
  });

  it("reuses the candidate manifest registry for bundled web-search artifact fallback", () => {
    const providers = resolveBundledWebSearchProvidersFromPublicArtifacts({ config: {} });

    expect(providers).toEqual([{ id: "fallback-search", pluginId: "fallback-search" }]);
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledOnce();
    expect(mocks.loadBundledWebSearchProviderEntriesFromDir).toHaveBeenCalledWith({
      dirName: "fallback-search",
      pluginId: "fallback-search",
    });
  });

  it("reuses the candidate manifest registry for bundled web-fetch artifact fallback", () => {
    const providers = resolveBundledWebFetchProvidersFromPublicArtifacts({ config: {} });

    expect(providers).toEqual([{ id: "fallback-fetch", pluginId: "fallback-fetch" }]);
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledOnce();
    expect(mocks.loadBundledWebFetchProviderEntriesFromDir).toHaveBeenCalledWith({
      dirName: "fallback-fetch",
      pluginId: "fallback-fetch",
    });
  });
});
