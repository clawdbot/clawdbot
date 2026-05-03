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
  applyPluginUninstallDirectoryRemoval,
  removePluginFromConfig,
  planPluginUninstall,
  resolveUninstallChannelConfigKeys,
  resolveUninstallDirectoryTarget,
  uninstallPlugin,
} from "./uninstall.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

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

function createGitInstallRecord(pluginId = "my-plugin", installPath?: string): PluginInstallRecord {
  return {
    source: "git",
    spec: `git:https://github.com/acme/${pluginId}.git`,
    gitUrl: `https://github.com/acme/${pluginId}.git`,
    gitCommit: "abc123",
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

  it("removes plugin from denylist", () => {
    const config = createPluginConfig({
      deny: ["my-plugin", "other-plugin"],
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.deny).toEqual(["other-plugin"]);
    expect(actions.denylist).toBe(true);
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

  it("clears context engine slot when uninstalling active context engine plugin", () => {
    const config = createPluginConfig({
      entries: {
        "context-plugin": { enabled: true },
      },
      slots: {
        contextEngine: "context-plugin",
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "context-plugin");

    expect(result.plugins?.slots?.contextEngine).toBe("legacy");
    expect(actions.contextEngineSlot).toBe(true);
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
    runCommandWithTimeoutMock.mockReset();
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    });
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

  it("cleans stale policy references even when plugin code and install records are gone", async () => {
    const result = await uninstallPlugin({
      config: createPluginConfig({
        allow: ["missing-plugin", "other-plugin"],
        deny: ["missing-plugin"],
        slots: {
          memory: "missing-plugin",
        },
      }),
      pluginId: "missing-plugin",
      deleteFiles: true,
    });

    const successfulResult = expectSuccessfulUninstall(result);
    expect(successfulResult.actions).toEqual({
      entry: false,
      install: false,
      allowlist: true,
      denylist: true,
      loadPath: false,
      memorySlot: true,
      contextEngineSlot: false,
      channelConfig: false,
      directory: false,
    });
    expect(successfulResult.config.plugins?.allow).toEqual(["other-plugin"]);
    expect(successfulResult.config.plugins?.deny).toBeUndefined();
    expect(successfulResult.config.plugins?.slots?.memory).toBe("memory-core");
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "enabled entry only, no installed code",
      pluginId: "missing-entry-plugin",
      config: createPluginConfig({
        entries: {
          "missing-entry-plugin": { enabled: true },
        },
      }),
      expectedActions: {
        entry: true,
        install: false,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: false,
        directory: false,
      },
      expectedConfig: {},
    },
    {
      name: "install record and channel config, no runtime plugin",
      pluginId: "missing-channel-plugin",
      config: createPluginConfig({
        installs: {
          "missing-channel-plugin": createNpmInstallRecord("missing-channel-plugin"),
        },
        channels: {
          "missing-channel-plugin": { enabled: true, token: "stale" },
          discord: { enabled: true },
        },
      }),
      expectedActions: {
        entry: false,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: true,
        directory: false,
      },
      expectedConfig: {
        channels: {
          discord: { enabled: true },
        },
      },
    },
    {
      name: "linked path record, missing source directory",
      pluginId: "missing-linked-plugin",
      config: createPluginConfig({
        installs: {
          "missing-linked-plugin": createPathInstallRecord(
            "/missing/openclaw/plugin",
            "/missing/openclaw/plugin",
          ),
        },
        loadPaths: ["/missing/openclaw/plugin", "/keep/this/plugin"],
      }),
      expectedActions: {
        entry: false,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: true,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: false,
        directory: false,
      },
      expectedConfig: {
        plugins: {
          load: {
            paths: ["/keep/this/plugin"],
          },
        },
      },
    },
    {
      name: "policy and slots only, no entry or install record",
      pluginId: "missing-policy-plugin",
      config: createPluginConfig({
        allow: ["missing-policy-plugin", "other-plugin"],
        deny: ["missing-policy-plugin"],
        slots: {
          memory: "missing-policy-plugin",
          contextEngine: "missing-policy-plugin",
        },
      }),
      expectedActions: {
        entry: false,
        install: false,
        allowlist: true,
        denylist: true,
        loadPath: false,
        memorySlot: true,
        contextEngineSlot: true,
        channelConfig: false,
        directory: false,
      },
      expectedConfig: {
        plugins: {
          allow: ["other-plugin"],
          slots: {
            memory: "memory-core",
            contextEngine: "legacy",
          },
        },
      },
    },
  ] as const)(
    "uninstall teardown matrix: $name",
    async ({ pluginId, config, expectedActions, expectedConfig }) => {
      const result = await uninstallPlugin({
        config,
        pluginId,
        deleteFiles: true,
        extensionsDir: path.join(tempDir, "extensions"),
      });

      const successfulResult = expectSuccessfulUninstall(result);
      expect(successfulResult.actions).toEqual(expectedActions);
      expect(successfulResult.config).toEqual(expectedConfig);
      expect(successfulResult.warnings).toEqual([]);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    },
  );

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

  it("plans directory removal without deleting before commit", async () => {
    const { pluginId, extensionsDir, pluginDir, config } = await createInstalledNpmPluginFixture({
      baseDir: tempDir,
    });

    const plan = planPluginUninstall({
      config,
      pluginId,
      deleteFiles: true,
      extensionsDir,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      throw new Error(plan.error);
    }
    expect(plan.directoryRemoval).toEqual({ target: pluginDir });
    expect(plan.actions.directory).toBe(false);
    await expect(fs.access(pluginDir)).resolves.toBeUndefined();

    const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    await expect(fs.access(pluginDir)).rejects.toThrow();
  });

  it("uninstalls npm-managed packages through npm before deleting the package directory", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const npmRoot = path.join(stateDir, "npm");
    const pluginDir = path.join(npmRoot, "node_modules", "@openclaw", "kitchen-sink");
    const hoistedDir = path.join(npmRoot, "node_modules", "is-number");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(hoistedDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "package.json"), "{}");
    await fs.writeFile(path.join(hoistedDir, "package.json"), "{}");

    const plan = planPluginUninstall({
      config: createPluginConfig({
        entries: createSinglePluginEntries("openclaw-kitchen-sink-fixture"),
        installs: {
          "openclaw-kitchen-sink-fixture": {
            source: "npm",
            spec: "@openclaw/kitchen-sink@1.0.0",
            installPath: pluginDir,
          },
        },
      }),
      pluginId: "openclaw-kitchen-sink-fixture",
      deleteFiles: true,
      extensionsDir,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      throw new Error(plan.error);
    }
    expect(plan.directoryRemoval).toEqual({
      target: pluginDir,
      cleanup: {
        kind: "npm",
        npmRoot,
        packageName: "@openclaw/kitchen-sink",
      },
    });

    const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);

    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      [
        "npm",
        "uninstall",
        "--loglevel=error",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        npmRoot,
        "@openclaw/kitchen-sink",
      ],
      expect.objectContaining({
        timeoutMs: 300_000,
        env: expect.objectContaining({
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          npm_config_package_lock: "true",
        }),
      }),
    );
    await expect(fs.access(pluginDir)).rejects.toThrow();
  });

  it("skips npm cleanup when the managed package directory is already absent", async () => {
    const stateDir = path.join(tempDir, "state");
    const npmRoot = path.join(stateDir, "npm");
    const pluginDir = path.join(npmRoot, "node_modules", "missing-plugin");

    const applied = await applyPluginUninstallDirectoryRemoval({
      target: pluginDir,
      cleanup: {
        kind: "npm",
        npmRoot,
        packageName: "missing-plugin",
      },
    });

    expect(applied).toEqual({ directoryRemoved: false, warnings: [] });
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("warns and still removes npm package dirs when npm prune cleanup fails", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "registry unavailable",
      signal: null,
      killed: false,
      termination: "exit",
    });
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const npmRoot = path.join(stateDir, "npm");
    const pluginDir = path.join(npmRoot, "node_modules", "demo-plugin");
    await fs.mkdir(pluginDir, { recursive: true });

    const result = await uninstallPlugin({
      config: createPluginConfig({
        entries: createSinglePluginEntries("demo-plugin"),
        installs: {
          "demo-plugin": {
            source: "npm",
            spec: "demo-plugin@1.0.0",
            installPath: pluginDir,
          },
        },
      }),
      pluginId: "demo-plugin",
      deleteFiles: true,
      extensionsDir,
    });

    const successfulResult = expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    expect(successfulResult.warnings).toEqual([
      "Failed to prune npm dependencies for plugin package demo-plugin: registry unavailable",
    ]);
    await expect(fs.access(pluginDir)).rejects.toThrow();
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
      name: "deletes managed directory for copied path installs",
      setup: async (baseDir: string) => {
        const sourceDir = await createPluginDirFixture(path.join(baseDir, "source"));
        const extensionsDir = path.join(baseDir, "extensions");
        const installDir = resolvePluginInstallDir("my-plugin", extensionsDir);
        await fs.mkdir(installDir, { recursive: true });
        await fs.writeFile(path.join(installDir, "index.js"), "// copied plugin");
        return {
          config: createPluginConfig({
            entries: createSinglePluginEntries(),
            installs: {
              "my-plugin": createPathInstallRecord(installDir, sourceDir),
            },
          }),
          deleteFiles: true,
          extensionsDir,
          accessPath: installDir,
          preservedPath: sourceDir,
          expectedAccess: "missing" as const,
          expectedActions: {
            directory: true,
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
      extensionsDir: "extensionsDir" in params ? params.extensionsDir : undefined,
    });

    expectSuccessfulUninstallActions(result, params.expectedActions);
    if ("accessPath" in params && "expectedAccess" in params) {
      await expectPathAccessState(params.accessPath, params.expectedAccess);
    }
    if ("preservedPath" in params) {
      await expectPathAccessState(params.preservedPath, "exists");
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

  it("deletes tracked managed install paths even when they are not the default target", async () => {
    const extensionsDir = path.join(tempDir, "extensions");
    const managedDir = path.join(extensionsDir, "archive-installs", "my-plugin");
    await fs.mkdir(managedDir, { recursive: true });
    await fs.writeFile(path.join(managedDir, "index.js"), "// plugin");

    const result = await uninstallPlugin({
      config: createSingleNpmInstallConfig(managedDir),
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    await expect(fs.access(managedDir)).rejects.toThrow();
  });

  it("deletes tracked installs from a recorded managed extensions root", async () => {
    const currentExtensionsDir = path.join(tempDir, "current", "extensions");
    const recordedExtensionsDir = path.join(tempDir, "recorded", "extensions");
    const installPath = resolvePluginInstallDir("my-plugin", recordedExtensionsDir);
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(path.join(installPath, "index.js"), "// plugin");

    const result = await uninstallPlugin({
      config: createSingleNpmInstallConfig(installPath),
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir: currentExtensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    await expect(fs.access(installPath)).rejects.toThrow();
  });

  it("deletes managed ClawHub install directories", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const installPath = resolvePluginInstallDir("clawpack-demo", extensionsDir);
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(path.join(installPath, "index.js"), "// clawhub plugin");

    const result = await uninstallPlugin({
      config: createPluginConfig({
        entries: createSinglePluginEntries("clawpack-demo"),
        installs: {
          "clawpack-demo": {
            source: "clawhub",
            spec: "clawhub:clawpack-demo@2026.5.1-beta.2",
            installPath,
            clawhubUrl: "https://clawhub.ai",
            clawhubPackage: "clawpack-demo",
            clawhubFamily: "code-plugin",
            clawhubChannel: "official",
            artifactKind: "npm-pack",
            artifactFormat: "tgz",
            npmIntegrity: "sha512-clawpack",
            npmShasum: "1".repeat(40),
            npmTarballName: "clawpack-demo-2026.5.1-beta.2.tgz",
            clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            clawpackSpecVersion: 1,
            clawpackManifestSha256:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            clawpackSize: 4096,
          },
        },
      }),
      pluginId: "clawpack-demo",
      deleteFiles: true,
      extensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    await expect(fs.access(installPath)).rejects.toThrow();
  });

  it("deletes managed git install repos outside the extensions directory", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const installParent = path.join(stateDir, "git", "git-abc123");
    const installPath = path.join(installParent, "repo");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(path.join(installPath, "index.js"), "// git plugin");

    const result = await uninstallPlugin({
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
        installs: {
          "my-plugin": createGitInstallRecord("my-plugin", installPath),
        },
      }),
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    await expect(fs.access(installPath)).rejects.toThrow();
    await expect(fs.access(installParent)).rejects.toThrow();
  });

  it("keeps non-empty managed git install parents after deleting the repo", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const installParent = path.join(stateDir, "git", "git-abc123");
    const installPath = path.join(installParent, "repo");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(path.join(installPath, "index.js"), "// git plugin");
    await fs.writeFile(path.join(installParent, "keep.txt"), "keep");

    const result = await uninstallPlugin({
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
        installs: {
          "my-plugin": createGitInstallRecord("my-plugin", installPath),
        },
      }),
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: true,
    });
    await expect(fs.access(installPath)).rejects.toThrow();
    await expect(fs.access(path.join(installParent, "keep.txt"))).resolves.toBeUndefined();
  });

  it("does not delete symlinked git install targets that resolve outside the managed git root", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const linkParentDir = path.join(stateDir, "git", "git-abc123");
    const installPath = path.join(linkParentDir, "repo");
    const outsideDir = path.join(tempDir, "outside");
    await fs.mkdir(linkParentDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "index.js"), "// keep me");
    await fs.symlink(outsideDir, installPath, "dir");

    const result = await uninstallPlugin({
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
        installs: {
          "my-plugin": createGitInstallRecord("my-plugin", installPath),
        },
      }),
      pluginId: "my-plugin",
      deleteFiles: true,
      extensionsDir,
    });

    expectSuccessfulUninstallActions(result, {
      directory: false,
    });
    await expect(fs.access(outsideDir)).resolves.toBeUndefined();
    const linkStat = await fs.lstat(installPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
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

  it("returns managed install path for copied path installs", () => {
    const extensionsDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const installPath = resolvePluginInstallDir("my-plugin", extensionsDir);

    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "my-plugin",
        hasInstall: true,
        installRecord: {
          source: "path",
          sourcePath: "/tmp/source-plugin",
          installPath,
        },
        extensionsDir,
      }),
    ).toBe(installPath);
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

  it("uses configured installPath when it stays inside the managed extensions dir", () => {
    const extensionsDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const installPath = path.join(extensionsDir, "archive-installs", "my-plugin");

    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "my-plugin",
        hasInstall: true,
        installRecord: {
          source: "archive",
          sourcePath: "/tmp/my-plugin.zip",
          installPath,
        },
        extensionsDir,
      }),
    ).toBe(installPath);
  });

  it("uses configured installPath when npm installed it under the managed npm root", () => {
    const stateDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const extensionsDir = path.join(stateDir, "extensions");
    const installPath = path.join(stateDir, "npm", "node_modules", "@openclaw", "kitchen-sink");

    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "openclaw-kitchen-sink-fixture",
        hasInstall: true,
        installRecord: {
          source: "npm",
          spec: "@openclaw/kitchen-sink@latest",
          installPath,
        },
        extensionsDir,
      }),
    ).toBe(installPath);
  });

  it("uses configured installPath when git installed it under the managed git root", () => {
    const stateDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const extensionsDir = path.join(stateDir, "extensions");
    const installPath = path.join(stateDir, "git", "git-abc123", "repo");

    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "my-plugin",
        hasInstall: true,
        installRecord: createGitInstallRecord("my-plugin", installPath),
        extensionsDir,
      }),
    ).toBe(installPath);
  });

  it("uses configured installPath when ClawHub installed it under the managed extensions root", () => {
    const stateDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const extensionsDir = path.join(stateDir, "extensions");
    const installPath = resolvePluginInstallDir("clawpack-demo", extensionsDir);

    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "clawpack-demo",
        hasInstall: true,
        installRecord: {
          source: "clawhub",
          spec: "clawhub:clawpack-demo@2026.5.1-beta.2",
          installPath,
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "clawpack-demo",
          clawhubFamily: "code-plugin",
          clawhubChannel: "official",
          artifactKind: "npm-pack",
          artifactFormat: "tgz",
          npmIntegrity: "sha512-clawpack",
          npmShasum: "1".repeat(40),
          npmTarballName: "clawpack-demo-2026.5.1-beta.2.tgz",
          clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          clawpackSpecVersion: 1,
          clawpackManifestSha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          clawpackSize: 4096,
        },
        extensionsDir,
      }),
    ).toBe(installPath);
  });

  it("does not trust git install paths outside the managed git root", () => {
    const stateDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const extensionsDir = path.join(stateDir, "extensions");

    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "my-plugin",
        hasInstall: true,
        installRecord: createGitInstallRecord(
          "my-plugin",
          path.join(os.tmpdir(), "git", "git-abc123", "repo"),
        ),
        extensionsDir,
      }),
    ).toBe(resolvePluginInstallDir("my-plugin", extensionsDir));
  });

  it("does not trust npm install paths outside the managed npm root", () => {
    const stateDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const extensionsDir = path.join(stateDir, "extensions");

    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "openclaw-kitchen-sink-fixture",
        hasInstall: true,
        installRecord: {
          source: "npm",
          spec: "@openclaw/kitchen-sink@latest",
          installPath: path.join(os.tmpdir(), "npm", "node_modules", "@openclaw", "kitchen-sink"),
        },
        extensionsDir,
      }),
    ).toBe(resolvePluginInstallDir("openclaw-kitchen-sink-fixture", extensionsDir));
  });

  it("uses configured installPath when it is under the recorded managed extensions root", () => {
    const currentExtensionsDir = path.join(os.tmpdir(), "openclaw-uninstall-current", "extensions");
    const recordedExtensionsDir = path.join(
      os.tmpdir(),
      "openclaw-uninstall-recorded",
      "extensions",
    );
    const installPath = resolvePluginInstallDir("my-plugin", recordedExtensionsDir);

    expect(
      resolveUninstallDirectoryTarget({
        pluginId: "my-plugin",
        hasInstall: true,
        installRecord: {
          source: "npm",
          spec: "my-plugin@1.0.0",
          installPath,
        },
        extensionsDir: currentExtensionsDir,
      }),
    ).toBe(installPath);
  });
});
