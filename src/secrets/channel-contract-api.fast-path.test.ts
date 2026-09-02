/** Tests fast-path secret collection for channel contract API credentials. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

const { loadPluginMetadataSnapshotMock } = vi.hoisted(() => ({
  loadPluginMetadataSnapshotMock: vi.fn((_params: unknown) => ({ plugins: [] })),
}));
const { loadBundledPublicArtifactMock } = vi.hoisted(() => ({
  loadBundledPublicArtifactMock: vi.fn(
    ({ artifactCandidates, dirName }: { artifactCandidates: string[]; dirName: string }) => {
      if (dirName === "discord" && artifactCandidates[0] === "secret-contract-api.js") {
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
      return null;
    },
  ),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (params: unknown) =>
    createPluginMetadataSnapshotFixture(loadPluginMetadataSnapshotMock(params)),
  resolvePluginMetadataSnapshot: (params: unknown) => {
    const snapshot = loadPluginMetadataSnapshotMock(params);
    return createPluginMetadataSnapshotFixture({ plugins: snapshot.plugins });
  },
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadBundledPublicArtifactMock,
}));

import { loadChannelSecretContractApi } from "./channel-contract-api.js";

describe("channel contract api explicit fast path", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshotMock.mockClear();
  });

  it("resolves bundled channel secret contracts by explicit channel id without manifest scans", () => {
    const api = loadChannelSecretContractApi({ channelId: "discord", config: {} });

    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
    expect(loadBundledPublicArtifactMock).toHaveBeenCalledWith({
      dirName: "discord",
      artifactCandidates: ["secret-contract-api.js"],
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
    expect(loadBundledPublicArtifactMock).toHaveBeenCalledWith({
      dirName: "missing",
      artifactCandidates: ["secret-contract-api.js"],
    });
    expect(loadBundledPublicArtifactMock).not.toHaveBeenCalledWith({
      dirName: "missing",
      artifactCandidates: ["contract-api.js"],
    });
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
    expect(loadPluginMetadataSnapshotMock.mock.calls[0]?.[0]).toMatchObject({
      config: {},
      workspaceDir: expect.any(String),
      allowWorkspaceScopedCurrent: true,
    });
  });
});
