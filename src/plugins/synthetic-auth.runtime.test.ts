import { beforeEach, describe, expect, it, vi } from "vitest";

const getPluginRegistryState = vi.hoisted(() => vi.fn());
const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  loadPluginRegistrySnapshot: vi.fn((_params?: unknown) => ({ plugins: [] })),
}));

vi.mock("./runtime-state.js", () => ({
  getPluginRegistryState,
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
  loadPluginManifestRegistryForPluginRegistry: () =>
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex({
      index: pluginRegistryMocks.loadPluginRegistrySnapshot({ cache: true }),
      includeDisabled: true,
    }),
}));

import { resolveRuntimeSyntheticAuthProviderRefs } from "./synthetic-auth.runtime.js";

describe("synthetic auth runtime refs", () => {
  beforeEach(() => {
    getPluginRegistryState.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex
      .mockReset()
      .mockReturnValue({ plugins: [] });
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset().mockReturnValue({ plugins: [] });
  });

  it("uses manifest-owned synthetic auth refs before the runtime registry exists", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        { syntheticAuthRefs: [" local-provider ", "local-provider", "local-cli"] },
        { syntheticAuthRefs: ["remote-provider"] },
        { syntheticAuthRefs: [] },
      ],
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual([
      "local-provider",
      "local-cli",
      "remote-provider",
    ]);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshot).toHaveBeenCalledWith({ cache: true });
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith({
      index: expect.anything(),
      includeDisabled: true,
    });
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
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    expect(pluginRegistryMocks.loadPluginRegistrySnapshot).not.toHaveBeenCalled();
  });
});
