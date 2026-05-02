import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPluginMetadataSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot,
}));

import { resolveReadOnlyChannelCommandDefaults } from "./read-only-command-defaults.js";

describe("resolveReadOnlyChannelCommandDefaults", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshot.mockReset();
    loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
  });

  it("resolves command defaults from the shared metadata snapshot", () => {
    const env = { HOME: "/home/demo" } as NodeJS.ProcessEnv;
    loadPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "demo",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        {
          id: "demo",
          origin: "global",
          channels: ["demo"],
          channelConfigs: {
            demo: {
              commands: {
                nativeCommandsAutoEnabled: true,
                nativeSkillsAutoEnabled: false,
              },
            },
          },
        },
      ],
    });

    expect(
      resolveReadOnlyChannelCommandDefaults("demo", {
        config: {},
        env,
        stateDir: "/state",
        workspaceDir: "/workspace",
      }),
    ).toEqual({
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: false,
    });
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env,
      stateDir: "/state",
      workspaceDir: "/workspace",
    });
  });
});
