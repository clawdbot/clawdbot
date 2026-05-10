import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const {
  loadPluginMetadataSnapshotMock,
  loadBundledPluginPublicArtifactModuleSyncMock,
  shouldRejectHardlinkedPluginFilesMock,
} = vi.hoisted(() => ({
  loadPluginMetadataSnapshotMock: vi.fn(),
  loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(() => {
    throw new Error(
      "Unable to resolve bundled plugin public surface discord/secret-contract-api.js",
    );
  }),
  shouldRejectHardlinkedPluginFilesMock: vi.fn(() => true),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
}));

vi.mock("../plugins/hardlink-policy.js", () => ({
  shouldRejectHardlinkedPluginFiles: shouldRejectHardlinkedPluginFilesMock,
}));

import { loadChannelSecretContractApi } from "./channel-contract-api.js";

type ChannelSecretContractApi = NonNullable<ReturnType<typeof loadChannelSecretContractApi>>;

function requireChannelSecretContractApi(
  api: ReturnType<typeof loadChannelSecretContractApi>,
): ChannelSecretContractApi {
  if (!api) {
    throw new Error("expected channel secret contract API");
  }
  return api;
}

function expectDiscordTokenRegistryEntry(contractApi: ChannelSecretContractApi): void {
  const entries = contractApi.secretTargetRegistryEntries ?? [];
  const entry = entries.find((record) => record.id === "channels.discord.token");
  expect(entry?.id).toBe("channels.discord.token");
}

function channelSecretContractModuleSource(channelId: string) {
  return `
module.exports = {
  secretTargetRegistryEntries: [
    {
      id: "channels.${channelId}.token",
      targetType: "channels.${channelId}.token",
      configFile: "openclaw.json",
      pathPattern: "channels.${channelId}.token",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true
    }
  ],
  collectRuntimeConfigAssignments(params) {
    params.context.assignments.push({
      path: "channels.${channelId}.token",
      ref: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
      expected: "string",
      apply() {}
    });
  }
};
`;
}

function writeExternalChannelPlugin(params: { pluginId: string; channelId: string }) {
  const rootDir = makeTrackedTempDir("openclaw-channel-secret-contract", tempDirs);
  fs.writeFileSync(
    path.join(rootDir, "secret-contract-api.cjs"),
    channelSecretContractModuleSource(params.channelId),
    "utf8",
  );
  return {
    id: params.pluginId,
    origin: "global",
    channels: [params.channelId],
    channelConfigs: {},
    rootDir,
  };
}

describe("external channel secret contract api", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshotMock.mockReset();
    loadBundledPluginPublicArtifactModuleSyncMock.mockClear();
    shouldRejectHardlinkedPluginFilesMock.mockReset();
    shouldRejectHardlinkedPluginFilesMock.mockReturnValue(true);
  });

  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  it("loads root secret-contract-api sidecars for external channel plugins", () => {
    const record = writeExternalChannelPlugin({ pluginId: "discord", channelId: "discord" });
    loadPluginMetadataSnapshotMock.mockReturnValue({
      plugins: [record],
    });

    const api = loadChannelSecretContractApi({
      channelId: "discord",
      config: { channels: { discord: {} } },
      env: {},
      loadablePluginOrigins: new Map([["discord", "global"]]),
    });

    const contractApi = requireChannelSecretContractApi(api);
    expectDiscordTokenRegistryEntry(contractApi);
    expect(contractApi.collectRuntimeConfigAssignments).toBeTypeOf("function");
  });

  it("loads dist/ secret-contract-api sidecars for compiled npm-published external channel plugins", () => {
    const rootDir = makeTrackedTempDir("openclaw-channel-secret-contract-dist", tempDirs);
    fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "dist", "secret-contract-api.cjs"),
      channelSecretContractModuleSource("discord"),
      "utf8",
    );
    const record = {
      id: "discord",
      origin: "global",
      channels: ["discord"],
      channelConfigs: {},
      rootDir,
    };
    loadPluginMetadataSnapshotMock.mockReturnValue({
      plugins: [record],
    });

    const api = loadChannelSecretContractApi({
      channelId: "discord",
      config: { channels: { discord: {} } },
      env: {},
      loadablePluginOrigins: new Map([["discord", "global"]]),
    });

    const contractApi = requireChannelSecretContractApi(api);
    expectDiscordTokenRegistryEntry(contractApi);
    expect(contractApi.collectRuntimeConfigAssignments).toBeTypeOf("function");
  });

  it.runIf(process.platform !== "win32")(
    "loads hardlinked external channel contracts when the plugin hardlink policy allows them",
    () => {
      const rootDir = makeTrackedTempDir("openclaw-channel-secret-contract-hardlink", tempDirs);
      const outsideDir = makeTrackedTempDir(
        "openclaw-channel-secret-contract-hardlink-outside",
        tempDirs,
      );
      const outsideContractPath = path.join(outsideDir, "secret-contract-api.cjs");
      fs.writeFileSync(outsideContractPath, channelSecretContractModuleSource("discord"), "utf8");
      fs.linkSync(outsideContractPath, path.join(rootDir, "secret-contract-api.cjs"));
      shouldRejectHardlinkedPluginFilesMock.mockReturnValue(false);

      const record = {
        id: "discord",
        origin: "global",
        channels: ["discord"],
        channelConfigs: {},
        rootDir,
      };
      const env = { OPENCLAW_NIX_MODE: "1" };
      loadPluginMetadataSnapshotMock.mockReturnValue({
        plugins: [record],
      });

      const api = loadChannelSecretContractApi({
        channelId: "discord",
        config: { channels: { discord: {} } },
        env,
        loadablePluginOrigins: new Map([["discord", "global"]]),
      });

      expect(shouldRejectHardlinkedPluginFilesMock).toHaveBeenCalledWith({
        origin: "global",
        rootDir,
        env,
      });
      const contractApi = requireChannelSecretContractApi(api);
      expectDiscordTokenRegistryEntry(contractApi);
    },
  );

  it("skips external channel records outside the loadable plugin origin set", () => {
    const record = writeExternalChannelPlugin({ pluginId: "discord", channelId: "discord" });
    loadPluginMetadataSnapshotMock.mockReturnValue({
      plugins: [record],
    });

    const api = loadChannelSecretContractApi({
      channelId: "discord",
      config: { channels: { discord: {} } },
      env: {},
      loadablePluginOrigins: new Map([["other", "global"]]),
    });

    expect(api).toBeUndefined();
  });
});
