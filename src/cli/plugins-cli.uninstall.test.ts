import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Plugins CLI uninstall tests cover plugin removal selection and uninstall output.
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawPackageRef } from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  applyPluginUninstallDirectoryRemoval,
  buildPluginDiagnosticsReport,
  buildPluginSnapshotReport,
  loadConfig,
  planPluginUninstall,
  PromptInputClosedError,
  promptYesNo,
  refreshPluginRegistry,
  replaceConfigFile,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  setInstalledPluginIndexInstallRecords,
  writeConfigFile,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

const CLI_STATE_ROOT = "/tmp/openclaw-state";
const ALPHA_INSTALL_PATH = installedPluginRoot(CLI_STATE_ROOT, "alpha");
const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectRuntimeLogIncludes(fragment: string) {
  expect(runtimeLogs.join("\n")).toContain(fragment);
}

function expectLatestUninstallPlanParams(expected: {
  pluginId: string;
  deleteFiles: boolean;
  channelIds?: unknown;
}) {
  const params = planPluginUninstall.mock.calls[planPluginUninstall.mock.calls.length - 1]?.[0] as
    | { pluginId?: string; deleteFiles?: boolean; channelIds?: unknown }
    | undefined;
  if (params === undefined) {
    throw new Error("expected latest plugin uninstall plan params");
  }
  expect(params.pluginId).toBe(expected.pluginId);
  expect(params.deleteFiles).toBe(expected.deleteFiles);
  if ("channelIds" in expected) {
    expect(params.channelIds).toBe(expected.channelIds);
  }
}

