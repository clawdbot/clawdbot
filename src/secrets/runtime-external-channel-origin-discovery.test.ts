/** Tests external channel origin discovery for secrets runtime loading. */
import { describe, expect, it, vi } from "vitest";

const { resolveConfigWidePluginManifestRegistryMock, loadChannelSecretContractApiMock } =
  vi.hoisted(() => ({
    resolveConfigWidePluginManifestRegistryMock: vi.fn(),
    loadChannelSecretContractApiMock: vi.fn(),
  }));

vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: resolveConfigWidePluginManifestRegistryMock,
}));

vi.mock("./channel-contract-api.js", () => ({
  loadChannelSecretContractApi: loadChannelSecretContractApiMock,
}));

import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function requireDiscordConfig(snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>) {
  const config = snapshot.config.channels?.discord;
  if (!config) {
    throw new Error("expected Discord runtime config");
  }
  return config;
}

function requireLoadChannelSecretContractApiCall(): {
  channelId?: unknown;
  loadablePluginOrigins?: unknown;
} {
  const [call] = loadChannelSecretContractApiMock.mock.calls;
  if (!call) {
    throw new Error("expected loadChannelSecretContractApi call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected loadChannelSecretContractApi params to be an object");
  }
  return params;
}

describe("secrets runtime external channel origin discovery", () => {
  it("discovers loadable plugins for channel SecretRefs when plugins.entries is absent", async () => {
    resolveConfigWidePluginManifestRegistryMock.mockReturnValue({
      plugins: [{ id: "discord", origin: "global" }],
      diagnostics: [],
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

    expect(requireDiscordConfig(snapshot).token).toBe("resolved-discord-token");
    expect(resolveConfigWidePluginManifestRegistryMock).toHaveBeenCalled();
    const loadCall = requireLoadChannelSecretContractApiCall();
    expect(loadCall.channelId).toBe("discord");
    expect(loadCall.loadablePluginOrigins).toEqual(new Map([["discord", "global"]]));
  });
});
