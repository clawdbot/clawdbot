// Covers plugin uninstall flows and install-record cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { runCommandWithTimeout } from "../process/exec.js";
import { toRepoRelativePath } from "../test-utils/repo-files.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmGenerationProjectDirPrefix,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { resolvePluginInstallDir } from "./install.js";
import {
  cleanupTrackedTempDirsAsync,
  makeTrackedTempDirAsync,
} from "./test-helpers/fs-fixtures.js";
import { removePluginFromConfig } from "./uninstall-config.js";
import { pruneManagedNpmPeerDependenciesAfterUninstall } from "./uninstall-managed-npm.js";
import {
  prepareConfigForPendingPluginDirectoryRemovalSet,
  recordPluginPackageUninstallPlan,
} from "./uninstall-package-plan.js";
import {
  applyPluginUninstallDirectoryRemoval,
  planPluginUninstall,
  resolveUninstallChannelConfigKeys,
} from "./uninstall.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

type PluginConfig = NonNullable<OpenClawConfig["plugins"]>;
type PluginInstallRecord = NonNullable<PluginConfig["installs"]>[string];

async function uninstallPlugin(
  params: Parameters<typeof planPluginUninstall>[0] & {
    runtimePluginIds?: readonly string[];
    runtimeLoadPaths?: readonly string[];
  },
) {
  const { runtimePluginIds, runtimeLoadPaths, ...planParams } = params;
  const plan = planPluginUninstall(
    recordPluginPackageUninstallPlan(planParams, {
      runtimePluginIds: runtimePluginIds ?? [params.pluginId],
      ...(runtimeLoadPaths ? { runtimeLoadPaths } : {}),
    }),
  );
  if (!plan.ok) {
    return plan;
  }
  const directory = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
  return {
    ok: true as const,
    config: plan.config,
    pluginId: plan.pluginId,
    actions: { ...plan.actions, directory: directory.directoryRemoved },
    warnings: directory.warnings,
  };
}

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

