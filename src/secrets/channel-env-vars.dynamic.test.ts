/** Tests dynamic channel env-var discovery from plugin/channel metadata. */
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockManifestRegistry = {
  plugins: Array<{
    id: string;
    origin: string;
    packageChannel?: {
      id: string;
      configuredState?: { env?: { allOf?: string[]; anyOf?: string[] } };
    };
  }>;
  diagnostics: unknown[];
};

const pluginRegistryMocks = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn<() => MockManifestRegistry>(() => ({
    plugins: [],
    diagnostics: [],
  }));
  const loadPluginMetadataSnapshot = vi.fn((_params?: unknown) => ({
    plugins: loadManifestRegistry().plugins,
    manifestRegistry: loadManifestRegistry(),
  }));
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
    loadPluginMetadataSnapshot,
    resolvePluginMetadataSnapshot: vi.fn((params: unknown) => loadPluginMetadataSnapshot(params)),
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

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: pluginRegistryMocks.resolvePluginMetadataSnapshot,
}));

describe("channel env vars dynamic package metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockImplementation((params) =>
      pluginRegistryMocks.loadPluginMetadataSnapshot(params),
    );
  });

  it("includes later-installed plugin env vars without a bundled generated map", async () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "external-mattermost",
          origin: "global",
          packageChannel: {
            id: "mattermost",
            configuredState: {
              env: { anyOf: ["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"] },
            },
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./channel-env-vars.js");

    expect(mod.getChannelEnvVars("mattermost")).toEqual(["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]);
    const knownNames = mod.listKnownChannelEnvVarNames();
    expect(knownNames).toContain("MATTERMOST_BOT_TOKEN");
    expect(knownNames).toContain("MATTERMOST_URL");
  });

  it("reuses published channel metadata without rescanning manifests", async () => {
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "external-mattermost",
          origin: "global",
          packageChannel: {
            id: "mattermost",
            configuredState: { env: { anyOf: ["MATTERMOST_BOT_TOKEN"] } },
          },
        },
      ],
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const mod = await import("./channel-env-vars.js");

    expect(mod.getChannelEnvVars("mattermost")).toEqual(["MATTERMOST_BOT_TOKEN"]);
    expect(mod.listKnownChannelEnvVarNames()).toEqual(["MATTERMOST_BOT_TOKEN"]);
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(pluginRegistryMocks.resolvePluginMetadataSnapshot).toHaveBeenCalledTimes(2);
    expect(pluginRegistryMocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: undefined,
      env: process.env,
    });
  });
});
