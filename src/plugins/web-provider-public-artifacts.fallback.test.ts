import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: vi.fn(() => null),
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: vi.fn(() => null),
  loadBundledWebSearchProviderEntriesFromDir: vi.fn(),
  loadBundledWebFetchProviderEntriesFromDir: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
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
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
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
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
    expect(mocks.loadBundledWebSearchProviderEntriesFromDir).toHaveBeenCalledWith({
      dirName: "fallback-search",
      pluginId: "fallback-search",
    });
  });

  it("reuses the candidate manifest registry for bundled web-fetch artifact fallback", () => {
    const providers = resolveBundledWebFetchProvidersFromPublicArtifacts({ config: {} });

    expect(providers).toEqual([{ id: "fallback-fetch", pluginId: "fallback-fetch" }]);
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
    expect(mocks.loadBundledWebFetchProviderEntriesFromDir).toHaveBeenCalledWith({
      dirName: "fallback-fetch",
      pluginId: "fallback-fetch",
    });
  });

  it("keeps explicit bundled web-search public artifact candidates inside allowlist discovery", () => {
    const resolveExplicitWebSearchProviders =
      mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts as unknown as {
        mockImplementation: (
          implementation: (params: {
            onlyPluginIds: readonly string[];
          }) => { id: string; pluginId: string }[],
        ) => void;
      };
    resolveExplicitWebSearchProviders.mockImplementation((params) =>
      params.onlyPluginIds.map((pluginId) => ({ id: pluginId, pluginId })),
    );

    const providers = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: {
        plugins: {
          allow: ["fallback-search"],
          bundledDiscovery: "allowlist",
        },
      },
      onlyPluginIds: ["blocked-search", "fallback-search"],
    });

    expect(providers).toEqual([{ id: "fallback-search", pluginId: "fallback-search" }]);
    expect(mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts).toHaveBeenCalledWith({
      onlyPluginIds: ["fallback-search"],
    });
  });

  it("keeps manifest bundled web-fetch public artifact candidates inside allowlist discovery", () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce({
      diagnostics: [],
      plugins: [
        {
          id: "blocked-fetch",
          origin: "bundled",
          rootDir: "/tmp/blocked-fetch",
          contracts: { webFetchProviders: ["blocked-fetch"] },
        },
        {
          id: "fallback-fetch",
          origin: "bundled",
          rootDir: "/tmp/fallback-fetch",
          contracts: { webFetchProviders: ["fallback-fetch"] },
        },
      ],
    });

    const providers = resolveBundledWebFetchProvidersFromPublicArtifacts({
      config: {
        plugins: {
          allow: ["fallback-fetch"],
          bundledDiscovery: "allowlist",
        },
      },
    });

    expect(providers).toEqual([{ id: "fallback-fetch", pluginId: "fallback-fetch" }]);
    expect(mocks.loadBundledWebFetchProviderEntriesFromDir).toHaveBeenCalledOnce();
    expect(mocks.loadBundledWebFetchProviderEntriesFromDir).toHaveBeenCalledWith({
      dirName: "fallback-fetch",
      pluginId: "fallback-fetch",
    });
  });

  it("matches bundled web-search candidates through provider alias allowlist entries", () => {
    mocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValueOnce(null);
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce({
      diagnostics: [],
      plugins: [
        {
          id: "google",
          origin: "bundled",
          rootDir: "/tmp/google",
          contracts: { webSearchProviders: ["gemini"] },
        },
      ],
    });
    mocks.loadBundledWebSearchProviderEntriesFromDir.mockReturnValueOnce([
      { id: "gemini", pluginId: "google" },
    ]);

    const providers = resolveBundledWebSearchProvidersFromPublicArtifacts({
      config: {
        plugins: {
          allow: ["google-gemini-cli"],
          bundledDiscovery: "allowlist",
        },
      },
    });

    expect(providers).toEqual([{ id: "gemini", pluginId: "google" }]);
    expect(mocks.loadBundledWebSearchProviderEntriesFromDir).toHaveBeenCalledWith({
      dirName: "google",
      pluginId: "google",
    });
  });
});