function createMarketplaceInstallRecord(installPath: string): PluginInstallRecord {
  return {
    source: "marketplace",
    installPath,
    marketplaceSource: "release-fixtures",
    marketplacePlugin: "my-plugin",
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

it("stages only runtime child entries while a package directory removal is pending", () => {
  const staged = prepareConfigForPendingPluginDirectoryRemovalSet(
    {
      plugins: {
        entries: {
          "pack/one": { enabled: true },
          "pack/two": { enabled: true },
        },
      },
    },
    ["pack/one", "pack/two"],
  );

  expect(staged.plugins?.entries).toEqual({
    "pack/one": { enabled: false },
    "pack/two": { enabled: false },
  });
  expect(staged.plugins?.entries).not.toHaveProperty("pack");
});

async function createPluginDirFixture(baseDir: string, pluginId = "my-plugin") {
  const pluginDir = path.join(baseDir, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");
  return pluginDir;
}

async function expectPathAccessState(pathToCheck: string, expected: "exists" | "missing") {
  if (expected === "exists") {
    await fs.access(pathToCheck);
    return;
  }
  try {
    await fs.access(pathToCheck);
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected ${pathToCheck} to be missing`);
}

function expectNpmUninstallCommand(params: { packageName: string; npmRoot: string }) {
  const command = runCommandWithTimeoutMock.mock.calls[0];
  if (!command) {
    throw new Error("Expected npm uninstall command");
  }
  expect(command[0]).toEqual([
    "npm",
    "uninstall",
    "--loglevel=error",
    "--legacy-peer-deps",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    params.packageName,
  ]);
  const options = command[1] as {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  };
  expect(options.cwd).toBe(params.npmRoot);
  expect(options.timeoutMs).toBe(300_000);
  expect(options.env?.NPM_CONFIG_IGNORE_SCRIPTS).toBe("true");
  expect(options.env?.npm_config_legacy_peer_deps).toBe("true");
  expect(options.env?.npm_config_package_lock).toBe("true");
}

describe("resolveUninstallChannelConfigKeys", () => {
  it("falls back to pluginId when channelIds are unknown", () => {
    expect(resolveUninstallChannelConfigKeys("timbot")).toEqual(["timbot"]);
  });

  it("keeps explicit empty channelIds as remove-nothing", () => {
    expect(resolveUninstallChannelConfigKeys("telegram", { channelIds: [] })).toStrictEqual([]);
  });

  it("filters shared keys and duplicate channel ids", () => {
    expect(
      resolveUninstallChannelConfigKeys("bad-plugin", {
        channelIds: ["defaults", "discord", "discord", "modelByChannel", "slack"],
      }),
    ).toEqual(["discord", "slack"]);
  });
});

describe("planPluginUninstall package ownership", () => {
  it("removes every owned child policy while planning one owner install removal", () => {
    const result = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
          config: {
            plugins: {
              allow: ["pack/one", "pack/two", "other"],
              deny: ["pack/two"],
              entries: {
                "pack/one": { enabled: true },
                "pack/two": { enabled: false },
                other: { enabled: true },
              },
              installs: {
                pack: { source: "path", installPath: "/managed/pack" },
              },
              slots: { memory: "pack/two" },
            },
          },
          pluginId: "pack",
          deleteFiles: false,
        },
        { runtimePluginIds: ["pack/one", "pack/two"] },
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.directoryRemoval).toBeNull();
    expect(result.config.plugins).toEqual({
      allow: ["other"],
      entries: { other: { enabled: true } },
      slots: { memory: "memory-core" },
    });
    expect(result.actions).toMatchObject({
      entry: true,
      install: true,
      allowlist: true,
      denylist: true,
      memorySlot: true,
    });
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

  it.each([
    {
      name: "marketplace install path",
      installRecord: createMarketplaceInstallRecord("/managed/my-plugin"),
      loadPaths: ["/managed/my-plugin", "/managed/my-plugin/child", "/other/path"],
      expectedPaths: ["/managed/my-plugin/child", "/other/path"],
      expectedChanged: true,
    },
    {
      name: "npm install path",
      installRecord: createNpmInstallRecord("my-plugin", "/managed/my-plugin"),
      loadPaths: ["/managed/my-plugin", "/managed/my-plugin/child", "/other/path"],
      expectedPaths: ["/managed/my-plugin/child", "/other/path"],
      expectedChanged: true,
    },
    {
      name: "absent load paths",
      installRecord: createMarketplaceInstallRecord("/managed/my-plugin"),
      loadPaths: undefined,
      expectedPaths: undefined,
      expectedChanged: false,
    },
    {
      name: "mismatched and child paths",
      installRecord: createNpmInstallRecord("my-plugin", "/managed/my-plugin"),
      loadPaths: ["/managed/my-plugin-other", "/managed/my-plugin/child"],
      expectedPaths: ["/managed/my-plugin-other", "/managed/my-plugin/child"],
      expectedChanged: false,
    },
  ])(
    "cleans only the exact $name from load.paths",
    ({ installRecord, loadPaths, expectedPaths, expectedChanged }) => {
      const config = createPluginConfig({
        installs: { "my-plugin": installRecord },
        loadPaths,
      });

      const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

      expect(result.plugins?.load?.paths).toEqual(expectedPaths);
      expect(actions.loadPath).toBe(expectedChanged);
    },
  );

  it("removes a canonical marketplace install path without removing siblings", async () => {
    const tempRoot = path.join(process.cwd(), ".tmp");
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-uninstall-marketplace-path-"));
    try {
      const installPath = path.join(tempDir, "managed", "my-plugin");
      const linkedPath = path.join(tempDir, "my-plugin-link");
      const siblingPath = path.join(tempDir, "managed", "my-plugin-other");
      await fs.mkdir(installPath, { recursive: true });
      await fs.symlink(installPath, linkedPath, "dir");
      const config = createPluginConfig({
        installs: {
          "my-plugin": createMarketplaceInstallRecord(installPath),
        },
        loadPaths: [linkedPath, siblingPath],
      });

      const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

      expect(result.plugins?.load?.paths).toEqual([siblingPath]);
      expect(actions.loadPath).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes absolute load path for a workspace-relative install source path", async () => {
    const tempRoot = path.join(process.cwd(), ".tmp");
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-uninstall-portable-source-"));
    try {
      const pluginDir = path.join(tempDir, "plugins", "demo");
      await fs.mkdir(pluginDir, { recursive: true });
      const realPluginDir = await fs.realpath(pluginDir);
      const sourcePath = `./${toRepoRelativePath(process.cwd(), realPluginDir)}`;
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
    const globalConfig = path.join(tempDir, "global-npmrc");
    await fs.writeFile(globalConfig, "", "utf8");
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", globalConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
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

  it("does not treat inherited prototype names as installed plugins", async () => {
    const result = await uninstallPlugin({
      config: createPluginConfig({ entries: {}, installs: {} }),
      pluginId: "constructor",
      deleteFiles: false,
    });

    expect(result).toEqual({ ok: false, error: "Plugin not found: constructor" });
  });

  it("uninstalls own prototype-named plugin records", async () => {
    const result = await uninstallPlugin({
      config: createPluginConfig({
        entries: {
          constructor: { enabled: true },
        },
        installs: {
          constructor: createNpmInstallRecord("constructor"),
        },
      }),
      pluginId: "constructor",
      deleteFiles: false,
    });

    const successfulResult = expectSuccessfulUninstall(result);
    expect(successfulResult.config.plugins).toBeUndefined();
    expect(successfulResult.actions.entry).toBe(true);
    expect(successfulResult.actions.install).toBe(true);
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
      expect(successfulResult.warnings).toStrictEqual([]);
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
      await expectPathAccessState(pluginDir, "missing");
    } finally {
      await fs.rm(pluginDir, { recursive: true, force: true });
    }
  });

  it("plans directory removal without deleting before commit", async () => {
    const { pluginId, extensionsDir, pluginDir, config } = await createInstalledNpmPluginFixture({
      baseDir: tempDir,
    });

    const plan = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        { config, pluginId, deleteFiles: true, extensionsDir },
        { runtimePluginIds: [pluginId] },
      ),
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      throw new Error(plan.error);
    }
    expect(plan.directoryRemoval).toEqual({ target: pluginDir });
    expect(plan.actions.directory).toBe(false);
    await expect(fs.access(pluginDir)).resolves.toBeUndefined();

    const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    await expectPathAccessState(pluginDir, "missing");
  });

  it("uninstalls npm-managed packages through npm before deleting the package directory", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const npmRoot = path.join(stateDir, "npm");
    const pluginDir = path.join(npmRoot, "node_modules", "@openclaw", "kitchen-sink");
    const hoistedDir = path.join(npmRoot, "node_modules", "is-number");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(hoistedDir, { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/kitchen-sink": "1.0.0",
            "is-number": "7.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(path.join(pluginDir, "package.json"), "{}");
    await fs.writeFile(path.join(hoistedDir, "package.json"), "{}");

    const plan = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
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
        },
        { runtimePluginIds: ["openclaw-kitchen-sink-fixture"] },
      ),
    );

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
    expectNpmUninstallCommand({ packageName: "@openclaw/kitchen-sink", npmRoot });
    await expectPathAccessState(pluginDir, "missing");
  });

  it.each([
    { name: "ordinary", generationKey: undefined },
    { name: "generation", generationKey: "kitchen-sink-v2" },
  ])("uninstalls $name per-plugin npm projects through their project root", async (fixture) => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const npmBaseDir = path.join(stateDir, "npm");
    const npmRoot = fixture.generationKey
      ? resolvePluginNpmGenerationProjectDir({
          npmDir: npmBaseDir,
          packageName: "@openclaw/kitchen-sink",
          generationKey: fixture.generationKey,
        })
      : resolvePluginNpmProjectDir({
          npmDir: npmBaseDir,
          packageName: "@openclaw/kitchen-sink",
        });
    const pluginDir = path.join(npmRoot, "node_modules", "@openclaw", "kitchen-sink");
    const hoistedDir = path.join(npmRoot, "node_modules", "is-number");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(hoistedDir, { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/kitchen-sink": "1.0.0",
            "is-number": "7.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(path.join(pluginDir, "package.json"), "{}");
    await fs.writeFile(path.join(hoistedDir, "package.json"), "{}");

    const plan = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
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
        },
        { runtimePluginIds: ["openclaw-kitchen-sink-fixture"] },
      ),
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      throw new Error(plan.error);
    }
    expect(plan.directoryRemoval).toEqual({
      target: npmRoot,
      cleanup: {
        kind: "npm",
        npmRoot,
        packageName: "@openclaw/kitchen-sink",
      },
    });

    const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);

    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    await expectPathAccessState(pluginDir, "missing");
    await expectPathAccessState(npmRoot, "missing");
  });

  it.each([
    ["unrelated sibling", "noncanonical-sibling"],
    [
      "ordinary-name lookalike",
      `${path.basename(
        resolvePluginNpmProjectDir({
          npmDir: "/managed/npm",
          packageName: "@openclaw/kitchen-sink",
        }),
      )}-lookalike`,
    ],
    [
      "malformed generation prefix",
      `${path.basename(
        resolvePluginNpmProjectDir({
          npmDir: "/managed/npm",
          packageName: "@openclaw/kitchen-sink",
        }),
      )}__openclaw-generation_g-0123456789abcdef`,
    ],
    [
      "short generation suffix",
      `${resolvePluginNpmGenerationProjectDirPrefix("@openclaw/kitchen-sink")}g-0123456789abcde`,
    ],
    [
      "uppercase generation suffix",
      `${resolvePluginNpmGenerationProjectDirPrefix("@openclaw/kitchen-sink")}g-0123456789abcdeF`,
    ],
    [
      "generation suffix lookalike",
      `${resolvePluginNpmGenerationProjectDirPrefix("@openclaw/kitchen-sink")}g-0123456789abcdef-extra`,
    ],
  ])("preserves a noncanonical npm project root ($name)", async (_name, projectName) => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const npmRoot = path.join(stateDir, "npm", "projects", projectName);
    const pluginDir = path.join(npmRoot, "node_modules", "@openclaw", "kitchen-sink");
    const siblingFile = path.join(npmRoot, "must-remain.txt");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/kitchen-sink": "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(path.join(pluginDir, "package.json"), "{}");
    await fs.writeFile(siblingFile, "preserve me");

    const plan = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
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
        },
        { runtimePluginIds: ["openclaw-kitchen-sink-fixture"] },
      ),
    );

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
    await expectPathAccessState(pluginDir, "missing");
    await expect(fs.readFile(siblingFile, "utf8")).resolves.toBe("preserve me");
  });

  it("does not follow a substituted npm projects directory", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const npmDir = path.join(stateDir, "npm");
    const outsideProjectsDir = path.join(tempDir, "outside-projects");
    await fs.mkdir(npmDir, { recursive: true });
    await fs.mkdir(outsideProjectsDir, { recursive: true });
    await fs.symlink(outsideProjectsDir, path.join(npmDir, "projects"), "dir");
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir,
      packageName: "@openclaw/kitchen-sink",
    });
    const pluginDir = path.join(projectRoot, "node_modules", "@openclaw", "kitchen-sink");
    const sentinel = path.join(projectRoot, "must-remain.txt");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(sentinel, "preserve me");

    const result = await uninstallPlugin({
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

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.warnings).toEqual([]);
    expect(result.actions.directory).toBe(false);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me");
  });

  it("does not follow a substituted canonical npm project directory", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const npmDir = path.join(stateDir, "npm");
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir,
      packageName: "@openclaw/kitchen-sink",
    });
    const outsideProjectRoot = path.join(tempDir, "outside-project");
    const pluginDir = path.join(projectRoot, "node_modules", "@openclaw", "kitchen-sink");
    const outsidePluginDir = path.join(
      outsideProjectRoot,
      "node_modules",
      "@openclaw",
      "kitchen-sink",
    );
    const sentinel = path.join(outsideProjectRoot, "must-remain.txt");
    await fs.mkdir(path.dirname(projectRoot), { recursive: true });
    await fs.mkdir(outsidePluginDir, { recursive: true });
    await fs.writeFile(sentinel, "preserve me");
    await fs.symlink(outsideProjectRoot, projectRoot, "dir");

    const result = await uninstallPlugin({
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

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.warnings).toEqual([]);
    expect(result.actions.directory).toBe(false);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me");
  });

  it("rejects a symlinked package inside a canonical npm project", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const npmDir = path.join(stateDir, "npm");
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir,
      packageName: "@openclaw/kitchen-sink",
    });
    const pluginDir = path.join(projectRoot, "node_modules", "@openclaw", "kitchen-sink");
    const packageTarget = path.join(projectRoot, "node_modules", "package-target");
    const sentinel = path.join(projectRoot, "must-remain.txt");
    await fs.mkdir(path.dirname(pluginDir), { recursive: true });
    await fs.mkdir(packageTarget, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "package.json"), "{}\n");
    await fs.writeFile(sentinel, "preserve me");
    await fs.symlink(packageTarget, pluginDir, "dir");

    const plan = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
          config: createPluginConfig({
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
        },
        { runtimePluginIds: ["openclaw-kitchen-sink-fixture"] },
      ),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok || !plan.directoryRemoval) {
      throw new Error(plan.ok ? "missing removal" : plan.error);
    }
    expect(plan.directoryRemoval.target).toBe(pluginDir);

    const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);

    expect(applied).toEqual({
      directoryRemoved: false,
      warnings: [`Refused to remove npm path without canonical package ownership: ${pluginDir}`],
    });
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me");
    await expect(fs.lstat(pluginDir).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
  });

  it.each(["canonical", "noncanonical"] as const)(
    "revalidates %s npm project ownership after the removal plan is created",
    async (layout) => {
      const stateDir = path.join(tempDir, "state");
      const extensionsDir = path.join(stateDir, "extensions");
      const npmDir = path.join(stateDir, "npm");
      const projectRoot =
        layout === "canonical"
          ? resolvePluginNpmProjectDir({
              npmDir,
              packageName: "@openclaw/kitchen-sink",
            })
          : path.join(npmDir, "projects", "noncanonical-race");
      const pluginDir = path.join(projectRoot, "node_modules", "@openclaw", "kitchen-sink");
      await fs.mkdir(pluginDir, { recursive: true });
      const plan = planPluginUninstall(
        recordPluginPackageUninstallPlan(
          {
            config: createPluginConfig({
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
          },
          { runtimePluginIds: ["openclaw-kitchen-sink-fixture"] },
        ),
      );
      expect(plan.ok).toBe(true);
      if (!plan.ok || !plan.directoryRemoval) {
        throw new Error(plan.ok ? "missing removal" : plan.error);
      }
      expect(plan.directoryRemoval.target).toBe(layout === "canonical" ? projectRoot : pluginDir);

      const outsideNpmDir = path.join(tempDir, "outside-npm-race");
      const outsideProjectRoot = path.join(outsideNpmDir, "projects", path.basename(projectRoot));
      const outsideTarget =
        layout === "canonical"
          ? outsideProjectRoot
          : path.join(outsideProjectRoot, "node_modules", "@openclaw", "kitchen-sink");
      const sentinel = path.join(outsideTarget, "must-remain.txt");
      await fs.mkdir(outsideTarget, { recursive: true });
      await fs.writeFile(sentinel, "preserve me");
      await fs.rename(npmDir, `${npmDir}-original`);
      await fs.symlink(outsideNpmDir, npmDir, "dir");

      const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);

      expect(applied.directoryRemoved).toBe(false);
      expect(applied.warnings).toEqual([
        `Refused to remove npm path without canonical package ownership: ${plan.directoryRemoval.target}`,
      ]);
      await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("preserve me");
    },
  );

  it.each(["canonical", "noncanonical"] as const)(
    "refuses $layout npm cleanup through a substituted manifest",
    async (layout) => {
      const stateDir = path.join(tempDir, "state");
      const extensionsDir = path.join(stateDir, "extensions");
      const npmDir = path.join(stateDir, "npm");
      const npmRoot =
        layout === "canonical"
          ? resolvePluginNpmProjectDir({
              npmDir,
              packageName: "@openclaw/kitchen-sink",
            })
          : path.join(npmDir, "projects", "noncanonical-manifest");
      const pluginDir = path.join(npmRoot, "node_modules", "@openclaw", "kitchen-sink");
      const manifestPath = path.join(npmRoot, "package.json");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(manifestPath, "{}\n");
      const plan = planPluginUninstall(
        recordPluginPackageUninstallPlan(
          {
            config: createPluginConfig({
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
          },
          { runtimePluginIds: ["openclaw-kitchen-sink-fixture"] },
        ),
      );
      expect(plan.ok).toBe(true);
      if (!plan.ok || !plan.directoryRemoval) {
        throw new Error(plan.ok ? "missing removal" : plan.error);
      }
      const expectedTarget = layout === "canonical" ? npmRoot : pluginDir;
      expect(plan.directoryRemoval.target).toBe(expectedTarget);

      const outsideManifest = path.join(tempDir, "outside-package.json");
      await fs.writeFile(outsideManifest, '{"preserve":true}\n');
      await fs.rm(manifestPath);
      await fs.symlink(outsideManifest, manifestPath);

      const applied = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);

      expect(applied.directoryRemoved).toBe(false);
      expect(applied.warnings).toEqual([
        `Refused to remove npm path without canonical package ownership: ${expectedTarget}`,
      ]);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
      await expect(fs.readFile(outsideManifest, "utf8")).resolves.toBe('{"preserve":true}\n');
      await expectPathAccessState(pluginDir, "exists");
    },
  );

  it("repairs remaining npm plugin openclaw peer links after npm uninstall prunes them", async () => {
    const stateDir = path.join(tempDir, "state");
    const npmRoot = path.join(stateDir, "npm");
    const removedPluginDir = path.join(npmRoot, "node_modules", "removed-plugin");
    const peerPluginDir = path.join(npmRoot, "node_modules", "peer-plugin");
    const peerLink = path.join(peerPluginDir, "node_modules", "openclaw");
    await fs.mkdir(removedPluginDir, { recursive: true });
    await fs.mkdir(path.dirname(peerLink), { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "removed-plugin": "1.0.0",
            "peer-plugin": "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(path.join(removedPluginDir, "package.json"), "{}\n");
    await fs.writeFile(
      path.join(peerPluginDir, "package.json"),
      `${JSON.stringify(
        {
          name: "peer-plugin",
          version: "1.0.0",
          peerDependencies: { openclaw: ">=2026.0.0" },
        },
        null,
        2,
      )}\n`,
    );
    await fs.symlink(tempDir, peerLink, "junction");
    runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
      await fs.rm(peerLink, { recursive: true, force: true });
      if (!argv.includes("--legacy-peer-deps")) {
        await fs.mkdir(path.join(npmRoot, "node_modules", "openclaw"), { recursive: true });
      }
      return {
        code: 0,
        stdout: "",
        stderr: "",
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

    const applied = await applyPluginUninstallDirectoryRemoval({
      target: removedPluginDir,
      cleanup: {
        kind: "npm",
        npmRoot,
        packageName: "removed-plugin",
      },
    });

    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    await expectPathAccessState(removedPluginDir, "missing");
    await expectPathAccessState(path.join(npmRoot, "node_modules", "openclaw"), "missing");
    await expect(fs.lstat(peerLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
  });

  it("prunes managed peer dependencies after their owning npm plugin is uninstalled", async () => {
    const stateDir = path.join(tempDir, "state");
    const npmRoot = path.join(stateDir, "npm");
    const removedPluginDir = path.join(npmRoot, "node_modules", "removed-plugin");
    const runtimePeerDir = path.join(npmRoot, "node_modules", "runtime-peer");
    await fs.mkdir(removedPluginDir, { recursive: true });
    await fs.mkdir(runtimePeerDir, { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "removed-plugin": "1.0.0",
            "runtime-peer": "1.0.0",
          },
          openclaw: {
            managedPeerDependencies: ["runtime-peer"],
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(removedPluginDir, "package.json"),
      `${JSON.stringify(
        {
          name: "removed-plugin",
          version: "1.0.0",
          peerDependencies: { "runtime-peer": "^1.0.0" },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(runtimePeerDir, "package.json"),
      `${JSON.stringify({ name: "runtime-peer", version: "1.0.0" }, null, 2)}\n`,
    );
    runCommandWithTimeoutMock.mockImplementation(async (argv: string[], options?: unknown) => {
      if (argv[1] === "uninstall") {
        expect(argv).toContain("--legacy-peer-deps");
        await fs.rm(removedPluginDir, { recursive: true, force: true });
        const rootManifest = JSON.parse(
          await fs.readFile(path.join(npmRoot, "package.json"), "utf8"),
        ) as { dependencies?: Record<string, string> };
        delete rootManifest.dependencies?.["removed-plugin"];
        await fs.writeFile(
          path.join(npmRoot, "package.json"),
          `${JSON.stringify(rootManifest, null, 2)}\n`,
        );
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      if (argv[1] === "install" && argv.includes("--package-lock-only")) {
        const cwd = (options as { cwd?: string } | undefined)?.cwd;
        expect(cwd).toBeTruthy();
        await fs.writeFile(
          path.join(cwd as string, "package-lock.json"),
          `${JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }, null, 2)}\n`,
        );
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      if (argv[1] === "install") {
        expect(argv).toContain("--legacy-peer-deps");
        expect(argv).toContain("--omit=peer");
        await fs.rm(runtimePeerDir, { recursive: true, force: true });
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const applied = await applyPluginUninstallDirectoryRemoval({
      target: removedPluginDir,
      cleanup: {
        kind: "npm",
        npmRoot,
        packageName: "removed-plugin",
      },
    });

    expect(applied).toEqual({ directoryRemoved: true, warnings: [] });
    await expectPathAccessState(removedPluginDir, "missing");
    await expectPathAccessState(runtimePeerDir, "missing");
    const rootManifest = JSON.parse(
      await fs.readFile(path.join(npmRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    };
    expect(rootManifest.dependencies?.["removed-plugin"]).toBeUndefined();
    expect(rootManifest.dependencies?.["runtime-peer"]).toBeUndefined();
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain("runtime-peer");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(3);
  });

  it("retries managed peer cleanup without npm-incompatible override kinds", async () => {
    const npmRoot = path.join(tempDir, "npm-override-cleanup");
    await fs.mkdir(npmRoot, { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: { "stale-peer": "1.0.0" },
          overrides: {
            axios: "1.18.1",
            "node-domexception": "npm:@nolyfill/domexception@1.0.28",
            "werift-ice@0.2.2>ip": "npm:neoip@3.1.0",
          },
          openclaw: {
            managedOverrides: ["axios", "node-domexception", "werift-ice@0.2.2>ip"],
            managedPeerDependencies: ["stale-peer"],
          },
        },
        null,
        2,
      )}\n`,
    );

    let cleanupAttempts = 0;
    const runCommand: typeof runCommandWithTimeout = vi.fn(async (argv, optionsOrTimeout) => {
      const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
      if (argv.includes("--package-lock-only")) {
        expect(cwd).toBeTruthy();
        const manifest = JSON.parse(
          await fs.readFile(path.join(cwd as string, "package.json"), "utf8"),
        ) as { overrides?: Record<string, unknown> };
        if (manifest.overrides?.["werift-ice@0.2.2>ip"]) {
          return {
            code: 1,
            stdout: "",
            stderr:
              'npm error code EINVALIDTAGNAME\nnpm error Invalid tag name "0.2.2>ip" of package "werift-ice@0.2.2>ip"',
            signal: null,
            killed: false,
            termination: "exit" as const,
          };
        }
        if (manifest.overrides?.["node-domexception"]) {
          return {
            code: 1,
            stdout: "",
            stderr: "npm ERR! Invalid comparator: npm:@nolyfill/domexception@1.0.28",
            signal: null,
            killed: false,
            termination: "exit" as const,
          };
        }
        await fs.writeFile(
          path.join(cwd as string, "package-lock.json"),
          `${JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }, null, 2)}\n`,
        );
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      cleanupAttempts += 1;
      const manifest = JSON.parse(
        await fs.readFile(path.join(npmRoot, "package.json"), "utf8"),
      ) as { overrides?: Record<string, unknown> };
      if (cleanupAttempts === 1) {
        expect(manifest.overrides?.["werift-ice@0.2.2>ip"]).toBe("npm:neoip@3.1.0");
        return {
          code: 1,
          stdout: "",
          stderr:
            'npm error code EINVALIDTAGNAME\nnpm error Invalid tag name "0.2.2>ip" of package "werift-ice@0.2.2>ip"',
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (cleanupAttempts === 2) {
        expect(manifest.overrides?.["werift-ice@0.2.2>ip"]).toBeUndefined();
        expect(manifest.overrides?.["node-domexception"]).toBe("npm:@nolyfill/domexception@1.0.28");
        return {
          code: 1,
          stdout: "",
          stderr: "npm ERR! Invalid comparator: npm:@nolyfill/domexception@1.0.28",
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      expect(manifest.overrides).toEqual({ axios: "1.18.1", hono: "4.12.32" });
      return {
        code: 0,
        stdout: "",
        stderr: "",
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    });

    await expect(
      pruneManagedNpmPeerDependenciesAfterUninstall({
        npmRoot,
        packageName: "@openclaw/kitchen-sink",
        managedOverrides: {
          axios: "1.18.1",
          hono: "4.12.32",
          "node-domexception": "npm:@nolyfill/domexception@1.0.28",
          "werift-ice@0.2.2>ip": "npm:neoip@3.1.0",
        },
        runCommand,
      }),
    ).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(3);
    const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      overrides?: Record<string, unknown>;
      openclaw?: {
        managedOverrides?: string[];
        managedPeerDependencies?: string[];
      };
    };
    expect(manifest.dependencies).toEqual({});
    expect(manifest.overrides).toEqual({ axios: "1.18.1", hono: "4.12.32" });
    expect(manifest.openclaw?.managedOverrides).toEqual(["axios", "hono"]);
    expect(manifest.openclaw?.managedPeerDependencies).toBeUndefined();
  });

  it("stops retrying when an incompatible unmanaged override remains", async () => {
    const npmRoot = path.join(tempDir, "npm-unmanaged-override-cleanup");
    await fs.mkdir(npmRoot, { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          overrides: {
            "unmanaged-parent@1.0.0>child": "2.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    let cleanupAttempts = 0;
    const runCommand: typeof runCommandWithTimeout = vi.fn(async (argv, optionsOrTimeout) => {
      const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
      if (argv.includes("--package-lock-only")) {
        expect(cwd).toBeTruthy();
        await fs.writeFile(
          path.join(cwd as string, "package-lock.json"),
          `${JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }, null, 2)}\n`,
        );
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      cleanupAttempts += 1;
      return {
        code: 1,
        stdout: "",
        stderr:
          'npm error code EINVALIDTAGNAME\nnpm error Invalid tag name "1.0.0>child" of package "unmanaged-parent@1.0.0>child"',
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    });

    await expect(
      pruneManagedNpmPeerDependenciesAfterUninstall({
        npmRoot,
        packageName: "@openclaw/kitchen-sink",
        managedOverrides: { axios: "1.18.1" },
        runCommand,
      }),
    ).resolves.toContain(
      "Failed to prune managed peer dependencies after uninstalling @openclaw/kitchen-sink: npm error code EINVALIDTAGNAME",
    );
    expect(cleanupAttempts).toBe(2);
  });

  it("runs npm cleanup when the managed package directory is already absent", async () => {
    const stateDir = path.join(tempDir, "state");
    const npmRoot = path.join(stateDir, "npm");
    const pluginDir = path.join(npmRoot, "node_modules", "missing-plugin");
    const peerPluginDir = path.join(npmRoot, "node_modules", "peer-plugin");
    const peerLink = path.join(peerPluginDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(peerLink), { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "missing-plugin": "1.0.0",
            "peer-plugin": "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(peerPluginDir, "package.json"),
      `${JSON.stringify(
        {
          name: "peer-plugin",
          version: "1.0.0",
          peerDependencies: { openclaw: ">=2026.0.0" },
        },
        null,
        2,
      )}\n`,
    );

    const applied = await applyPluginUninstallDirectoryRemoval({
      target: pluginDir,
      cleanup: {
        kind: "npm",
        npmRoot,
        packageName: "missing-plugin",
      },
    });

    expect(applied).toEqual({ directoryRemoved: false, warnings: [] });
    expectNpmUninstallCommand({ packageName: "missing-plugin", npmRoot });
    await expect(fs.lstat(peerLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
  });

  it("removes stale npm install config when the managed npm root is already absent", async () => {
    const stateDir = path.join(tempDir, "state");
    const extensionsDir = path.join(stateDir, "extensions");
    const npmRoot = path.join(stateDir, "npm");
    const pluginDir = path.join(npmRoot, "node_modules", "missing-plugin");

    const result = await uninstallPlugin({
      config: createPluginConfig({
        entries: createSinglePluginEntries("missing-plugin"),
        installs: {
          "missing-plugin": createNpmInstallRecord("missing-plugin", pluginDir),
        },
      }),
      pluginId: "missing-plugin",
      deleteFiles: true,
      extensionsDir,
    });

    const successfulResult = expectSuccessfulUninstall(result);
    expect(successfulResult.config.plugins).toBeUndefined();
    expect(successfulResult.actions.entry).toBe(true);
    expect(successfulResult.actions.install).toBe(true);
    expect(successfulResult.actions.directory).toBe(false);
    expect(successfulResult.warnings).toStrictEqual([]);
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
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "demo-plugin": "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

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
    await expectPathAccessState(pluginDir, "missing");
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
    await expectPathAccessState(managedDir, "missing");
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
    await expectPathAccessState(installPath, "missing");
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
    await expectPathAccessState(installPath, "missing");
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
    await expectPathAccessState(installPath, "missing");
    await expectPathAccessState(installParent, "missing");
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
    await expectPathAccessState(installPath, "missing");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
