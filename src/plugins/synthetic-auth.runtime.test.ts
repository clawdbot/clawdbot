import { beforeEach, describe, expect, it, vi } from "vitest";

type SyntheticAuthRegistrySnapshotResult = {
  source: "persisted" | "provided" | "derived";
  snapshot: {
    plugins: Array<{ syntheticAuthRefs?: string[] }>;
  };
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
}));

vi.mock("./runtime-state.js", () => ({
  getPluginRegistryState,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshotWithMetadata:
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata,
}));

import { resolveRuntimeSyntheticAuthProviderRefs } from "./synthetic-auth.runtime.js";

describe("synthetic auth runtime refs", () => {
  beforeEach(() => {
    getPluginRegistryState.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReset().mockReturnValue({
      source: "persisted",
      snapshot: { plugins: [] as Array<{ syntheticAuthRefs?: string[] }> },
      diagnostics: [],
    });
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
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledWith({
      cache: true,
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

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual([]);
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
      },
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual(["runtime-provider", "runtime-cli"]);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });
});
