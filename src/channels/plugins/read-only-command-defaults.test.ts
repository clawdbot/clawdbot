// Read-only command default tests cover command defaulting for read-only channel plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATE_DIR } from "../../config/paths.js";

const { loadPluginMetadataSnapshot, resolvePluginMetadataSnapshot } = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
}));

import { resolveReadOnlyChannelCommandDefaults } from "./read-only-command-defaults.js";

describe("resolveReadOnlyChannelCommandDefaults", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshot.mockReset();
    resolvePluginMetadataSnapshot.mockReset();
    loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
    resolvePluginMetadataSnapshot.mockImplementation(loadPluginMetadataSnapshot);
  });

  it.each([
    { name: "process", env: process.env, stateDir: STATE_DIR },
    {
      name: "custom",
      env: { HOME: "/home/demo", OPENCLAW_STATE_DIR: "/state" },
      stateDir: "/state",
    },
  ])("reuses published metadata for the $name state root without scanning", ({ env, stateDir }) => {
    const currentSnapshot = { index: { plugins: [] }, plugins: [] };
    resolvePluginMetadataSnapshot.mockImplementation((params) =>
      params.stateDir === undefined ? currentSnapshot : loadPluginMetadataSnapshot(params),
    );

    expect(resolveReadOnlyChannelCommandDefaults("demo", { config: {}, env, stateDir })).toBe(
      undefined,
    );
    expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled();
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
      allowWorkspaceScopedCurrent: true,
      config: {},
      env,
      stateDir: "/state",
      workspaceDir: "/workspace",
    });
  });

  it("resolves command defaults for manifest channel aliases", () => {
    loadPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "vendor-demo-plugin",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        {
          id: "vendor-demo-plugin",
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
      }),
    ).toEqual({
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: false,
    });
  });
});
