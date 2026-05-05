import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const { loadPluginMetadataSnapshotMock, loadBundledPluginPublicArtifactModuleSyncMock } =
  vi.hoisted(() => ({
    loadPluginMetadataSnapshotMock: vi.fn(),
    loadBundledPluginPublicArtifactModuleSyncMock: vi.fn(() => {
      throw new Error(
        "Unable to resolve bundled plugin public surface discord/secret-contract-api.js",
      );
    }),
  }));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleSync: loadBundledPluginPublicArtifactModuleSyncMock,
}));

import { loadChannelSecretContractApi } from "./channel-contract-api.js";

function writeExternalChannelPlugin(params: { pluginId: string; channelId: string }) {
  const rootDir = makeTrackedTempDir("openclaw-channel-secret-contract", tempDirs);
  fs.writeFileSync(
    path.join(rootDir, "secret-contract-api.cjs"),
    `
module.exports = {
  secretTargetRegistryEntries: [
    {
      id: "channels.${params.channelId}.token",
      targetType: "channels.${params.channelId}.token",
      configFile: "openclaw.json",
      pathPattern: "channels.${params.channelId}.token",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true
    }
  ],
  collectRuntimeConfigAssignments(params) {
    params.context.assignments.push({
      path: "channels.${params.channelId}.token",
      ref: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
      expected: "string",
      apply() {}
    });
  }
};
`,
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

    expect(api?.secretTargetRegistryEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "channels.discord.token",
        }),
      ]),
    );
    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
  });

  it("loads dist/ secret-contract-api sidecars for compiled npm-published external channel plugins", () => {
    const rootDir = makeTrackedTempDir("openclaw-channel-secret-contract-dist", tempDirs);
    fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "dist", "secret-contract-api.cjs"),
      `
module.exports = {
  secretTargetRegistryEntries: [
    {
      id: "channels.discord.token",
      targetType: "channels.discord.token",
      configFile: "openclaw.json",
      pathPattern: "channels.discord.token",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true
    }
  ],
  collectRuntimeConfigAssignments(params) {
    params.context.assignments.push({
      path: "channels.discord.token",
      ref: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
      expected: "string",
      apply() {}
    });
  }
};
`,
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

    expect(api?.secretTargetRegistryEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "channels.discord.token",
        }),
      ]),
    );
    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
  });

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
