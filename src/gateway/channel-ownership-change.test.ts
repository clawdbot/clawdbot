import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRegistry } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findChannelOwnershipChange } from "./channel-ownership-change.js";

const metadataMocks = vi.hoisted(() => ({
  resolveConfigWidePluginManifestRegistry: vi.fn(),
}));

const workspaceDirMocks = vi.hoisted(() => ({
  listAgentWorkspaceDirs: vi.fn(),
}));

vi.mock("../agents/workspace-dirs.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/workspace-dirs.js")>(
    "../agents/workspace-dirs.js",
  );
  workspaceDirMocks.listAgentWorkspaceDirs.mockImplementation(actual.listAgentWorkspaceDirs);
  return {
    ...actual,
    listAgentWorkspaceDirs: workspaceDirMocks.listAgentWorkspaceDirs,
  };
});

vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: metadataMocks.resolveConfigWidePluginManifestRegistry,
}));

const CHANNEL_ID = "zzownershipchat";
const ORIGINAL_PLUGIN_ID = "zzownership-classic";
const REPLACEMENT_PLUGIN_ID = "zzownership-replacement";

const manifestRegistry = makeRegistry([
  {
    id: ORIGINAL_PLUGIN_ID,
    channels: [CHANNEL_ID],
    channelConfigs: { [CHANNEL_ID]: { schema: { type: "object" } } },
  },
  {
    id: REPLACEMENT_PLUGIN_ID,
    channels: [CHANNEL_ID],
    channelConfigs: {
      [CHANNEL_ID]: { schema: { type: "object" }, preferOver: [ORIGINAL_PLUGIN_ID] },
    },
  },
]);

const runtimeConfig = {
  channels: { [CHANNEL_ID]: { enabled: true } },
  plugins: {
    entries: {
      [ORIGINAL_PLUGIN_ID]: { enabled: true },
      [REPLACEMENT_PLUGIN_ID]: { enabled: true },
    },
  },
} as unknown as OpenClawConfig;

const previousSourceConfig = {
  channels: { [CHANNEL_ID]: { enabled: true } },
  plugins: {},
} as unknown as OpenClawConfig;

function compare(nextSourceConfig: OpenClawConfig) {
  return findChannelOwnershipChange({
    previous: { config: runtimeConfig, sourceConfig: previousSourceConfig },
    next: { config: runtimeConfig, sourceConfig: nextSourceConfig },
    pluginMetadataSnapshot: { manifestRegistry },
  });
}

beforeEach(() => {
  workspaceDirMocks.listAgentWorkspaceDirs.mockClear();
  metadataMocks.resolveConfigWidePluginManifestRegistry.mockReset().mockImplementation(() => {
    throw new Error("the supplied write snapshot must avoid registry resolution");
  });
});

describe("findChannelOwnershipChange", () => {
  it("reports a genuine owner move from the transaction metadata snapshot", () => {
    const nextSourceConfig = {
      channels: { [CHANNEL_ID]: { enabled: true } },
      plugins: { entries: { [ORIGINAL_PLUGIN_ID]: { enabled: true } } },
    } as unknown as OpenClawConfig;

    expect(compare(nextSourceConfig)).toEqual({
      channelId: CHANNEL_ID,
      previousOwner: REPLACEMENT_PLUGIN_ID,
      nextOwner: ORIGINAL_PLUGIN_ID,
    });
    expect(metadataMocks.resolveConfigWidePluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("returns null for an ownership-neutral source change", () => {
    const nextSourceConfig = {
      ...previousSourceConfig,
      channels: { [CHANNEL_ID]: { enabled: true, replyMode: "thread" } },
    } as unknown as OpenClawConfig;

    expect(compare(nextSourceConfig)).toBeNull();
    expect(metadataMocks.resolveConfigWidePluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("refreshes each registry when workspace roots match in a different order", () => {
    const previousConfig = {
      ...runtimeConfig,
      agents: {
        list: [
          { id: "first", workspace: "/tmp/first-workspace" },
          { id: "second", workspace: "/tmp/second-workspace" },
        ],
      },
    } as unknown as OpenClawConfig;
    const nextConfig = {
      ...runtimeConfig,
      agents: {
        list: [
          { id: "second", workspace: "/tmp/second-workspace" },
          { id: "first", workspace: "/tmp/first-workspace" },
        ],
      },
    } as unknown as OpenClawConfig;
    metadataMocks.resolveConfigWidePluginManifestRegistry.mockReturnValue(manifestRegistry);

    expect(
      findChannelOwnershipChange({
        previous: { config: previousConfig, sourceConfig: previousSourceConfig },
        next: { config: nextConfig, sourceConfig: previousSourceConfig },
        pluginMetadataSnapshot: { manifestRegistry },
      }),
    ).toBeNull();
    expect(
      metadataMocks.resolveConfigWidePluginManifestRegistry.mock.calls.map(
        ([params]) => (params as { config: OpenClawConfig }).config,
      ),
    ).toEqual([previousConfig, nextConfig]);
  });

  it("refreshes each registry when workspace root comparison throws", () => {
    workspaceDirMocks.listAgentWorkspaceDirs.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    metadataMocks.resolveConfigWidePluginManifestRegistry.mockReturnValue(manifestRegistry);

    expect(compare(previousSourceConfig)).toBeNull();
    expect(workspaceDirMocks.listAgentWorkspaceDirs).toHaveBeenCalledTimes(1);
    expect(metadataMocks.resolveConfigWidePluginManifestRegistry).toHaveBeenCalledTimes(2);
  });
});
