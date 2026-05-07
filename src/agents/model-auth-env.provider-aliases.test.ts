import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEnvApiKey } from "./model-auth-env.js";

const pluginMetadataMocks = vi.hoisted(() => {
  const snapshot = {
    index: {
      plugins: [
        {
          pluginId: "external-cloud",
          origin: "global",
          enabled: true,
          enabledByDefault: true,
        },
      ],
    },
    plugins: [
      {
        id: "external-cloud",
        origin: "global",
        providerAuthAliases: {
          "cloud-alias": "external-cloud",
        },
        providerAuthEnvVars: {
          "external-cloud": ["EXTERNAL_CLOUD_API_KEY"],
        },
      },
    ],
  };
  return {
    snapshot,
    getCurrentPluginMetadataSnapshot: vi.fn(() => snapshot),
    loadPluginMetadataSnapshot: vi.fn(() => snapshot),
  };
});

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginMetadataMocks.loadPluginMetadataSnapshot,
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProvider: () => undefined,
}));

describe("resolveEnvApiKey provider auth aliases", () => {
  beforeEach(() => {
    pluginMetadataMocks.getCurrentPluginMetadataSnapshot.mockReset();
    pluginMetadataMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(
      pluginMetadataMocks.snapshot,
    );
    pluginMetadataMocks.loadPluginMetadataSnapshot.mockReset();
    pluginMetadataMocks.loadPluginMetadataSnapshot.mockReturnValue(pluginMetadataMocks.snapshot);
  });

  it("reuses the current scoped metadata snapshot while resolving provider auth aliases", () => {
    expect(
      resolveEnvApiKey(
        "cloud-alias",
        {
          EXTERNAL_CLOUD_API_KEY: "secret",
        } as NodeJS.ProcessEnv,
        {
          config: {},
          workspaceDir: "/workspace",
        },
      ),
    ).toEqual({
      apiKey: "secret",
      source: "env: EXTERNAL_CLOUD_API_KEY",
    });
    expect(pluginMetadataMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(pluginMetadataMocks.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env: {
        EXTERNAL_CLOUD_API_KEY: "secret",
      },
      workspaceDir: "/workspace",
      allowWorkspaceScopedSnapshot: true,
    });
  });
});
