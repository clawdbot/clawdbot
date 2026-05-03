import { describe, expect, it, vi } from "vitest";

const { loadPluginMetadataSnapshotMock, loadChannelSecretContractApiMock } = vi.hoisted(() => ({
  loadPluginMetadataSnapshotMock: vi.fn(),
  loadChannelSecretContractApiMock: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
  listPluginOriginsFromMetadataSnapshot: (snapshot: {
    plugins: Array<{ id: string; origin: string }>;
  }) => new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
}));

vi.mock("./channel-contract-api.js", () => ({
  loadChannelSecretContractApi: loadChannelSecretContractApiMock,
}));

import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime external channel origin discovery", () => {
  it("discovers loadable plugins for channel SecretRefs when plugins.entries is absent", async () => {
    loadPluginMetadataSnapshotMock.mockReturnValue({
      plugins: [{ id: "discord", origin: "global" }],
    });
    loadChannelSecretContractApiMock.mockReturnValue({
      collectRuntimeConfigAssignments: (params: {
        config: { channels?: { discord?: { token?: unknown } } };
        context: {
          assignments: Array<{
            ref: { source: "env"; provider: "default"; id: string };
            path: string;
            expected: "string";
            apply: (value: unknown) => void;
          }>;
        };
      }) => {
        const token = params.config.channels?.discord?.token;
        if (!token || typeof token !== "object" || Array.isArray(token)) {
          return;
        }
        params.context.assignments.push({
          ref: token as { source: "env"; provider: "default"; id: string },
          path: "channels.discord.token",
          expected: "string",
          apply: (value) => {
            if (params.config.channels?.discord) {
              params.config.channels.discord.token = value;
            }
          },
        });
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          },
        },
      }),
      env: {
        DISCORD_BOT_TOKEN: "resolved-discord-token",
      },
      includeAuthStoreRefs: false,
    });

    expect(snapshot.config.channels?.discord?.token).toBe("resolved-discord-token");
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalled();
    expect(loadChannelSecretContractApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "discord",
        loadablePluginOrigins: new Map([["discord", "global"]]),
      }),
    );
  });
});
