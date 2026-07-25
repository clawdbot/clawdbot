/** Tests fast-path secret collection for channel contract API credentials. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPluginMetadataSnapshotMock } = vi.hoisted(() => ({
  loadPluginMetadataSnapshotMock: vi.fn(() => ({ plugins: [] })),
}));
const { loadBundledPluginPublicArtifactModuleSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "discord" && artifactBasename === "secret-contract-api.js") {
        return {
          collectRuntimeConfigAssignments: () => undefined,
          secretTargetRegistryEntries: [
            {
              id: "channels.discord.accounts.*.token",
              type: "channel",
              path: "channels.discord.accounts.*.token",
            },
          ],
        };
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  ),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
}));

import { loadChannelSecretContractApi } from "./channel-contract-api.js";

describe("channel contract api explicit fast path", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshotMock.mockClear();
  });

  it("resolves bundled channel secret contracts by explicit channel id without manifest scans", () => {
    const api = loadChannelSecretContractApi({ channelId: "discord", config: {} });

    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "discord",
      artifactBasename: "secret-contract-api.js",
    });
    const tokenEntry = api?.secretTargetRegistryEntries?.find(
      (entry) => entry.id === "channels.discord.accounts.*.token",
    );
    expect(tokenEntry?.id).toBe("channels.discord.accounts.*.token");
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not fall back to the broad contract-api artifact when the secret artifact is missing", () => {
    const api = loadChannelSecretContractApi({ channelId: "missing", config: {} });

    expect(api).toBeUndefined();
    expect(loadBundledPluginPublicArtifactModuleSyncMock).toHaveBeenCalledWith({
      dirName: "missing",
      artifactBasename: "secret-contract-api.js",
    });
    expect(loadBundledPluginPublicArtifactModuleSyncMock).not.toHaveBeenCalledWith({
      dirName: "missing",
      artifactBasename: "contract-api.js",
    });
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