describe("plugins cli uninstall", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
  });

  it("refuses plugin uninstalls in Nix mode before planning file removal", async () => {
    const previous = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
        "OPENCLAW_NIX_MODE=1",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previous;
      }
    }

    expect(planPluginUninstall).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemoval).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("shows uninstall dry-run preview without mutating config or acquiring write mode", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
        installs: {
          alpha: {
            source: "path",
            sourcePath: ALPHA_INSTALL_PATH,
            installPath: ALPHA_INSTALL_PATH,
          },
        },
        slots: {
          contextEngine: "alpha",
        },
      },
    } as OpenClawConfig);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: {} as OpenClawConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: true,
        directory: false,
      },
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--dry-run"]);

    expect(buildPluginSnapshotReport).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReport).not.toHaveBeenCalled();
    expect(planPluginUninstall).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expectRuntimeLogIncludes("Dry run, no changes made.");
    expectRuntimeLogIncludes("context engine slot");
  });

  it("uninstalls with --force and --keep-files without prompting", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: {
          alpha: {
            source: "path",
            sourcePath: ALPHA_INSTALL_PATH,
            installPath: ALPHA_INSTALL_PATH,
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        directory: false,
      },
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

    expect(promptYesNo).not.toHaveBeenCalled();
    expectLatestUninstallPlanParams({ pluginId: "alpha", deleteFiles: false });
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({});
    expect(writeConfigFile).toHaveBeenCalledWith({
      plugins: {
        entries: {},
      },
    });
    expect(replaceConfigFile).toHaveBeenCalledWith({
      baseHash: "mock",
      nextConfig: {
        plugins: {
          entries: {},
        },
      },
      writeOptions: expect.objectContaining({
        allowConfigSizeDrop: true,
        auditOrigin: "plugin-install",
        afterWrite: { mode: "restart", reason: "plugin source changed" },
        unsetPaths: [["plugins", "installs"]],
      }),
    });
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {
        plugins: {
          entries: {},
        },
      },
      installRecords: {},
      reason: "source-changed",
    });
  });

  it("warns but proceeds when a shared plugin has an uncertain Claw reference", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-claw-plugin-ref-");
    closeOpenClawStateDatabaseForTest();
    try {
      const installRecord = {
        source: "clawhub" as const,
        spec: "clawhub:@owner/audit@2.0.1",
        clawhubPackage: "@owner/audit",
        version: "2.0.1",
        installPath: ALPHA_INSTALL_PATH,
      };
      const baseConfig = {
        plugins: {
          entries: { alpha: { enabled: true } },
          installs: { alpha: installRecord },
        },
      } as OpenClawConfig;
      loadConfig.mockReturnValue(baseConfig);
      setInstalledPluginIndexInstallRecords({ alpha: installRecord });
      buildPluginSnapshotReport.mockReturnValue({
        plugins: [{ id: "alpha", name: "alpha" }],
        diagnostics: [],
      });
      planPluginUninstall.mockReturnValue({
        ok: true,
        config: { plugins: { entries: {}, installs: {} } } as OpenClawConfig,
        actions: {
          entry: true,
          install: true,
          allowlist: false,
          denylist: false,
          loadPath: false,
          memorySlot: false,
          contextEngineSlot: false,
          channelConfig: false,
          directory: false,
        },
        directoryRemoval: null,
      });
      persistClawPackageRef(
        {
          agent: { finalId: "audit-agent" },
          claw: { name: "@owner/audit-claw" },
        } as ClawAddPlan,
        {
          kind: "plugin",
          source: "clawhub",
          ref: "@owner/audit",
          version: "2.0.1",
          integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { status: "failed" },
      );

      await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

      expectRuntimeLogIncludes('Warning: plugin "alpha" is referenced by Claw: @owner/audit-claw.');
      expectRuntimeLogIncludes("Uninstalling it may break those Claws");
      expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({});
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("exits cleanly when confirmation input closes before an answer", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: {
          alpha: {
            source: "path",
            sourcePath: ALPHA_INSTALL_PATH,
            installPath: ALPHA_INSTALL_PATH,
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: { plugins: { entries: {}, installs: {} } } as OpenClawConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        directory: false,
      },
      directoryRemoval: null,
    });
    promptYesNo.mockRejectedValueOnce(new PromptInputClosedError());

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors).toContain(
      "Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.",
    );
    expect(writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemoval).not.toHaveBeenCalled();
  });

  it("restores install records when the config write rejects during uninstall", async () => {
    const installRecords = {
      alpha: {
        source: "path",
        sourcePath: ALPHA_INSTALL_PATH,
        installPath: ALPHA_INSTALL_PATH,
      },
    } as const;
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: installRecords,
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        directory: false,
      },
      directoryRemoval: null,
    });
    replaceConfigFile.mockRejectedValueOnce(new Error("config changed"));

    await expect(
      runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]),
    ).rejects.toThrow("config changed");

    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(1, {});
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(
      2,
      installRecords,
    );
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemoval).not.toHaveBeenCalled();
  });

  it("removes plugin files only after config and index commit succeeds", async () => {
    const installRecords = {
      alpha: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: ALPHA_INSTALL_PATH,
      },
    } as const;
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: installRecords,
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        directory: false,
      },
      directoryRemoval: { target: ALPHA_INSTALL_PATH },
    });
    applyPluginUninstallDirectoryRemoval.mockResolvedValue({
      directoryRemoved: true,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

    const configWriteOrder = writeConfigFile.mock.invocationCallOrder[0] ?? 0;
    const deleteOrder =
      applyPluginUninstallDirectoryRemoval.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const finalConfigWriteOrder =
      writeConfigFile.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER;
    const refreshOrder =
      refreshPluginRegistry.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(writeConfigFile).toHaveBeenCalledTimes(2);
    expect(applyPluginUninstallDirectoryRemoval).toHaveBeenCalledTimes(1);
    expect(refreshPluginRegistry).toHaveBeenCalledTimes(1);
    expect(deleteOrder).toBeGreaterThan(configWriteOrder);
    expect(finalConfigWriteOrder).toBeGreaterThan(deleteOrder);
    expect(refreshOrder).toBeGreaterThan(finalConfigWriteOrder);
    expect(applyPluginUninstallDirectoryRemoval).toHaveBeenCalledWith({
      target: ALPHA_INSTALL_PATH,
    });
  });

  it("keeps the install tracked and disabled when directory removal fails", async () => {
    const installPath = tempDirs.make("openclaw-plugin-uninstall-failure-");
    const installRecords = {
      alpha: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath,
      },
    } as const;
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: installRecords,
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: { plugins: { entries: {}, installs: {} } } as OpenClawConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        directory: false,
      },
      directoryRemoval: { target: installPath },
    });
    applyPluginUninstallDirectoryRemoval.mockResolvedValue({
      directoryRemoved: false,
      warnings: ["simulated removal failure"],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "remains disabled and tracked",
    );

    expect(writeConfigFile).toHaveBeenCalledWith({
      plugins: {
        entries: {
          alpha: { enabled: false },
        },
        installs: installRecords,
      },
    });
    expect(writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
  });

  it("cleans stale policy refs even when plugin is absent from the current registry", async () => {
    const baseConfig = {
      plugins: {
        allow: ["alpha", "beta"],
        deny: ["alpha"],
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        allow: ["beta"],
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: false,
        install: false,
        allowlist: true,
        denylist: true,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: false,
        directory: false,
      },
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

    expectLatestUninstallPlanParams({ pluginId: "alpha", deleteFiles: true });
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(runtimeLogs.at(-2)).toContain('Uninstalled plugin "alpha"');
  });

  it("uninstalls stale enabled entries when plugin is absent from the current registry", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {} as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
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
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

    expectLatestUninstallPlanParams({ pluginId: "alpha", deleteFiles: true });
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: nextConfig,
      installRecords: {},
      reason: "source-changed",
    });
    expect(runtimeErrors).not.toContain("Plugin not found: alpha");
    expect(runtimeLogs.at(-2)).toContain('Uninstalled plugin "alpha"');
  });

  it("removes installed channel config when plugin code is absent from the current registry", async () => {
    const installRecords = {
      alpha: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: ALPHA_INSTALL_PATH,
      },
    } as const;
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: installRecords,
      },
      channels: {
        alpha: {
          enabled: true,
        },
        discord: {
          enabled: true,
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      channels: {
        discord: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: true,
        directory: false,
      },
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

    expectLatestUninstallPlanParams({
      pluginId: "alpha",
      channelIds: undefined,
      deleteFiles: false,
    });
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({});
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expectRuntimeLogIncludes("channel config (channels.alpha)");
    expect(runtimeLogs.at(-2)).toContain('Uninstalled plugin "alpha"');
  });

  it("exits when uninstall target is not managed by plugin install records", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: false,
      error: "Plugin not found: alpha",
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain("is not managed by plugins config/install records");
    expect(planPluginUninstall).toHaveBeenCalledTimes(1);
  });
});
