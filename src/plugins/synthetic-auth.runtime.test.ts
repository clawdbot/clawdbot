import { beforeEach, describe, expect, it, vi } from "vitest";

const getPluginRegistryState = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("./runtime-state.js", () => ({
  getPluginRegistryState,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

import { resolveRuntimeSyntheticAuthProviderRefs } from "./synthetic-auth.runtime.js";

describe("synthetic auth runtime refs", () => {
  beforeEach(() => {
    getPluginRegistryState.mockReset();
    loadPluginManifestRegistry.mockReset().mockReturnValue({ plugins: [] });
  });

  it("uses manifest-owned synthetic auth refs before the runtime registry exists", () => {
    loadPluginManifestRegistry.mockReturnValue({
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
    expect(loadPluginManifestRegistry).toHaveBeenCalledWith({ cache: true });
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
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
  });
});
