import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit bundled fast path");
  }),
}));

const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => {
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
  return {
    loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
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
        if (dirName === "google" && artifactBasename === "web-search-provider.js") {
          return {
            createGeminiWebSearchProvider: () => ({
              ...providerBase,
              id: "gemini",
              createTool: () => ({ description: "fixture", parameters: {} }),
            }),
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
        throw new Error(
          `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
        );
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
    loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
  };
});

import { resolveBundledExplicitRuntimeWebSearchProvidersFromPublicArtifacts as resolveExplicitRuntimeWebSearchProviders } from "./web-provider-public-artifacts.explicit.js";
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
    loadBundledPluginPublicArtifactModuleSyncMock.mockClear();
  });

  it("resolves bundled web search providers by explicit plugin id without manifest scans", () => {
    const provider = expectSingleProvider(
      resolveBundledWebSearchProvidersFromPublicArtifacts({
        bundledAllowlistCompat: true,
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

  it("resolves bundled runtime web search providers by explicit plugin id", () => {
    const provider = expectSingleProvider(
      resolveExplicitRuntimeWebSearchProviders({
        onlyPluginIds: ["google"],
      }),
    );

    expect(provider.pluginId).toBe("google");
    expect(provider.createTool({ config: {} as never })).toEqual({
      description: "fixture",
      parameters: {},
    });
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "google",
      artifactBasename: "web-search-provider.js",
    });
    expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
  });

  it("resolves bundled web fetch providers by explicit plugin id without manifest scans", () => {
    const provider = expectSingleProvider(
      resolveBundledWebFetchProvidersFromPublicArtifacts({
        bundledAllowlistCompat: true,
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
});
