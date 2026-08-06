// Verifies explicit web-provider artifact fast paths avoid runtime loading.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit bundled fast path");
  }),
}));

const {
  loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock,
  loadBundledPluginPublicArtifactModuleSyncMock,
} = vi.hoisted(() => {
  const providerBase = {
    label: "Fixture",
    hint: "fixture",
    envVars: ["FIXTURE_API_KEY"],
    placeholder: "fixture",
    signupUrl: "https://example.com",
    credentialPath: "plugins.entries.fixture.config.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue: () => ({}),
  };
  const lowLevelLoaderMock = vi.fn(
    ({ dirName, artifactBasename }: { dirName: string; artifactBasename: string }) => {
      if (dirName === "brave" && artifactBasename === "web-search-contract-api.js") {
        return {
          createBraveWebSearchProvider: () => ({
            ...providerBase,
            id: "brave",
            createTool: () => null,
          }),
        };
      }
      if (dirName === "mockplugin" && artifactBasename === "web-search-contract-api.js") {
        return {
          createFuzzpluginWebSearchProvider: () => {
            throw new Error("fuzzplugin web provider factory failed");
          },
          createMockpluginWebSearchProvider: () => ({
            ...providerBase,
            id: "mockplugin",
            createTool: () => null,
          }),
        };
      }
      if (dirName === "fuzzplugin" && artifactBasename === "web-search-contract-api.js") {
        return {
          createFuzzpluginWebSearchProvider: () => {
            throw new Error("fuzzplugin web provider factory failed");
          },
        };
      }
      if (dirName === "firecrawl" && artifactBasename === "web-fetch-contract-api.js") {
        return {
          createFirecrawlWebFetchProvider: () => ({
            ...providerBase,
            id: "firecrawl",
            createTool: () => null,
          }),
        };
      }
      if (dirName === "firecrawl" && artifactBasename === "web-fetch-provider.js") {
        return {
          createFirecrawlWebFetchProvider: () => ({
            ...providerBase,
            id: "firecrawl",
            createTool: () => ({
              description: "runtime firecrawl",
              parameters: {},
              execute: async () => ({}),
            }),
          }),
        };
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  );
  return {
    loadBundledPluginPublicArtifactModuleSyncMock: lowLevelLoaderMock,
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock: vi.fn(
      ({
        dirName,
        artifactCandidates,
      }: {
        dirName: string;
        artifactCandidates: readonly string[];
      }) => {
        for (const artifactBasename of artifactCandidates) {
          try {
            return lowLevelLoaderMock({ dirName, artifactBasename });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith("Unable to resolve bundled plugin public surface ")
            ) {
              continue;
            }
            throw error;
          }
        }
        return null;
      },
    ),
  };
});

vi.mock("./manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry: loadPluginManifestRegistryMock,
  };
});

vi.mock("./public-surface-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-surface-loader.js")>();
  return {
    ...actual,
    loadBundledPluginPublicArtifactModuleFromCandidatesSync:
      loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock,
    loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
  };
});

import { resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.explicit.js";
import {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";

function expectSingleProvider<T>(providers: T[] | null | undefined): T {
  expect(providers).toHaveLength(1);
  const provider = providers?.[0];
  if (provider === undefined) {
    throw new Error("Expected one web provider");
  }
  return provider;
}

describe("web provider public artifacts explicit fast path", () => {
  beforeEach(() => {
    loadPluginManifestRegistryMock.mockClear();
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock.mockClear();
    loadBundledPluginPublicArtifactModuleSyncMock.mockClear();
  });

  it("resolves bundled web search providers by explicit plugin id without manifest scans", () => {
    const provider = expectSingleProvider(
      resolveBundledWebSearchProvidersFromPublicArtifacts({
        onlyPluginIds: ["brave"],
      }),
    );

    expect(provider.pluginId).toBe("brave");
    expect(provider.createTool({ config: {} as never })).toBeNull();
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "brave",
      artifactBasename: "web-search-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("skips throwing bundled web provider factories while preserving healthy siblings", () => {
    const provider = expectSingleProvider(
      resolveBundledWebSearchProvidersFromPublicArtifacts({
        onlyPluginIds: ["mockplugin"],
      }),
    );

    expect(provider.pluginId).toBe("mockplugin");
    expect(provider.id).toBe("mockplugin");
    expect(provider.createTool({ config: {} as never })).toBeNull();
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "mockplugin",
      artifactBasename: "web-search-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("throws when every matching bundled web provider factory fails", () => {
    expect(() =>
      resolveBundledWebSearchProvidersFromPublicArtifacts({
        onlyPluginIds: ["fuzzplugin"],
      }),
    ).toThrow("Unable to initialize web providers for plugin fuzzplugin");

    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "fuzzplugin",
      artifactBasename: "web-search-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves bundled web fetch providers by explicit plugin id without manifest scans", () => {
    const provider = expectSingleProvider(
      resolveBundledWebFetchProvidersFromPublicArtifacts({
        onlyPluginIds: ["firecrawl"],
      }),
    );

    expect(provider.pluginId).toBe("firecrawl");
    expect(provider.createTool({ config: {} as never })).toBeNull();
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "firecrawl",
      artifactBasename: "web-fetch-contract-api.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("loads executable web fetch runtime artifacts instead of contract-only facades", () => {
    const provider = expectSingleProvider(
      resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts({
        onlyPluginIds: ["firecrawl"],
      }),
    );

    expect(provider.pluginId).toBe("firecrawl");
    expect(provider.createTool({ config: {} as never })).not.toBeNull();
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "firecrawl",
      artifactBasename: "web-fetch-provider.js",
    });
    expect(loadBundledPluginPublicArtifactModuleSyncMock).not.toHaveBeenCalledWith({
      dirName: "firecrawl",
      artifactBasename: "web-fetch-contract-api.js",
    });
  });
});
