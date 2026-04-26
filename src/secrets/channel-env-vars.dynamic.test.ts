import { beforeEach, describe, expect, it, vi } from "vitest";

type MockManifestRegistry = {
  plugins: Array<{
    id: string;
    origin: string;
    channelEnvVars?: Record<string, string[]>;
  }>;
  diagnostics: unknown[];
};

const pluginRegistryMocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn<() => MockManifestRegistry>(() => ({
    plugins: [],
    diagnostics: [],
  }));
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  };
});

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

describe("channel env vars dynamic manifest metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
  });

  it("includes later-installed plugin env vars without a bundled generated map", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "external-mattermost",
          origin: "global",
          channelEnvVars: {
            mattermost: ["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./channel-env-vars.js");

    expect(mod.getChannelEnvVars("mattermost")).toEqual(["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]);
    expect(mod.listKnownChannelEnvVarNames()).toEqual(
      expect.arrayContaining(["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]),
    );
  });
});
