import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginInstallDir } from "./install.js";
import {
  cleanupTrackedTempDirsAsync,
  makeTrackedTempDirAsync,
} from "./test-helpers/fs-fixtures.js";
import {
  removePluginFromConfig,
  resolveUninstallChannelConfigKeys,
  resolveUninstallDirectoryTarget,
  uninstallPlugin,
} from "./uninstall.js";

type PluginConfig = NonNullable<OpenClawConfig["plugins"]>;
type PluginInstallRecord = NonNullable<PluginConfig["installs"]>[string];

async function createInstalledNpmPluginFixture(params: {
  baseDir: string;
  pluginId?: string;
}): Promise<{
  pluginId: string;
  extensionsDir: string;
  pluginDir: string;
  config: OpenClawConfig;
}> {
  const pluginId = params.pluginId ?? "my-plugin";
  const extensionsDir = path.join(params.baseDir, "extensions");
  const pluginDir = resolvePluginInstallDir(pluginId, extensionsDir);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");

  return {
    pluginId,
    extensionsDir,
    pluginDir,
    config: {
      plugins: {
        entries: {
          [pluginId]: { enabled: true },
        },
        installs: {
          [pluginId]: {
            source: "npm",
            spec: `${pluginId}@1.0.0`,
            installPath: pluginDir,
          },
        },
      },
    },
  };
}

type UninstallResult = Awaited<ReturnType<typeof uninstallPlugin>>;

async function runDeleteInstalledNpmPluginFixture(baseDir: string): Promise<{
  pluginDir: string;
  result: UninstallResult;
}> {
  const { pluginId, extensionsDir, pluginDir, config } = await createInstalledNpmPluginFixture({
    baseDir,
  });
  const result = await uninstallPlugin({
    config,
    pluginId,
    deleteFiles: true,
    extensionsDir,
  });
  return { pluginDir, result };
}

