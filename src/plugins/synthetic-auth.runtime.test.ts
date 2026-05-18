import { beforeEach, describe, expect, it, vi } from "vitest";

type SyntheticAuthRegistrySnapshotResult = {
  source: "persisted" | "provided" | "derived";
  snapshot: {
    plugins: Array<{ syntheticAuthRefs?: string[] }>;
  };
  diagnostics: [];
};

type ExternalAuthManifestRegistryResult = {
  plugins: Array<{ contracts?: { externalAuthProviders?: string[] } }>;
  diagnostics: [];
};

const getPluginRegistryState = vi.hoisted(() => vi.fn());
const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshotWithMetadata: vi.fn(
    (_params?: unknown): SyntheticAuthRegistrySnapshotResult => ({
      source: "persisted",
      snapshot: { plugins: [] },
      diagnostics: [],
    }),
  ),
  loadPluginManifestRegistryForInstalledIndex: vi.fn<() => ExternalAuthManifestRegistryResult>(
    () => ({
      plugins: [],
      diagnostics: [],
    }),
  ),
}));

vi.mock("./runtime-state.js", () => ({
  getPluginRegistryState,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshotWithMetadata:
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata,
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

import {
  resolveRuntimeExternalAuthProviderRefs,
  resolveRuntimeSyntheticAuthProviderRefs,
} from "./synthetic-auth.runtime.js";

describe("synthetic auth runtime refs", () => {
  beforeEach(() => {
    getPluginRegistryState.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReset().mockReturnValue({
      source: "persisted",
      snapshot: { plugins: [] as Array<{ syntheticAuthRefs?: string[] }> },
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset().mockReturnValue({
      plugins: [],
      diagnostics: [],
    } satisfies ExternalAuthManifestRegistryResult);
  });

  it("uses persisted registry synthetic auth refs before the runtime registry exists", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: {
        plugins: [
          { syntheticAuthRefs: [" local-provider ", "local-provider", "local-cli"] },
          { syntheticAuthRefs: ["remote-provider"] },
          { syntheticAuthRefs: [] },
        ],
      },
      diagnostics: [],
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual([
      "local-provider",
      "local-cli",
      "remote-provider",
    ]);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledWith({});
  });

  it("uses persisted registry external auth provider refs before the runtime registry exists", () => {
    const snapshot = {
      plugins: [{ syntheticAuthRefs: [] }],
    };
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot,
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        { contracts: { externalAuthProviders: [" runtime-provider ", "runtime-provider"] } },
        { contracts: { externalAuthProviders: ["external-cli"] } },
        { contracts: {} },
      ],
      diagnostics: [],
    });

    expect(resolveRuntimeExternalAuthProviderRefs()).toEqual(["runtime-provider", "external-cli"]);
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith({
      index: snapshot,
    });
  });

  it("does not derive the registry just to resolve synthetic auth refs", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: {
        plugins: [
          { syntheticAuthRefs: [" local-provider ", "local-provider", "local-cli"] },
          { syntheticAuthRefs: ["remote-provider"] },
          { syntheticAuthRefs: [] },
        ],
      },
      diagnostics: [],
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toStrictEqual([]);
  });

  it("does not derive the registry just to resolve external auth refs", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: { plugins: [] },
      diagnostics: [],
    });

    expect(resolveRuntimeExternalAuthProviderRefs()).toStrictEqual([]);
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("does not treat a provided index with registry diagnostics as validated synthetic auth", () => {
    const index = {
      plugins: [{ syntheticAuthRefs: ["local-provider"] }],
    };

    expect(
      resolveRuntimeSyntheticAuthProviderRefs({
        index: index as unknown as NonNullable<
          Parameters<typeof resolveRuntimeSyntheticAuthProviderRefs>[0]
        >["index"],
        registryDiagnostics: [{ code: "persisted-registry-missing" }],
      }),
    ).toStrictEqual([]);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });

  it("does not treat a provided index with registry diagnostics as validated external auth", () => {
    const index = {
      plugins: [{ syntheticAuthRefs: [] }],
    };

    expect(
      resolveRuntimeExternalAuthProviderRefs({
        index: index as unknown as NonNullable<
          Parameters<typeof resolveRuntimeExternalAuthProviderRefs>[0]
        >["index"],
        registryDiagnostics: [{ code: "persisted-registry-missing" }],
      }),
    ).toStrictEqual([]);
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("prefers the active runtime registry when plugins are already loaded", () => {
    getPluginRegistryState.mockReturnValue({
      activeRegistry: {
        providers: [
          {
            provider: {
              id: "runtime-provider",
              resolveSyntheticAuth: () => undefined,
            },
          },
          {
            provider: {
              id: "plain-provider",
            },
          },
        ],
        cliBackends: [
          {
            backend: {
              id: "runtime-cli",
              resolveSyntheticAuth: () => undefined,
            },
          },
        ],
        plugins: [
          {
            contracts: {
              externalAuthProviders: ["manifest-provider"],
            },
          },
        ],
      },
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual(["runtime-provider", "runtime-cli"]);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });

  it("prefers active runtime registry external auth refs when plugins are already loaded", () => {
    getPluginRegistryState.mockReturnValue({
      activeRegistry: {
        plugins: [
          {
            contracts: {
              externalAuthProviders: ["manifest-provider"],
            },
          },
        ],
        providers: [
          {
            provider: {
              id: "runtime-provider",
              resolveExternalAuthProfiles: () => [],
            },
          },
        ],
        cliBackends: [
          {
            backend: {
              id: "runtime-cli",
              resolveExternalOAuthProfiles: () => [],
            },
          },
        ],
      },
    });

    expect(resolveRuntimeExternalAuthProviderRefs()).toEqual([
      "manifest-provider",
      "runtime-provider",
      "runtime-cli",
    ]);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });
});
