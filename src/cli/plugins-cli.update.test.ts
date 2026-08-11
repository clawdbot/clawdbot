// Plugins CLI update tests cover plugin update command behavior and output.
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ClawHubTrustErrorCode } from "../infra/clawhub-install-trust.js";
import { resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub-error-codes.js";
import { VERSION } from "../version.js";
import {
  createTestInstalledPluginIndex,
  loadConfig,
  notifyGatewayPluginMetadataChangedMock,
  readConfigFileSnapshotForWrite,
  readPersistedInstalledPluginIndex,
  refreshPluginRegistry,
  replaceConfigFile,
  resetPluginsCliTestState,
  restorePersistedInstalledPluginIndexIfCurrent,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
  setHookInstallRecords,
  updateNpmInstalledHookPacks,
  updateNpmInstalledPlugins,
  writeConfigFile,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "./plugins-cli-test-helpers.js";
import { registerPluginsCli } from "./plugins-cli.js";

const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;
const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

function restoreTty(): void {
  if (ORIGINAL_STDIN_TTY) {
    Object.defineProperty(process.stdin, "isTTY", ORIGINAL_STDIN_TTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  if (ORIGINAL_STDOUT_TTY) {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_STDOUT_TTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

function createTrackedPluginConfig(params: {
  pluginId: string;
  spec: string;
  resolvedName?: string;
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "npm",
          spec: params.spec,
          installPath: `/tmp/${params.pluginId}`,
          ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
        },
      },
    },
  } as OpenClawConfig;
}

function expectRestartNoticeLogged() {
  expect(
    pluginsCliRuntimeLogs.some((message) =>
      message.includes("Restart the gateway to load plugins and hooks."),
    ),
  ).toBe(true);
}

function expectInstallRecordsWrittenWithLease(records: unknown, config: unknown) {
  expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledWith(
    records,
    expect.objectContaining({
      config,
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
}

function expectSingleCallParams(mockFn: ReturnType<typeof vi.fn>) {
  expect(mockFn).toHaveBeenCalledTimes(1);
  const params = mockFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (params === undefined) {
    throw new Error("expected call params");
  }
  return params;
}

function primeUpdateConfigSnapshot(params: {
  config: OpenClawConfig;
  configPath?: string;
  hash?: string;
  loadedConfig?: OpenClawConfig;
  parsed?: Record<string, unknown>;
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  valid?: boolean;
  includeFileHashesForWrite?: Record<string, string>;
  includeFileTargetsForWrite?: Record<string, string>;
}) {
  const configPath = params.configPath ?? path.join(process.cwd(), "openclaw.json5");
  const parsed = params.parsed ?? (params.config as Record<string, unknown>);
  const sourceConfig = params.sourceConfig ?? params.config;
  const runtimeConfig = params.runtimeConfig ?? params.config;
  const prepared = {
    snapshot: {
      path: configPath,
      exists: true,
      raw: JSON.stringify(parsed),
      parsed,
      resolved: sourceConfig,
      sourceConfig,
      runtimeConfig,
      valid: params.valid ?? true,
      config: runtimeConfig,
      hash: params.hash ?? "update-config",
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    writeOptions: {
      assertConfigPathForWrite: () => {},
      expectedConfigPath: configPath,
      ownedConfigPathForWrite: configPath,
      includeFileHashesForWrite: params.includeFileHashesForWrite,
      includeFileTargetsForWrite: params.includeFileTargetsForWrite,
    },
  };
  loadConfig.mockReturnValue(params.loadedConfig ?? params.config);
  readConfigFileSnapshotForWrite.mockResolvedValue(prepared);
  return prepared;
}

function primeBlockedUpdateConfig(section: "hooks" | "plugins", config: OpenClawConfig): void {
  const externalPath = path.join(
    path.parse(process.cwd()).root,
    "external-openclaw",
    `${section}.json5`,
  );
  primeUpdateConfigSnapshot({
    config,
    parsed: { [section]: { $include: externalPath } },
    includeFileTargetsForWrite: {
      [externalPath]: externalPath,
    },
  });
}

function primePluginUpdate(
  config: OpenClawConfig,
  outcomes: Awaited<ReturnType<typeof updateNpmInstalledPlugins>>["outcomes"] = [],
  changed = false,
): void {
  updateNpmInstalledPlugins.mockResolvedValue({ config, changed, outcomes });
}

function primeBravePluginRecordUpdate(config: OpenClawConfig) {
  const previousRecords = {
    brave: {
      source: "npm",
      spec: "@openclaw/brave-plugin@2026.6.11-beta.2",
      installPath: "/tmp/brave-beta",
      resolvedName: "@openclaw/brave-plugin",
      resolvedVersion: "2026.6.11-beta.2",
    },
  } as const;
  const nextRecords = {
    brave: {
      ...previousRecords.brave,
      spec: "@openclaw/brave-plugin@2026.6.11",
      installPath: "/tmp/brave-stable",
      resolvedVersion: "2026.6.11",
    },
  } as const;
  setInstalledPluginIndexInstallRecords(previousRecords);
  primePluginUpdate(
    {
      ...config,
      plugins: {
        ...config.plugins,
        installs: nextRecords,
      },
    } as OpenClawConfig,
    [{ pluginId: "brave", status: "updated", message: "Updated brave." }],
    true,
  );
  return { previousRecords, nextRecords };
}

async function expectSkippedClawHubPluginUpdate(params: {
  code: ClawHubTrustErrorCode;
  message: string;
  expectedLog: string;
  spec?: string;
}): Promise<void> {
  const config = {
    plugins: {
      installs: {
        demo: {
          source: "clawhub",
          spec: params.spec ?? "clawhub:@openclaw/plugin-demo",
          clawhubPackage: "@openclaw/plugin-demo",
        },
      },
    },
  } as OpenClawConfig;
  loadConfig.mockReturnValue(config);
  setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
  primePluginUpdate(config, [
    {
      pluginId: "demo",
      status: "skipped",
      code: params.code,
      message: params.message,
    },
  ]);
  updateNpmInstalledHookPacks.mockResolvedValue({ outcomes: [], changed: false, config });

  await expect(runPluginsCommand(["plugins", "update", "demo"])).rejects.toThrow("__exit__:1");

  expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).not.toHaveBeenCalled();
  expect(pluginsCliRuntimeLogs.at(-1)).toContain(params.expectedLog);
}

describe("plugins cli update", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    restoreTty();
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
  });

  it("shows the deprecated unsafe install flag in update help", () => {
    const program = new Command();
    registerPluginsCli(program);

    const pluginsCommand = program.commands.find((command) => command.name() === "plugins");
    const updateCommand = pluginsCommand?.commands.find((command) => command.name() === "update");
    const helpText = updateCommand?.helpInformation() ?? "";

    expect(helpText).toContain("--dangerously-force-unsafe-install");
    expect(helpText).toContain("Deprecated no-op");
    expect(helpText).toContain("security.installPolicy");
    expect(helpText).toContain("may still block");
  });

  it("refuses plugin updates in Nix mode before package-manager work", async () => {
    const previous = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow(
        "OPENCLAW_NIX_MODE=1",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previous;
      }
    }

    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("previews plugin updates in Nix mode without acquiring a lease or writing state", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    const config = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@acme/alpha@1.0.0",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config, [
      {
        pluginId: "alpha",
        status: "updated",
        message: "Would update alpha: 1.0.0 -> 1.1.0.",
      },
    ]);
    const lifecycleLease = await import("../plugins/plugin-lifecycle-lease.js");
    const acquireLease = vi.spyOn(lifecycleLease, "withPluginLifecycleLease");

    try {
      await runPluginsCommand(["plugins", "update", "alpha", "--dry-run"]);

      expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, pluginIds: ["alpha"] }),
      );
      expect(acquireLease).not.toHaveBeenCalled();
      expect(writeConfigFile).not.toHaveBeenCalled();
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).not.toHaveBeenCalled();
      expect(refreshPluginRegistry).not.toHaveBeenCalled();
      expect(pluginsCliRuntimeLogs).toContain("Would update alpha: 1.0.0 -> 1.1.0.");
    } finally {
      acquireLease.mockRestore();
    }
  });

  it.each([
    { id: "missing-plugin", args: [] },
    { id: "missing-plugin", args: ["--dry-run"] },
    { id: "constructor", args: [] },
    { id: "@acme/missing-plugin@beta", args: [] },
  ])("rejects untracked update target $id $args", async ({ id, args }) => {
    const config = {} as OpenClawConfig;
    primeUpdateConfigSnapshot({ config });
    primePluginUpdate(config, [
      { pluginId: id, status: "skipped", message: `No install record for "${id}".` },
    ]);

    await expect(runPluginsCommand(["plugins", "update", id, ...args])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(`No tracked plugin or hook pack found for "${id}".`);
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects an npm update target shared by multiple tracked plugins", async () => {
    const config = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@acme/shared",
            installPath: "/tmp/alpha",
            resolvedName: "@acme/shared",
          },
          beta: {
            source: "npm",
            spec: "@acme/shared",
            installPath: "/tmp/beta",
            resolvedName: "@acme/shared",
          },
        },
      },
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({ config });
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});

    await expect(runPluginsCommand(["plugins", "update", "@acme/shared@beta"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      'No tracked plugin or hook pack found for "@acme/shared@beta".',
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("updates tracked hook packs through plugins update", async () => {
    const cfg = {} as OpenClawConfig;
    const nextConfig = cfg;

    primeUpdateConfigSnapshot({ config: cfg });
    setHookInstallRecords({
      "demo-hooks": {
        source: "npm",
        spec: "@acme/demo-hooks@1.0.0",
        installPath: "/tmp/hooks/demo-hooks",
        resolvedName: "@acme/demo-hooks",
      },
    });
    primePluginUpdate(cfg);
    updateNpmInstalledHookPacks.mockResolvedValue({
      config: nextConfig,
      changed: true,
      outcomes: [
        {
          hookId: "demo-hooks",
          status: "updated",
          message: 'Updated hook pack "demo-hooks": 1.0.0 -> 1.1.0.',
        },
      ],
    });

    await runPluginsCommand(["plugins", "update", "demo-hooks"]);

    const hookUpdateParams = expectSingleCallParams(updateNpmInstalledHookPacks);
    expect(hookUpdateParams.config).toEqual({ ...cfg, plugins: { installs: {} } });
    expect(hookUpdateParams.hookIds).toEqual(["demo-hooks"]);
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig, baseHash: "update-config" }),
    );
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expectRestartNoticeLogged();
  });

  it("uses the mutation-start snapshot for updater input and hook selection", async () => {
    const loadedConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const snapshotConfig = {
      plugins: {
        entries: {
          alpha: { enabled: false },
        },
      },
    } as OpenClawConfig;
    const installRecords = {
      alpha: {
        source: "npm",
        spec: "@openclaw/alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    } as const;
    primeUpdateConfigSnapshot({
      config: snapshotConfig,
      loadedConfig,
      runtimeConfig: {
        ...snapshotConfig,
        messages: {
          ackReactionScope: "group-mentions",
        },
      },
    });
    setInstalledPluginIndexInstallRecords(installRecords);
    setHookInstallRecords({
      "new-hooks": {
        source: "npm",
        spec: "@acme/new-hooks@1.0.0",
        installPath: "/home/test/.openclaw/hooks/new-hooks",
      },
    });
    updateNpmInstalledPlugins.mockImplementation(async (params: { config: OpenClawConfig }) => ({
      config: params.config,
      changed: false,
      outcomes: [],
    }));
    updateNpmInstalledHookPacks.mockImplementation(async (params: { config: OpenClawConfig }) => ({
      config: params.config,
      changed: false,
      outcomes: [],
    }));

    await runPluginsCommand(["plugins", "update", "--all"]);

    const pluginUpdateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    const hookUpdateParams = expectSingleCallParams(updateNpmInstalledHookPacks);
    expect(pluginUpdateParams.config).toEqual({
      ...snapshotConfig,
      messages: {
        ackReactionScope: "group-mentions",
      },
      plugins: {
        ...snapshotConfig.plugins,
        installs: installRecords,
      },
    });
    expect(hookUpdateParams.hookIds).toEqual(["new-hooks"]);
  });

  it("uses persisted install records instead of retired config records", async () => {
    const cfg = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const persistedRecords = {
      alpha: {
        source: "npm",
        spec: "@openclaw/alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    } as const;
    primeUpdateConfigSnapshot({
      config: cfg,
      parsed: {
        plugins: {
          installs: {
            alpha: {
              source: "npm",
              spec: "${PLUGIN_SPEC}",
              installPath: "${PLUGIN_PATH}",
            },
          },
        },
      },
    });
    setInstalledPluginIndexInstallRecords(persistedRecords);
    primePluginUpdate({
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: persistedRecords,
      },
    } as OpenClawConfig);

    await runPluginsCommand(["plugins", "update", "alpha"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.config).toEqual({
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: persistedRecords,
      },
    });
  });

  it("rejects invalid config snapshots before updater side effects", async () => {
    const cfg = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@openclaw/alpha@1.0.0",
    });
    primeUpdateConfigSnapshot({
      config: cfg,
      valid: false,
    });
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});

    await expect(runPluginsCommand(["plugins", "update", "alpha"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toBe(
      "Cannot update plugins or hooks while the config is invalid.",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("allows index-only legacy id migration when an included plugins section has no references", async () => {
    const cfg = { plugins: {} } as OpenClawConfig;
    const pluginRecords = createTrackedPluginConfig({
      pluginId: "voice-call",
      spec: "@openclaw/voice-call@1.0.0",
    }).plugins?.installs;
    const nextConfig = {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: {
          "@openclaw/voice-call": {
            source: "npm",
            spec: "@openclaw/voice-call@1.1.0",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(pluginRecords ?? {});
    primePluginUpdate(
      nextConfig,
      [
        {
          pluginId: "@openclaw/voice-call",
          status: "updated",
          message: "Updated @openclaw/voice-call.",
        },
      ],
      true,
    );

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expectInstallRecordsWrittenWithLease(nextConfig.plugins?.installs, cfg);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("allows scoped non-npm updates beside include-owned plugin config", async () => {
    const pluginId = "@acme/demo";
    const cfg = {
      plugins: {
        entries: {
          [pluginId]: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const pluginRecords = {
      [pluginId]: {
        source: "git",
        spec: "https://github.com/acme/demo.git#v1.0.0",
        installPath: "/tmp/demo",
      },
    } as const;
    const nextConfig = {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: pluginRecords,
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(pluginRecords);
    primePluginUpdate(
      nextConfig,
      [{ pluginId, status: "updated", message: `Updated ${pluginId}.` }],
      true,
    );

    await runPluginsCommand(["plugins", "update", pluginId]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expectInstallRecordsWrittenWithLease(pluginRecords, cfg);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not rewrite source config for persisted install record-only updates", async () => {
    const cfg = {
      gateway: {
        mode: "local",
        port: 18889,
      },
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
      channels: {
        discord: {
          enabled: true,
        },
      },
      plugins: {
        entries: {
          brave: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const sourceCfg = structuredClone(cfg);
    delete sourceCfg.gateway;
    primeUpdateConfigSnapshot({
      config: cfg,
      parsed: sourceCfg as Record<string, unknown>,
      runtimeConfig: cfg,
      sourceConfig: sourceCfg,
    });
    const { nextRecords } = primeBravePluginRecordUpdate(cfg);

    await runPluginsCommand(["plugins", "update", "brave"]);

    expect(runtimeErrors).toEqual([]);
    expectInstallRecordsWrittenWithLease(nextRecords, sourceCfg);
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: sourceCfg,
      installRecords: nextRecords,
      reason: "source-changed",
    });
    expect(notifyGatewayPluginMetadataChangedMock).toHaveBeenCalledWith(cfg);
    expectRestartNoticeLogged();
  });

  it("commits a moved managed npm load path with its replacement record", async () => {
    const previousInstallPath = "/tmp/openclaw/npm/projects/brave-v1/node_modules/brave";
    const nextInstallPath = "/tmp/openclaw/npm/projects/brave-v2/node_modules/brave";
    const customPath = "/tmp/custom-plugin";
    const cfg = {
      plugins: {
        load: { paths: [previousInstallPath, customPath] },
      },
    } as OpenClawConfig;
    const previousRecords = {
      brave: {
        source: "npm" as const,
        spec: "@openclaw/brave-plugin@1.0.0",
        installPath: previousInstallPath,
      },
    };
    const nextRecords = {
      brave: {
        ...previousRecords.brave,
        spec: "@openclaw/brave-plugin@2.0.0",
        installPath: nextInstallPath,
      },
    };
    const nextConfig = {
      plugins: {
        load: { paths: [nextInstallPath, customPath] },
        installs: nextRecords,
      },
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({ config: cfg });
    setInstalledPluginIndexInstallRecords(previousRecords);
    primePluginUpdate(
      nextConfig,
      [{ pluginId: "brave", status: "updated", message: "Updated brave." }],
      true,
    );

    await runPluginsCommand(["plugins", "update", "brave"]);

    expectInstallRecordsWrittenWithLease(nextRecords, {
      plugins: {
        load: { paths: [nextInstallPath, customPath] },
      },
    });
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        plugins: {
          load: { paths: [nextInstallPath, customPath] },
        },
      },
      baseHash: "update-config",
      writeOptions: expect.objectContaining({
        afterWrite: { mode: "restart", reason: "plugin source changed" },
      }),
    });
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {
        plugins: {
          load: { paths: [nextInstallPath, customPath] },
        },
      },
      installRecords: nextRecords,
      reason: "source-changed",
    });
    expect(notifyGatewayPluginMetadataChangedMock).not.toHaveBeenCalled();
  });

  it("rolls back persisted install records when source config changes during a records-only update", async () => {
    const cfg = {
      gateway: {
        mode: "local",
        port: 18889,
      },
      plugins: {
        entries: {
          brave: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const changedCfg = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        port: 18890,
      },
    } as OpenClawConfig;
    const initialSnapshot = primeUpdateConfigSnapshot({ config: cfg });
    const changedSnapshot = {
      ...initialSnapshot,
      snapshot: {
        ...initialSnapshot.snapshot,
        raw: JSON.stringify(changedCfg),
        parsed: changedCfg as Record<string, unknown>,
        resolved: changedCfg,
        sourceConfig: changedCfg,
        runtimeConfig: changedCfg,
        config: changedCfg,
        hash: "changed-config",
      },
    };
    readConfigFileSnapshotForWrite
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(changedSnapshot);
    const { previousRecords, nextRecords } = primeBravePluginRecordUpdate(cfg);
    const previousPersistedIndex = createTestInstalledPluginIndex({
      policyHash: "previous-policy",
      installRecords: previousRecords,
    });
    readPersistedInstalledPluginIndex.mockResolvedValue(previousPersistedIndex);

    await expect(runPluginsCommand(["plugins", "update", "brave"])).rejects.toThrow(
      "config changed since last load",
    );

    expectInstallRecordsWrittenWithLease(nextRecords, cfg);
    expect(restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
      previousPersistedIndex,
      expect.any(Number),
      expect.objectContaining({
        filePath: expect.any(String),
        lease: expect.anything(),
      }),
    );
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(notifyGatewayPluginMetadataChangedMock).not.toHaveBeenCalled();
  });

  it("rolls back persisted install records when included config changes during a records-only update", async () => {
    const includePath = "/tmp/plugins.json5";
    const includeTarget = "/tmp/plugins.json5";
    const cfg = {
      plugins: {
        entries: {
          brave: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const initialSnapshot = primeUpdateConfigSnapshot({
      config: cfg,
      parsed: {
        plugins: {
          $include: includePath,
        },
      },
      includeFileHashesForWrite: {
        [includePath]: "include-start",
      },
      includeFileTargetsForWrite: {
        [includePath]: includeTarget,
      },
    });
    const changedSnapshot = {
      ...initialSnapshot,
      writeOptions: {
        ...initialSnapshot.writeOptions,
        includeFileHashesForWrite: {
          [includePath]: "include-changed",
        },
      },
    };
    readConfigFileSnapshotForWrite
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(changedSnapshot);
    const { previousRecords, nextRecords } = primeBravePluginRecordUpdate(cfg);
    const previousPersistedIndex = createTestInstalledPluginIndex({
      policyHash: "previous-policy",
      installRecords: previousRecords,
    });
    readPersistedInstalledPluginIndex.mockResolvedValue(previousPersistedIndex);

    await expect(runPluginsCommand(["plugins", "update", "brave"])).rejects.toThrow(
      "included config changed since last load",
    );

    expectInstallRecordsWrittenWithLease(nextRecords, cfg);
    expect(restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
      previousPersistedIndex,
      expect.any(Number),
      expect.objectContaining({
        filePath: expect.any(String),
        lease: expect.anything(),
      }),
    );
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
  });

  it("rolls back persisted install records when records-only update invalidates config", async () => {
    const cfg = {
      plugins: {
        entries: {
          brave: {
            enabled: true,
            config: {
              oldOption: true,
            },
          },
        },
      },
    } as OpenClawConfig;
    const initialSnapshot = primeUpdateConfigSnapshot({ config: cfg });
    const invalidSnapshot = {
      ...initialSnapshot,
      snapshot: {
        ...initialSnapshot.snapshot,
        valid: false,
        issues: [
          {
            path: "plugins.entries.brave.config.oldOption",
            message: "invalid config for plugin brave: must NOT have additional properties",
          },
        ],
      },
    };
    readConfigFileSnapshotForWrite
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(invalidSnapshot);
    const { previousRecords, nextRecords } = primeBravePluginRecordUpdate(cfg);
    const previousPersistedIndex = createTestInstalledPluginIndex({
      policyHash: "previous-policy",
      installRecords: previousRecords,
    });
    readPersistedInstalledPluginIndex.mockResolvedValue(previousPersistedIndex);

    await expect(runPluginsCommand(["plugins", "update", "brave"])).rejects.toThrow(
      "invalid config for plugin brave",
    );

    expectInstallRecordsWrittenWithLease(nextRecords, cfg);
    expect(restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
      previousPersistedIndex,
      expect.any(Number),
      expect.objectContaining({
        filePath: expect.any(String),
        lease: expect.anything(),
      }),
    );
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
  });

  it("blocks legacy plugin id migration before updater side effects", async () => {
    const cfg = {
      plugins: {
        entries: {
          "voice-call": { enabled: true },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      "voice-call": {
        source: "npm",
        spec: "@openclaw/voice-call",
        installPath: "/tmp/voice-call",
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "voice-call"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("blocks catalog-declared plugin id migration before updater side effects", async () => {
    const cfg = {
      plugins: {
        entries: {
          "fish-audio": { enabled: true },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      "fish-audio": {
        source: "npm",
        spec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
        resolvedName: "@openclaw/fish-audio-speech",
        resolvedSpec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
        installPath: "/tmp/fish-audio",
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "fish-audio"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("blocks managed npm load-path reconciliation before updater side effects", async () => {
    const installPath = "/tmp/openclaw/npm/projects/demo-v1/node_modules/demo";
    const cfg = {
      plugins: {
        load: { paths: [installPath] },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      demo: {
        source: "npm",
        spec: "@acme/demo@1.0.0",
        installPath,
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "demo"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "ClawHub",
      record: {
        source: "clawhub",
        spec: "clawhub:@openclaw/voice-call",
        clawhubPackage: "@openclaw/voice-call",
        installPath: "/tmp/voice-call",
      },
    },
    {
      label: "git",
      record: {
        source: "git",
        spec: "https://github.com/openclaw/voice-call.git",
        installPath: "/tmp/voice-call",
      },
    },
    {
      label: "marketplace",
      record: {
        source: "marketplace",
        marketplaceSource: "acme",
        marketplacePlugin: "voice-call",
        installPath: "/tmp/voice-call",
      },
    },
  ] as const)(
    "blocks possible $label id migration before updater side effects",
    async ({ record }) => {
      const cfg = {
        plugins: {
          entries: {
            "voice-call": { enabled: true },
          },
        },
      } as OpenClawConfig;
      primeBlockedUpdateConfig("plugins", cfg);
      setInstalledPluginIndexInstallRecords({
        "voice-call": record,
      });

      await expect(runPluginsCommand(["plugins", "update", "voice-call"])).rejects.toThrow(
        "__exit__:1",
      );

      expect(runtimeErrors.at(-1)).toContain(
        "Config plugins are stored in an external or unresolved top-level $include",
      );
      expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expect(writeConfigFile).not.toHaveBeenCalled();
    },
  );

  it("blocks possible legacy id migration when an included plugins section is unresolved", async () => {
    const externalPath = path.join(
      path.parse(process.cwd()).root,
      "external-openclaw",
      "plugins.json5",
    );
    const cfg = { plugins: {} } as OpenClawConfig;
    primeUpdateConfigSnapshot({
      config: cfg,
      parsed: { plugins: { $include: externalPath } },
      sourceConfig: { plugins: { $include: externalPath } } as unknown as OpenClawConfig,
      includeFileTargetsForWrite: {
        [externalPath]: externalPath,
      },
    });
    setInstalledPluginIndexInstallRecords({
      "voice-call": {
        source: "npm",
        spec: "@openclaw/voice-call",
        installPath: "/tmp/voice-call",
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "voice-call"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("ignores retired plugin records during hook-only ownership checks", async () => {
    const cfg = {
      plugins: {
        installs: {
          legacy: {
            source: "npm",
            spec: "@openclaw/legacy@1.0.0",
            installPath: "/tmp/legacy",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setHookInstallRecords({
      "demo-hooks": {
        source: "npm",
        spec: "@acme/demo-hooks@1.0.0",
        installPath: "/tmp/hooks/demo-hooks",
      },
    });

    await runPluginsCommand(["plugins", "update", "demo-hooks"]);

    expect(runtimeErrors).toEqual([]);
    const hookUpdateParams = expectSingleCallParams(updateNpmInstalledHookPacks);
    expect(hookUpdateParams.config).toEqual({
      ...cfg,
      plugins: { installs: {} },
    });
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("preserves skip behavior for plugin records whose source cannot be updated", async () => {
    const cfg = {
      plugins: {
        installs: {
          linked: {
            source: "path",
            sourcePath: "/tmp/linked",
            installPath: "/tmp/linked",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    primePluginUpdate(cfg, [
      { pluginId: "linked", status: "skipped", message: "Skipping linked." },
    ]);

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("preserves skip behavior for ClawHub records missing package metadata", async () => {
    const cfg = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      demo: {
        source: "clawhub",
        spec: "clawhub:demo",
        installPath: "/tmp/demo",
      },
    });
    primePluginUpdate(cfg, [
      {
        pluginId: "demo",
        status: "skipped",
        message: 'Skipping "demo" (missing ClawHub package metadata).',
      },
    ]);

    await runPluginsCommand(["plugins", "update", "demo"]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("exits when update is called without id and without --all", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await expect(runPluginsCommand(["plugins", "update"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("Provide a plugin or hook-pack id, or use --all.");
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it("reports no tracked plugins or hook packs when update --all has empty install records", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.at(-1)).toBe("No tracked plugins or hook packs to update.");
  });

  it("passes dangerous force unsafe install to plugin updates", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "openclaw-codex-app-server@beta",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand([
      "plugins",
      "update",
      "openclaw-codex-app-server",
      "--dangerously-force-unsafe-install",
    ]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.config).toEqual(config);
    expect(updateParams.pluginIds).toEqual(["openclaw-codex-app-server"]);
    expect(updateParams.dangerouslyForceUnsafeInstall).toBe(true);
    expect(
      pluginsCliRuntimeLogs.some((message) =>
        message.includes(
          "--dangerously-force-unsafe-install is deprecated and no longer affects plugin updates",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    {
      updateChannel: "beta" as const,
      registryLine: "beta",
      spec: "@openclaw/codex@2026.6.8-beta.1",
    },
    {
      updateChannel: "stable" as const,
      registryLine: "latest",
      spec: "@openclaw/codex@2026.5.28",
    },
  ])(
    "passes the $updateChannel channel to probe $registryLine for targeted exact pins",
    async ({ updateChannel, spec }) => {
      const config = createTrackedPluginConfig({
        pluginId: "codex",
        spec,
        resolvedName: "@openclaw/codex",
      });
      config.update = { channel: updateChannel };
      loadConfig.mockReturnValue(config);
      setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
      primePluginUpdate(config);

      await runPluginsCommand(["plugins", "update", "codex"]);

      const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
      expect(updateParams.pluginIds).toEqual(["codex"]);
      expect(updateParams.syncOfficialPluginInstalls).toBeUndefined();
      expect(updateParams.updateChannel).toBe(updateChannel);
      expect(updateParams.officialPluginUpdateChannel).toBe(
        resolveRegistryUpdateChannel({ configChannel: updateChannel, currentVersion: VERSION }),
      );
    },
  );

  it("passes the inferred core channel to a targeted update without enabling catalog sync", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex",
      resolvedName: "@openclaw/codex",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "codex"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.syncOfficialPluginInstalls).toBeUndefined();
    expect(updateParams.updateChannel).toBeUndefined();
    expect(updateParams.officialPluginUpdateChannel).toBe(
      resolveRegistryUpdateChannel({ currentVersion: VERSION }),
    );
  });

  it("syncs official catalog specs with beta channel context for update --all", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex@2026.6.8-beta.1",
      resolvedName: "@openclaw/codex",
    });
    config.update = { channel: "beta" };
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "--all"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.pluginIds).toEqual(["codex"]);
    expect(updateParams.syncOfficialPluginInstalls).toBe(true);
    expect(updateParams.officialPluginUpdateChannel).toBe("beta");
    expect(updateParams.updateChannel).toBeUndefined();
  });

  it("infers the official catalog channel from the installed core for update --all", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex",
      resolvedName: "@openclaw/codex",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "--all"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.officialPluginUpdateChannel).toBe(
      resolveRegistryUpdateChannel({ currentVersion: VERSION }),
    );
  });

  it("passes extended-stable channel and installed core version to update --all", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex",
      resolvedName: "@openclaw/codex",
    });
    config.update = { channel: "extended-stable" };
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        officialPluginUpdateChannel: "extended-stable",
        syncOfficialPluginInstalls: true,
        coreVersion: expect.any(String),
      }),
    );
  });

  it("passes ClawHub risk acknowledgement to plugin updates", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "openclaw-codex-app-server@beta",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand([
      "plugins",
      "update",
      "openclaw-codex-app-server",
      "--acknowledge-clawhub-risk",
    ]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        pluginIds: ["openclaw-codex-app-server"],
        acknowledgeClawHubRisk: true,
      }),
    );
  });

  it("does not pass an interactive ClawHub risk prompt to dry-run plugin updates", async () => {
    setTty(true);
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "clawhub:openclaw-codex-app-server",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    primePluginUpdate(config);

    await runPluginsCommand(["plugins", "update", "openclaw-codex-app-server", "--dry-run"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.dryRun).toBe(true);
    expect(updateParams.acknowledgeClawHubRisk).not.toBe(true);
    expect(updateParams.onClawHubRisk).toBeUndefined();
  });

  it("writes updated config when updater reports changes", async () => {
    const cfg = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.0.0",
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.1.0",
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...cfg,
      messages: {
        ackReactionScope: "group-mentions",
      },
    } as OpenClawConfig;
    const nextRuntimeConfig = {
      ...nextConfig,
      messages: runtimeConfig.messages,
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({
      config: cfg,
      runtimeConfig,
      includeFileHashesForWrite: {
        "/tmp/plugins.json5": "plugins-start-hash",
      },
    });
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    primePluginUpdate(
      nextRuntimeConfig,
      [{ pluginId: "alpha", status: "updated", message: "Updated alpha -> 1.1.0" }],
      true,
    );
    updateNpmInstalledHookPacks.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: nextRuntimeConfig,
    });

    await runPluginsCommand(["plugins", "update", "alpha"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.config).toEqual(runtimeConfig);
    expect(updateParams.pluginIds).toEqual(["alpha"]);
    expect(updateParams.dryRun).toBe(false);
    expectInstallRecordsWrittenWithLease(nextConfig.plugins?.installs, {});
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).toHaveBeenCalledWith({});
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {},
      baseHash: "update-config",
      writeOptions: expect.objectContaining({
        includeFileHashesForWrite: {
          "/tmp/plugins.json5": "plugins-start-hash",
        },
      }),
    });
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {},
      installRecords: nextConfig.plugins?.installs,
      reason: "source-changed",
    });
    expectRestartNoticeLogged();
  });

  it("exits non-zero when a plugin update reports an error after persisting successes", async () => {
    const cfg = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.0.0",
          },
          beta: {
            source: "npm",
            spec: "@openclaw/beta@1.0.0",
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.1.0",
          },
          beta: {
            source: "npm",
            spec: "@openclaw/beta@1.0.0",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    primePluginUpdate(
      nextConfig,
      [
        { pluginId: "alpha", status: "updated", message: "Updated alpha -> 1.1.0" },
        { pluginId: "beta", status: "error", message: "Failed to update beta: registry timeout" },
      ],
      true,
    );
    updateNpmInstalledHookPacks.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: nextConfig,
    });

    await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow("__exit__:1");

    expectInstallRecordsWrittenWithLease(nextConfig.plugins?.installs, {});
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {},
      installRecords: nextConfig.plugins?.installs,
      reason: "source-changed",
    });
    expect(pluginsCliRuntimeLogs).toContain("Failed to update beta: registry timeout");
  });

  it("exits non-zero when a ClawHub update is skipped for missing risk acknowledgement", async () => {
    await expectSkippedClawHubPluginUpdate({
      code: CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED,
      spec: "clawhub:@openclaw/plugin-demo@1.0.0",
      message:
        "Skipped demo ClawHub update: Update cancelled; rerun with --acknowledge-clawhub-risk to continue after reviewing the warning. Existing installed plugin left unchanged.",
      expectedLog: "--acknowledge-clawhub-risk",
    });
  });

  it("exits non-zero when a ClawHub update is skipped because the target release is blocked", async () => {
    await expectSkippedClawHubPluginUpdate({
      code: "clawhub_download_blocked",
      message:
        "Skipped demo ClawHub update: ClawHub blocked this release; update was not started. Existing installed plugin left unchanged.",
      expectedLog: "ClawHub blocked this release",
    });
  });

  it("exits non-zero when a ClawHub update is skipped because security data is unavailable", async () => {
    await expectSkippedClawHubPluginUpdate({
      code: "clawhub_security_unavailable",
      message:
        'Skipped demo ClawHub update: ClawHub security data for "@openclaw/plugin-demo@1.1.0" is unavailable, so OpenClaw left the existing installed plugin unchanged. Try again later or choose a different version.',
      expectedLog: "security data",
    });
  });

  it("exits non-zero when a hook pack update reports an error", async () => {
    const cfg = {} as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    setHookInstallRecords({
      "demo-hooks": {
        source: "npm",
        spec: "@acme/demo-hooks@1.0.0",
        installPath: "/tmp/hooks/demo-hooks",
        resolvedName: "@acme/demo-hooks",
      },
    });
    primePluginUpdate(cfg);
    updateNpmInstalledHookPacks.mockResolvedValue({
      config: cfg,
      changed: false,
      outcomes: [
        {
          hookId: "demo-hooks",
          status: "error",
          message: 'Failed to update hook pack "demo-hooks": registry timeout',
        },
      ],
    });

    await expect(runPluginsCommand(["plugins", "update", "demo-hooks"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs).toContain(
      'Failed to update hook pack "demo-hooks": registry timeout',
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