function expectSuccessfulUninstall(result: UninstallResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected uninstall success, got: ${result.error}`);
  }
  return result;
}

function expectSuccessfulUninstallActions(
  result: UninstallResult,
  params: {
    directory: boolean;
    loadPath?: boolean;
    warnings?: string[];
  },
) {
  const successfulResult = expectSuccessfulUninstall(result);
  expect(successfulResult.actions.directory).toBe(params.directory);
  if (params.loadPath !== undefined) {
    expect(successfulResult.actions.loadPath).toBe(params.loadPath);
  }
  if (params.warnings) {
    expect(successfulResult.warnings).toEqual(params.warnings);
  }
  return successfulResult;
}

function createSinglePluginEntries(pluginId = "my-plugin") {
  return {
    [pluginId]: { enabled: true },
  };
}

function createNpmInstallRecord(pluginId = "my-plugin", installPath?: string): PluginInstallRecord {
  return {
    source: "npm",
    spec: `${pluginId}@1.0.0`,
    ...(installPath ? { installPath } : {}),
  };
}

function createPathInstallRecord(
  installPath = "/path/to/plugin",
  sourcePath = installPath,
): PluginInstallRecord {
  return {
    source: "path",
    sourcePath,
    installPath,
  };
}

function createPluginConfig(params: {
  entries?: Record<string, { enabled: boolean }>;
  installs?: Record<string, PluginInstallRecord>;
  allow?: string[];
  deny?: string[];
  enabled?: boolean;
  slots?: PluginConfig["slots"];
  loadPaths?: string[];
  channels?: OpenClawConfig["channels"];
}): OpenClawConfig {
  const plugins: PluginConfig = {};
  if (params.entries) {
    plugins.entries = params.entries;
  }
  if (params.installs) {
    plugins.installs = params.installs;
  }
  if (params.allow) {
    plugins.allow = params.allow;
  }
  if (params.deny) {
    plugins.deny = params.deny;
  }
  if (params.enabled !== undefined) {
    plugins.enabled = params.enabled;
  }
  if (params.slots) {
    plugins.slots = params.slots;
  }
  if (params.loadPaths) {
    plugins.load = { paths: params.loadPaths };
  }
  return {
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
    ...(params.channels ? { channels: params.channels } : {}),
  };
}

function expectRemainingChannels(
  channels: OpenClawConfig["channels"],
  expected: Record<string, unknown> | undefined,
) {
  expect(channels as Record<string, unknown> | undefined).toEqual(expected);
}

function expectChannelCleanupResult(params: {
  config: OpenClawConfig;
  pluginId: string;
  expectedChannels: Record<string, unknown> | undefined;
  expectedChanged: boolean;
  options?: { channelIds?: readonly string[] };
}) {
  const { config: result, actions } = removePluginFromConfig(
    params.config,
    params.pluginId,
    params.options
      ? params.options.channelIds
        ? { channelIds: [...params.options.channelIds] }
        : {}
      : undefined,
  );
  expectRemainingChannels(result.channels, params.expectedChannels);
  expect(actions.channelConfig).toBe(params.expectedChanged);
}

function createSinglePluginWithEmptySlotsConfig(): OpenClawConfig {
  return createPluginConfig({
    entries: createSinglePluginEntries(),
    slots: {},
  });
}

function createSingleNpmInstallConfig(installPath: string): OpenClawConfig {
  return createPluginConfig({
    entries: createSinglePluginEntries(),
    installs: {
      "my-plugin": createNpmInstallRecord("my-plugin", installPath),
    },
  });
}

async function createPluginDirFixture(baseDir: string, pluginId = "my-plugin") {
  const pluginDir = path.join(baseDir, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");
  return pluginDir;
}

async function expectPathAccessState(pathToCheck: string, expected: "exists" | "missing") {
  const accessExpectation = fs.access(pathToCheck);
  if (expected === "exists") {
    await expect(accessExpectation).resolves.toBeUndefined();
    return;
  }
  await expect(accessExpectation).rejects.toThrow();
}

describe("resolveUninstallChannelConfigKeys", () => {
  it("falls back to pluginId when channelIds are unknown", () => {
    expect(resolveUninstallChannelConfigKeys("timbot")).toEqual(["timbot"]);
  });

  it("keeps explicit empty channelIds as remove-nothing", () => {
    expect(resolveUninstallChannelConfigKeys("telegram", { channelIds: [] })).toEqual([]);
  });

  it("filters shared keys and duplicate channel ids", () => {
    expect(
      resolveUninstallChannelConfigKeys("bad-plugin", {
        channelIds: ["defaults", "discord", "discord", "modelByChannel", "slack"],
      }),
    ).toEqual(["discord", "slack"]);
  });
});

describe("removePluginFromConfig", () => {
  it("removes plugin from entries", () => {
    const config = createPluginConfig({
      entries: {
        ...createSinglePluginEntries(),
        "other-plugin": { enabled: true },
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toEqual({ "other-plugin": { enabled: true } });
    expect(actions.entry).toBe(true);
  });

  it("removes plugin from installs", () => {
    const config = createPluginConfig({
      installs: {
        "my-plugin": createNpmInstallRecord(),
        "other-plugin": createNpmInstallRecord("other-plugin"),
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.installs).toEqual({
      "other-plugin": createNpmInstallRecord("other-plugin"),
    });
    expect(actions.install).toBe(true);
  });

  it("removes plugin from allowlist", () => {
    const config = createPluginConfig({
      allow: ["my-plugin", "other-plugin"],
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.allow).toEqual(["other-plugin"]);
    expect(actions.allowlist).toBe(true);
  });

  it.each([
    {
      name: "removes linked path from load.paths",
      loadPaths: ["/path/to/plugin", "/other/path"],
      expectedPaths: ["/other/path"],
    },
    {
      name: "cleans up load when removing the only linked path",
      loadPaths: ["/path/to/plugin"],
      expectedPaths: undefined,
    },
  ])("$name", ({ loadPaths, expectedPaths }) => {
    const config = createPluginConfig({
      installs: {
        "my-plugin": createPathInstallRecord(),
      },
      loadPaths,
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.load?.paths).toEqual(expectedPaths);
    expect(actions.loadPath).toBe(true);
  });

  it("removes absolute load path for a workspace-relative install source path", async () => {
    const tempRoot = path.join(process.cwd(), ".tmp");
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-uninstall-portable-source-"));
    try {
      const pluginDir = path.join(tempDir, "plugins", "demo");
      await fs.mkdir(pluginDir, { recursive: true });
      const realPluginDir = await fs.realpath(pluginDir);
      const sourcePath = `./${path.relative(process.cwd(), realPluginDir).split(path.sep).join("/")}`;
      const config = createPluginConfig({
        installs: {
          "my-plugin": createPathInstallRecord(undefined, sourcePath),
        },
        loadPaths: [realPluginDir, "/other/path"],
      });

      const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

      expect(result.plugins?.load?.paths).toEqual(["/other/path"]);
      expect(actions.loadPath).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "clears memory slot when uninstalling active memory plugin",
      config: createPluginConfig({
        entries: {
          "memory-plugin": { enabled: true },
        },
        slots: {
          memory: "memory-plugin",
        },
      }),
      pluginId: "memory-plugin",
      expectedMemory: "memory-core",
      expectedChanged: true,
    },
    {
      name: "does not modify memory slot when uninstalling non-memory plugin",
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
        slots: {
          memory: "memory-core",
        },
      }),
      pluginId: "my-plugin",
      expectedMemory: "memory-core",
      expectedChanged: false,
    },
  ] as const)("$name", ({ config, pluginId, expectedMemory, expectedChanged }) => {
    const { config: result, actions } = removePluginFromConfig(config, pluginId);

    expect(result.plugins?.slots?.memory).toBe(expectedMemory);
    expect(actions.memorySlot).toBe(expectedChanged);
  });

  it("removes plugins object when uninstall leaves only empty slots", () => {
    const config = createSinglePluginWithEmptySlotsConfig();

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.slots).toBeUndefined();
  });

  it("cleans up empty slots object", () => {
    const config = createSinglePluginWithEmptySlotsConfig();

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins).toBeUndefined();
  });

  it.each([
    {
      name: "handles plugin that only exists in entries",
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
      }),
      expectedEntries: undefined,
      expectedInstalls: undefined,
      entryChanged: true,
      installChanged: false,
    },
    {
      name: "handles plugin that only exists in installs",
      config: createPluginConfig({
        installs: {
          "my-plugin": createNpmInstallRecord(),
        },
      }),
      expectedEntries: undefined,
      expectedInstalls: undefined,
      entryChanged: false,
      installChanged: true,
    },
  ])("$name", ({ config, expectedEntries, expectedInstalls, entryChanged, installChanged }) => {
    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toEqual(expectedEntries);
    expect(result.plugins?.installs).toEqual(expectedInstalls);
    expect(actions.entry).toBe(entryChanged);
    expect(actions.install).toBe(installChanged);
  });

  it("cleans up empty plugins object", () => {
    const config = createPluginConfig({
      entries: createSinglePluginEntries(),
    });

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toBeUndefined();
  });

  it("preserves other config values", () => {
    const config = createPluginConfig({
      enabled: true,
      deny: ["denied-plugin"],
      entries: createSinglePluginEntries(),
    });

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.enabled).toBe(true);
    expect(result.plugins?.deny).toEqual(["denied-plugin"]);
  });

  it.each([
    {
      name: "removes channel config for installed extension plugin",
      config: createPluginConfig({
        entries: {
          timbot: { enabled: true },
        },
        installs: {
          timbot: createNpmInstallRecord("timbot"),
        },
        channels: {
          timbot: { sdkAppId: "123", secretKey: "abc" },
          telegram: { enabled: true },
        },
      }),
      pluginId: "timbot",
      expectedChannels: {
        telegram: { enabled: true },
      },
      expectedChanged: true,
    },
    {
      name: "does not remove channel config for built-in channel without install record",
      config: createPluginConfig({
        entries: {
          telegram: { enabled: true },
        },
        channels: {
          telegram: { enabled: true },
          discord: { enabled: true },
        },
      }),
      pluginId: "telegram",
      expectedChannels: {
        telegram: { enabled: true },
        discord: { enabled: true },
      },
      expectedChanged: false,
    },
    {
      name: "cleans up channels object when removing the only channel config",
      config: createPluginConfig({
        entries: {
          timbot: { enabled: true },
        },
        installs: {
          timbot: createNpmInstallRecord("timbot"),
        },
        channels: {
          timbot: { sdkAppId: "123" },
        },
      }),
      pluginId: "timbot",
      expectedChannels: undefined,
      expectedChanged: true,
    },
    {
      name: "does not set channelConfig action when no channel config exists",
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
        installs: {
          "my-plugin": createNpmInstallRecord(),
        },
      }),
      pluginId: "my-plugin",
      expectedChannels: undefined,
      expectedChanged: false,
    },
    {
      name: "does not remove channel config when plugin has no install record",
      config: createPluginConfig({
        entries: {
          discord: { enabled: true },
        },
        channels: {
          discord: { enabled: true, token: "abc" },
        },
      }),
      pluginId: "discord",
      expectedChannels: {
        discord: {
          enabled: true,
          token: "abc",
        },
      },
      expectedChanged: false,
    },
    {
      name: "removes channel config using explicit channelIds when pluginId differs",
      config: createPluginConfig({
        entries: {
          "timbot-plugin": { enabled: true },
        },
        installs: {
          "timbot-plugin": createNpmInstallRecord("timbot-plugin"),
        },
        channels: {
          timbot: { sdkAppId: "123" },
          "timbot-v2": { sdkAppId: "456" },
          telegram: { enabled: true },
        },
      }),
      pluginId: "timbot-plugin",
      options: {
        channelIds: ["timbot", "timbot-v2"],
      },
      expectedChannels: {
        telegram: { enabled: true },
      },
      expectedChanged: true,
    },
    {
      name: "preserves shared channel keys (defaults, modelByChannel)",
      config: createPluginConfig({
        entries: {
          timbot: { enabled: true },
        },
        installs: {
          timbot: createNpmInstallRecord("timbot"),
        },
        channels: {
          defaults: { groupPolicy: "opt-in" },
          modelByChannel: { timbot: "gpt-3.5" } as Record<string, string>,
          timbot: { sdkAppId: "123" },
        } as unknown as OpenClawConfig["channels"],
      }),
      pluginId: "timbot",
      expectedChannels: {
        defaults: { groupPolicy: "opt-in" },
        modelByChannel: { timbot: "gpt-3.5" },
      },
      expectedChanged: true,
    },
    {
      name: "does not remove shared keys even when passed as channelIds",
      config: createPluginConfig({
        entries: {
          "bad-plugin": { enabled: true },
        },
        installs: {
          "bad-plugin": createNpmInstallRecord("bad-plugin"),
        },
        channels: {
          defaults: { groupPolicy: "opt-in" },
        } as unknown as OpenClawConfig["channels"],
      }),
      pluginId: "bad-plugin",
      options: {
        channelIds: ["defaults"],
      },
      expectedChannels: {
        defaults: { groupPolicy: "opt-in" },
      },
      expectedChanged: false,
    },
    {
      name: "skips channel cleanup when channelIds is empty array (non-channel plugin)",
      config: createPluginConfig({
        entries: {
          telegram: { enabled: true },
        },
        installs: {
          telegram: createNpmInstallRecord("telegram"),
        },
        channels: {
          telegram: { enabled: true },
        },
      }),
      pluginId: "telegram",
      options: {
        channelIds: [],
      },
      expectedChannels: {
        telegram: { enabled: true },
      },
      expectedChanged: false,
    },
  ] as const)("$name", ({ config, pluginId, expectedChannels, expectedChanged, options }) => {
    expectChannelCleanupResult({
      config,
      pluginId,
      expectedChannels,
      expectedChanged,
      options,
    });
  });
});

describe("uninstallPlugin", () => {
  let tempDir: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    tempDir = await makeTrackedTempDirAsync("uninstall-test", tempDirs);
  });

  afterEach(async () => {
    await cleanupTrackedTempDirsAsync(tempDirs);
  });

  it("returns error when plugin not found", async () => {
    const config = createPluginConfig({});

    const result = await uninstallPlugin({
      config,
      pluginId: "nonexistent",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Plugin not found: nonexistent");
    }
  });

  it("removes config entries", async () => {
    const config = createPluginConfig({
      entries: createSinglePluginEntries(),
      installs: {
        "my-plugin": createNpmInstallRecord(),
      },
    });

    const result = await uninstallPlugin({
      config,
      pluginId: "my-plugin",
      deleteFiles: false,
    });

    const successfulResult = expectSuccessfulUninstall(result);
    expect(successfulResult.config.plugins?.entries).toBeUndefined();
    expect(successfulResult.config.plugins?.installs).toBeUndefined();
    expect(successfulResult.actions.entry).toBe(true);
    expect(successfulResult.actions.install).toBe(true);
  });

  it("deletes directory when deleteFiles is true", async () => {
    const { pluginDir, result } = await runDeleteInstalledNpmPluginFixture(tempDir);

    try {
      expectSuccessfulUninstallActions(result, {
        directory: true,
      });
      await expect(fs.access(pluginDir)).rejects.toThrow();
    } finally {
      await fs.rm(pluginDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "preserves directory for linked plugins",
      setup: async (baseDir: string) => {
        const pluginDir = await createPluginDirFixture(baseDir);
        return {
          config: createPluginConfig({
            entries: createSinglePluginEntries(),
            installs: {
              "my-plugin": createPathInstallRecord(pluginDir),
            },
            loadPaths: [pluginDir],
          }),
          deleteFiles: true,
          accessPath: pluginDir,
          expectedAccess: "exists" as const,
          expectedActions: {
            directory: false,
            loadPath: true,
          },
        };
      },
    },
    {
      name: "does not delete directory when deleteFiles is false",
      setup: async (baseDir: string) => {
        const pluginDir = await createPluginDirFixture(baseDir);
        return {
          config: createSingleNpmInstallConfig(pluginDir),
          deleteFiles: false,
          accessPath: pluginDir,
          expectedAccess: "exists" as const,
          expectedActions: {
            directory: false,
          },
        };
      },
    },
    {
      name: "succeeds even if directory does not exist",
      setup: async () => ({
        config: createSingleNpmInstallConfig("/nonexistent/path"),
        deleteFiles: true,
        expectedActions: {
          directory: false,
          warnings: [],
        },
      }),
    },
  ] as const)("$name", async ({ setup }) => {
    const params = await setup(tempDir);
    const result = await uninstallPlugin({
      config: params.config,
      pluginId: "my-plugin",
      deleteFiles: params.deleteFiles,
    });

    expectSuccessfulUninstallActions(result, params.expectedActions);
    if ("accessPath" in params && "expectedAccess" in params) {
      await expectPathAccessState(params.accessPath, params.expectedAccess);
    }
  });

  it("returns a warning when directory deletion fails unexpectedly", async () => {
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));
    try {
      const { result } = await runDeleteInstalledNpmPluginFixture(tempDir);

      const successfulResult = expectSuccessfulUninstallActions(result, {
        directory: false,
      });
      expect(successfulResult.warnings).toHaveLength(1);
      expect(successfulResult.warnings[0]).toContain("Failed to remove plugin directory");
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("never deletes arbitrary configured install paths", async () => {
    const outsideDir = path.join(tempDir, "outside-dir");
    const extensionsDir = path.join(tempDir, "extensions");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "index.js"), "// keep me");

    const config = createSingleNpmInstallConfig(outsideDir);

    const result = await uninstallPlugin({
      config,
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: false,
    });
    await expect(fs.access(outsideDir)).resolves.toBeUndefined();
  });
});

describe("resolveUninstallDirectoryTarget", () => {
  it("returns null for linked plugins", () => {
    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "my-plugin",
        hasInstall: true,
        installRecord: {
          source: "path",
          sourcePath: "/tmp/my-plugin",
          installPath: "/tmp/my-plugin",
        },
      }),
    ).toBeNull();
  });

  it("falls back to default path when configured installPath is untrusted", () => {
    const extensionsDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const target = resolveUninstallDirectoryTarget({
      pluginId: "my-plugin",
      hasInstall: true,
      installRecord: {
        source: "npm",
        spec: "my-plugin@1.0.0",
        installPath: "/tmp/not-openclaw-plugin-install/my-plugin",
      },
      extensionsDir,
    });

    expect(target).toBe(resolvePluginInstallDir("my-plugin", extensionsDir));
  });
});
