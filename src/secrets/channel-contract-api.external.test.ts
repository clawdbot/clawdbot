/** Tests external plugin channel secret contract API loading. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const {
  loadPluginMetadataSnapshotMock,
  loadBundledPublicArtifactMock,
  shouldRejectHardlinkedPluginFilesMock,
} = vi.hoisted(() => ({
  loadPluginMetadataSnapshotMock: vi.fn(),
  loadBundledPublicArtifactMock: vi.fn(() => null),
  shouldRejectHardlinkedPluginFilesMock: vi.fn<
    typeof import("../plugins/hardlink-policy.js").shouldRejectHardlinkedPluginFiles
  >(() => true),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: (...args: unknown[]) => {
    const snapshot = loadPluginMetadataSnapshotMock(...args);
    return snapshot.manifestRegistry ?? snapshot;
  },
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadBundledPublicArtifactMock,
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
    loadBundledPublicArtifactMock.mockClear();
    shouldRejectHardlinkedPluginFilesMock.mockReset();
    shouldRejectHardlinkedPluginFilesMock.mockReturnValue(true);
  });

  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  it("reuses successful external channel contracts without probing their files", () => {
    const record = writeExternalChannelPlugin({ pluginId: "discord", channelId: "discord" });
    loadPluginMetadataSnapshotMock.mockReturnValue({
      plugins: [record],
    });

    const params = {
      channelId: "discord",
      config: { channels: { discord: {} } },
      env: {},
      loadablePluginOrigins: new Map([["discord", "global"]]),
    } satisfies Parameters<typeof loadChannelSecretContractApi>[0];

    const contractApi = requireChannelSecretContractApi(loadChannelSecretContractApi(params));
    expectDiscordTokenRegistryEntry(contractApi);
    expect(contractApi.collectRuntimeConfigAssignments).toBeTypeOf("function");

    const roots = [record.rootDir, fs.realpathSync(record.rootDir)];
    const isExternalPath = ([filePath]: [fs.PathLike, ...unknown[]]) =>
      typeof filePath === "string" &&
      roots.some((root) => filePath.startsWith(`${root}${path.sep}`));
    const exists = vi.spyOn(fs, "existsSync");
    const open = vi.spyOn(fs, "openSync");
    try {
      expect(loadChannelSecretContractApi(params)).toBe(contractApi);
      expect(
        loadChannelSecretContractApi({ ...params, loadablePluginOrigins: new Map() }),
      ).toBeUndefined();
      expect(loadChannelSecretContractApi(params)).toBe(contractApi);
      expect({
        probes: exists.mock.calls.filter(isExternalPath),
        opens: open.mock.calls.filter(isExternalPath),
      }).toEqual({ probes: [], opens: [] });
    } finally {
      exists.mockRestore();
      open.mockRestore();
    }
  });

  it("keeps a healthy external contract available when another artifact fails to load", () => {
    const broken = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
    const healthy = writeExternalChannelPlugin({ pluginId: "custom-alt", channelId: "custom" });
    fs.writeFileSync(
      path.join(broken.rootDir, "secret-contract-api.cjs"),
      'throw new Error("contract dependency unavailable");\n',
    );
    loadPluginMetadataSnapshotMock.mockReturnValue({ plugins: [broken, healthy] });

    const api = loadChannelSecretContractApi({ channelId: "custom", config: {}, env: {} });

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.custom.token",
    ]);
  });

  it("keeps missing external contract artifacts absent until a new cache generation", () => {
    const rootDir = makeTrackedTempDir("openclaw-channel-secret-contract-dist", tempDirs);
    fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
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

    const params = {
      channelId: "discord",
      config: { channels: { discord: {} } },
      env: {},
      loadablePluginOrigins: new Map([["discord", "global"]]),
    } satisfies Parameters<typeof loadChannelSecretContractApi>[0];
    expect(loadChannelSecretContractApi(params)).toBeUndefined();
    fs.writeFileSync(
      path.join(rootDir, "dist", "secret-contract-api.cjs"),
      channelSecretContractModuleSource("discord"),
      "utf8",
    );

    expect(loadChannelSecretContractApi(params)).toBeUndefined();
    const inspection = createPluginCache();
    try {
      const contractApi = withPluginCache(inspection, () =>
        requireChannelSecretContractApi(loadChannelSecretContractApi(params)),
      );
      expectDiscordTokenRegistryEntry(contractApi);
      expect(contractApi.collectRuntimeConfigAssignments).toBeTypeOf("function");
      expect(loadChannelSecretContractApi(params)).toBeUndefined();
    } finally {
      inspection.disposeModules?.();
    }
  });

  it.runIf(process.platform !== "win32")(
    "revalidates hardlinked external channel contracts when Nix mode changes",
    () => {
      const rootDir = makeTrackedTempDir("openclaw-channel-secret-contract-hardlink", tempDirs);
      const outsideDir = makeTrackedTempDir(
        "openclaw-channel-secret-contract-hardlink-outside",
        tempDirs,
      );
      const outsideContractPath = path.join(outsideDir, "secret-contract-api.cjs");
      fs.writeFileSync(outsideContractPath, channelSecretContractModuleSource("discord"), "utf8");
      fs.linkSync(outsideContractPath, path.join(rootDir, "secret-contract-api.cjs"));
      shouldRejectHardlinkedPluginFilesMock.mockImplementation(
        ({ env }) => env?.OPENCLAW_NIX_MODE !== "1",
      );

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

      const params = {
        channelId: "discord",
        config: { channels: { discord: {} } },
        env,
        loadablePluginOrigins: new Map([["discord", "global"]]),
      } satisfies Parameters<typeof loadChannelSecretContractApi>[0];
      const contractApi = requireChannelSecretContractApi(loadChannelSecretContractApi(params));

      expect(shouldRejectHardlinkedPluginFilesMock).toHaveBeenCalledWith({
        origin: "global",
        rootDir,
        env,
      });
      expectDiscordTokenRegistryEntry(contractApi);

      env.OPENCLAW_NIX_MODE = "0";
      expect(loadChannelSecretContractApi(params)).toBeUndefined();
      env.OPENCLAW_NIX_MODE = "1";
      expect(loadChannelSecretContractApi(params)).toBe(contractApi);
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

  it("falls back to official host secret metadata when an external plugin has no artifact", () => {
    loadPluginMetadataSnapshotMock.mockReturnValue({ plugins: [] });

    const api = loadChannelSecretContractApi({
      channelId: "qqbot",
      config: { channels: { qqbot: { appId: "app" } } },
      env: {},
    });

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.qqbot.accounts.*.clientSecret",
      "channels.qqbot.clientSecret",
    ]);
    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
  });

  it("falls back to official host secret metadata when plugin metadata is unavailable", () => {
    loadPluginMetadataSnapshotMock.mockImplementation(() => {
      throw new Error("metadata unavailable");
    });

    const api = loadChannelSecretContractApi({
      channelId: "qqbot",
      config: { channels: { qqbot: { appId: "app" } } },
      env: {},
    });

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.qqbot.accounts.*.clientSecret",
      "channels.qqbot.clientSecret",
    ]);
  });

  it("does not hide installed plugin contract loading failures behind the official fallback", () => {
    const record = writeExternalChannelPlugin({ pluginId: "qqbot", channelId: "qqbot" });
    loadPluginMetadataSnapshotMock.mockReturnValue({ plugins: [record] });
    shouldRejectHardlinkedPluginFilesMock.mockImplementation(() => {
      throw new Error("contract policy failed");
    });

    const params = {
      channelId: "qqbot",
      config: { channels: { qqbot: { appId: "app" } } },
      env: {},
    };
    expect(() => loadChannelSecretContractApi(params)).toThrow("contract policy failed");

    shouldRejectHardlinkedPluginFilesMock.mockReturnValue(true);
    expect(
      loadChannelSecretContractApi(params)?.secretTargetRegistryEntries?.map(({ id }) => id),
    ).toEqual(["channels.qqbot.token"]);
  });
});
