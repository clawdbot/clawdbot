import fs from "node:fs/promises";
import path from "node:path";
import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Plugins CLI uninstall tests cover plugin removal selection and uninstall output.
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawPackageRef } from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  applyPluginUninstallDirectoryRemovalMock,
  buildPluginDiagnosticsReportMock,
  buildPluginSnapshotReportMock,
  createTestInstalledPluginIndex,
  parseClawHubPluginSpecMock,
  pluginCliConfigMock,
  planPluginUninstallMock,
  PromptInputClosedError,
  promptYesNoMock,
  readPersistedInstalledPluginIndexMock,
  refreshPluginRegistryMock,
  replaceConfigFileMock,
  resetPluginsCliTestState,
  restorePersistedInstalledPluginIndexIfCurrentMock,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";

const CLI_STATE_ROOT = "/tmp/openclaw-state";
let alphaInstallPath: string;
let readInstallRecords: (typeof import("../plugins/installed-plugin-index-record-reader.js"))["loadInstalledPluginIndexInstallRecordsSync"];
const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectRuntimeLogIncludes(fragment: string) {
  expect(pluginsCliRuntimeLogs.join("\n")).toContain(fragment);
}

function expectInstallRecordsWrittenWithLease(records: unknown, config: unknown) {
  expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledWith(
    records,
    expect.objectContaining({
      config,
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
}

describe("plugins cli uninstall", () => {
  beforeEach(async () => {
    resetPluginsCliTestState();
    ({ loadInstalledPluginIndexInstallRecordsSync: readInstallRecords } =
      await import("../plugins/installed-plugin-index-record-reader.js"));
    alphaInstallPath = installedPluginRoot(tempDirs.make("openclaw-cli-uninstall-owned-"), "alpha");
    await fs.mkdir(alphaInstallPath, { recursive: true });
    await fs.writeFile(path.join(alphaInstallPath, "keep.txt"), "owned plugin files");
    const actual =
      await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
    planPluginUninstallMock.mockImplementation((params) =>
      actual.planPluginUninstall(params as Parameters<typeof actual.planPluginUninstall>[0]),
    );
    applyPluginUninstallDirectoryRemovalMock.mockImplementation((removal) =>
      actual.applyPluginUninstallDirectoryRemoval(
        removal as Parameters<typeof actual.applyPluginUninstallDirectoryRemoval>[0],
      ),
    );
    configWriteMock.mockImplementation(async (config) => {
      pluginCliConfigMock.mockReturnValue(config as OpenClawConfig);
    });
    replaceConfigFileMock.mockImplementation(async (input) => {
      const params = input as Parameters<
        (typeof import("../config/config.js"))["replaceConfigFile"]
      >[0];
      params.writeOptions?.assertConfigPathForWrite?.();
      await configWriteMock(params.nextConfig);
    });
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

    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("shows uninstall dry-run preview without mutating config or acquiring write mode", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
        installs: {
          alpha: {
            source: "path",
            sourcePath: alphaInstallPath,
            installPath: alphaInstallPath,
          },
        },
        slots: {
          contextEngine: "alpha",
        },
      },
    } as OpenClawConfig);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    setInstalledPluginIndexInstallRecords({
      alpha: { source: "path", sourcePath: alphaInstallPath, installPath: alphaInstallPath },
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--dry-run"]);

    expect(buildPluginSnapshotReportMock).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();

    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expectRuntimeLogIncludes("Dry run, no changes made.");
    expectRuntimeLogIncludes("context engine slot");
  });

  it.each([
    { keepFilesFlag: "--keep-files", inheritedLease: false },
    { keepFilesFlag: "--keep-config", inheritedLease: false },
    { keepFilesFlag: "--keep-files", inheritedLease: true },
  ])(
    "uninstalls with --force and $keepFilesFlag without prompting (inherited lease=$inheritedLease)",
    async ({ keepFilesFlag, inheritedLease }) => {
      const baseConfig = {
        plugins: {
          entries: {
            alpha: { enabled: true },
          },
          installs: {
            alpha: {
              source: "path",
              sourcePath: alphaInstallPath,
              installPath: alphaInstallPath,
            },
          },
        },
      } as OpenClawConfig;

      pluginCliConfigMock.mockReturnValue(baseConfig);
      setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [{ id: "alpha", name: "alpha" }],
        diagnostics: [],
      });

      const uninstall = () =>
        runPluginsCommand(["plugins", "uninstall", "alpha", "--force", keepFilesFlag]);
      if (inheritedLease) {
        const { withPluginLifecycleLease } = await import("../plugins/plugin-lifecycle-lease.js");
        const databasePath = path.join(
          tempDirs.make("openclaw-cli-uninstall-parent-lease-"),
          "state.sqlite",
        );
        await withPluginLifecycleLease({ path: databasePath }, async (lease) => {
          await uninstall();
          lease.assertOwned();
          expect(readInstallRecords()).toEqual({});
          expect(pluginCliConfigMock().plugins?.entries?.alpha).toEqual({ enabled: false });
          expect(
            writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
          ).toHaveBeenCalledWith({}, expect.objectContaining({ lease }));
        });
      } else {
        await uninstall();
      }

      expect(promptYesNoMock).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(alphaInstallPath, "keep.txt"), "utf8")).toBe(
        "owned plugin files",
      );
      if (keepFilesFlag === "--keep-config") {
        expectRuntimeLogIncludes("--keep-config");
        expectRuntimeLogIncludes("deprecated");
      }

      expectInstallRecordsWrittenWithLease(
        {},
        {
          plugins: { entries: { alpha: { enabled: false } } },
        },
      );
      expect(configWriteMock).toHaveBeenCalledWith({
        plugins: {
          entries: { alpha: { enabled: false } },
        },
      });
      expect(replaceConfigFileMock).toHaveBeenCalledWith({
        baseHash: "mock",
        nextConfig: {
          plugins: {
            entries: { alpha: { enabled: false } },
          },
        },
        writeOptions: expect.objectContaining({
          allowConfigSizeDrop: true,
          auditOrigin: "plugin-install",
          afterWrite: { mode: "restart", reason: "plugin source changed" },
          unsetPaths: [["plugins", "installs"]],
        }),
      });
      expect(refreshPluginRegistryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            plugins: {
              entries: { alpha: { enabled: false } },
            },
          },
          installRecords: {},
          reason: "source-changed",
        }),
      );
    },
  );

  it("uninstalls the exact plugin id when an earlier plugin uses it as a display name", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          "unrelated-plugin": { enabled: true },
          calendar: { enabled: true },
        },
        installs: {
          "unrelated-plugin": { source: "npm", spec: "unrelated-plugin@1.0.0" },
          calendar: { source: "npm", spec: "calendar@1.0.0" },
        },
      },
    } as OpenClawConfig;

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        { id: "unrelated-plugin", name: "calendar" },
        { id: "calendar", name: "Real Calendar" },
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "uninstall", "calendar", "--force", "--keep-files"]);

    expectInstallRecordsWrittenWithLease(
      {
        "unrelated-plugin": { source: "npm", spec: "unrelated-plugin@1.0.0" },
      },
      {
        plugins: {
          entries: { "unrelated-plugin": { enabled: true }, calendar: { enabled: false } },
        },
      },
    );
  });

  it("rejects an ambiguous display name before planning or mutating installed plugins", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          "calendar-one": { enabled: true },
          "calendar-two": { enabled: true },
        },
        installs: {
          "calendar-one": { source: "npm", spec: "calendar-one@1.0.0" },
          "calendar-two": { source: "npm", spec: "calendar-two@1.0.0" },
        },
      },
    } as OpenClawConfig;

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        { id: "calendar-one", name: "calendar" },
        { id: "calendar-two", name: "calendar" },
      ],
      diagnostics: [],
    });

    await expect(
      runPluginsCommand(["plugins", "uninstall", "calendar", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain('Plugin uninstall target "calendar" is ambiguous');

    expect(promptYesNoMock).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it("warns for a versionless scoped ClawHub spec and proceeds", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-claw-plugin-ref-");
    closeOpenClawStateDatabaseForTest();
    try {
      const { parseClawHubPluginSpec } = await vi.importActual<
        typeof import("../infra/clawhub-spec.js")
      >("../infra/clawhub-spec.js");
      parseClawHubPluginSpecMock.mockImplementation(parseClawHubPluginSpec);
      const installRecord = {
        source: "clawhub" as const,
        spec: "clawhub:@owner/audit",
        version: "2.0.1",
        installPath: alphaInstallPath,
      };
      const baseConfig = {
        plugins: {
          entries: { alpha: { enabled: true } },
          installs: { alpha: installRecord },
        },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(baseConfig);
      setInstalledPluginIndexInstallRecords({ alpha: installRecord });
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [{ id: "alpha", name: "alpha" }],
        diagnostics: [],
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
      expectInstallRecordsWrittenWithLease(
        {},
        { plugins: { entries: { alpha: { enabled: false } } } },
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      closeOpenClawStateDatabaseForTest();
    }
  });

  it.each(["closed", "declined", "accepted after config edit"])(
    "handles confirmation that is %s without stale mutations",
    async (confirmation) => {
      const baseConfig = {
        plugins: {
          entries: {
            alpha: { enabled: true },
          },
          installs: {
            alpha: {
              source: "path",
              sourcePath: alphaInstallPath,
              installPath: alphaInstallPath,
            },
          },
        },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(baseConfig);
      setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [{ id: "alpha", name: "alpha" }],
        diagnostics: [],
      });

      if (confirmation === "closed") {
        promptYesNoMock.mockRejectedValueOnce(new PromptInputClosedError());
        await expect(runPluginsCommand(["plugins", "uninstall", "alpha"])).rejects.toThrow(
          "__exit__:1",
        );
        expect(runtimeErrors).toContain(
          "Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.",
        );
      } else if (confirmation === "declined") {
        promptYesNoMock.mockResolvedValueOnce(false);
        await runPluginsCommand(["plugins", "uninstall", "alpha"]);
        expectRuntimeLogIncludes("Cancelled.");
      } else {
        promptYesNoMock.mockImplementationOnce(async () => {
          expect(configWriteMock).not.toHaveBeenCalled();
          expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
          pluginCliConfigMock.mockReturnValue({ ...baseConfig, logging: { level: "debug" } });
          return true;
        });
        await runPluginsCommand(["plugins", "uninstall", "alpha"]);
        expect(pluginCliConfigMock().logging).toEqual({ level: "debug" });
        expect(readInstallRecords()).toEqual({});
        expect(promptYesNoMock).toHaveBeenCalledOnce();
        return;
      }
      expect(readInstallRecords()).toEqual(baseConfig.plugins?.installs);
      expect(await fs.readFile(path.join(alphaInstallPath, "keep.txt"), "utf8")).toBe(
        "owned plugin files",
      );
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
      expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
    },
  );

  it("restores install records when the config write rejects during uninstall", async () => {
    const installRecords = {
      alpha: {
        source: "path",
        sourcePath: alphaInstallPath,
        installPath: alphaInstallPath,
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
    const previousPersistedIndex = createTestInstalledPluginIndex({
      policyHash: "previous-policy",
      installRecords,
    });

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    readPersistedInstalledPluginIndexMock.mockResolvedValue(previousPersistedIndex);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });

    replaceConfigFileMock.mockRejectedValueOnce(new Error("config changed"));

    await expect(
      runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]),
    ).rejects.toThrow("config changed");

    expectInstallRecordsWrittenWithLease(
      {},
      { plugins: { entries: { alpha: { enabled: false } } } },
    );
    expect(restorePersistedInstalledPluginIndexIfCurrentMock).toHaveBeenCalledWith(
      previousPersistedIndex,
      expect.any(Number),
      expect.objectContaining({
        filePath: expect.any(String),
        lease: expect.anything(),
      }),
    );
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
  });

  it("disables and retains tracking before file removal, then commits and refreshes", async () => {
    const installRecords = {
      alpha: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: alphaInstallPath,
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

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });

    const actual =
      await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
    let observedRemoval = false;
    applyPluginUninstallDirectoryRemovalMock.mockImplementation(async (removal) => {
      expect(pluginCliConfigMock().plugins?.entries?.alpha).toEqual({ enabled: false });
      expect(readInstallRecords()).toEqual(installRecords);
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(alphaInstallPath, "keep.txt"), "utf8")).toBe(
        "owned plugin files",
      );
      observedRemoval = true;
      return actual.applyPluginUninstallDirectoryRemoval(
        removal as Parameters<typeof actual.applyPluginUninstallDirectoryRemoval>[0],
      );
    });
    refreshPluginRegistryMock.mockImplementation(async () => {
      expect(readInstallRecords()).toEqual({});
      expect(pluginCliConfigMock().plugins?.entries?.alpha).toEqual({ enabled: false });
      await expect(fs.stat(alphaInstallPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

    expect(observedRemoval).toBe(true);
    expect(readInstallRecords()).toEqual({});
    expect(refreshPluginRegistryMock).toHaveBeenCalledOnce();
    await expect(fs.stat(alphaInstallPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the install tracked and disabled when directory removal fails", async () => {
    const installPath = alphaInstallPath;
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
    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });

    applyPluginUninstallDirectoryRemovalMock.mockResolvedValue({
      directoryRemoved: false,
      warnings: ["simulated removal failure"],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "remains disabled and tracked",
    );

    expect(configWriteMock).toHaveBeenCalledWith({
      plugins: {
        entries: {
          alpha: { enabled: false },
        },
        installs: installRecords,
      },
    });
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it.each(["disable", "delete", "final commit"])(
    "rechecks persistent authority before %s",
    async (stopAt) => {
      const records = {
        alpha: { source: "npm" as const, spec: "alpha@1.0.0", installPath: alphaInstallPath },
      };
      const config: OpenClawConfig = { plugins: { entries: { alpha: { enabled: true } } } };
      pluginCliConfigMock.mockReturnValue(config);
      setInstalledPluginIndexInstallRecords(records);
      readPersistedInstalledPluginIndexMock.mockResolvedValue(
        createTestInstalledPluginIndex({
          policyHash: "before-uninstall",
          installRecords: records,
        }),
      );
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [{ id: "alpha", name: "alpha" }],
        diagnostics: [],
      });
      const failure = new Error("persistent authority closed");
      let removed = false;
      const actual =
        await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
      applyPluginUninstallDirectoryRemovalMock.mockImplementation(async (removal) => {
        const result = await actual.applyPluginUninstallDirectoryRemoval(
          removal as Parameters<typeof actual.applyPluginUninstallDirectoryRemoval>[0],
        );
        removed = result.directoryRemoved;
        return result;
      });
      const { runPluginUninstallCommand } = await import("./plugins-uninstall-command.js");
      await expect(
        runPluginUninstallCommand("alpha", {
          force: true,
          beforePersistentApply: () => {
            if (
              stopAt === "disable" ||
              (stopAt === "delete" &&
                pluginCliConfigMock().plugins?.entries?.alpha?.enabled === false) ||
              (stopAt === "final commit" && removed)
            ) {
              throw failure;
            }
          },
        }),
      ).rejects.toBe(failure);

      expect(readInstallRecords()).toEqual(records);
      expect(pluginCliConfigMock().plugins?.entries?.alpha).toEqual({
        enabled: stopAt === "disable",
      });
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
      if (stopAt === "final commit") {
        expect(removed).toBe(true);
        await expect(fs.stat(alphaInstallPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(removed).toBe(false);
        expect(await fs.readFile(path.join(alphaInstallPath, "keep.txt"), "utf8")).toBe(
          "owned plugin files",
        );
      }
    },
  );

  it.each([false, true])(
    "removes owned aliases before deleting files and preserves later edits (retry=%s)",
    async (retry) => {
      const root = await fs.realpath(tempDirs.make("openclaw-cli-uninstall-alias-"));
      const sourcePath = path.join(root, "source");
      const installPath = path.join(root, "extensions", "alpha");
      const aliasPath = path.join(root, "alias");
      const unrelatedPath = path.join(root, "unrelated");
      const addedPath = path.join(root, "added");
      await Promise.all(
        [sourcePath, installPath, unrelatedPath, addedPath].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      );
      await fs.symlink(installPath, aliasPath, "dir");
      const installRecords = {
        alpha: { source: "path" as const, sourcePath, installPath },
      };
      let currentConfig: OpenClawConfig = {
        plugins: {
          entries: { alpha: { enabled: true } },
          load: { paths: [aliasPath, unrelatedPath] },
        },
      };
      pluginCliConfigMock.mockImplementation(() => currentConfig);
      configWriteMock.mockImplementation(async (config) => {
        currentConfig = config as OpenClawConfig;
      });
      setInstalledPluginIndexInstallRecords(installRecords);
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [
          {
            id: "alpha",
            name: "alpha",
            source: path.join(installPath, "index.js"),
            channelIds: [],
          },
        ],
        diagnostics: [],
      });
      const actual =
        await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
      let failRemoval = retry;
      applyPluginUninstallDirectoryRemovalMock.mockImplementation(async (removal) => {
        expect(currentConfig.plugins?.load?.paths).toEqual([unrelatedPath]);
        if (failRemoval) {
          failRemoval = false;
          return { directoryRemoved: false, warnings: ["simulated removal failure"] };
        }
        const result = await actual.applyPluginUninstallDirectoryRemoval(
          removal as Parameters<typeof actual.applyPluginUninstallDirectoryRemoval>[0],
        );
        currentConfig = {
          ...currentConfig,
          logging: { level: "debug" },
          plugins: { ...currentConfig.plugins, load: { paths: [unrelatedPath, addedPath] } },
        };
        return result;
      });
      if (retry) {
        await expect(
          runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]),
        ).rejects.toThrow("remains disabled and tracked");
        expect(currentConfig.plugins?.entries?.alpha).toEqual({ enabled: false });
        expect(
          writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
        ).not.toHaveBeenCalled();
        expect((await fs.stat(installPath)).isDirectory()).toBe(true);
      }

      await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

      expect(currentConfig.plugins?.load?.paths).toEqual([unrelatedPath, addedPath]);
      expect(currentConfig.logging).toEqual({ level: "debug" });
      expect(currentConfig.plugins?.entries?.alpha).toEqual({ enabled: false });
      expect((await fs.stat(sourcePath)).isDirectory()).toBe(true);
      await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
      expectInstallRecordsWrittenWithLease({}, currentConfig);
      if (!retry) {
        expectRuntimeLogIncludes("Removed: plugin settings, install record, load path, directory");
      }
    },
  );

  it("rejects stale child-keyed records that claim one package path", async () => {
    const sharedPath = "/tmp/openclaw-ambiguous-uninstall-pack";
    const installRecords = {
      "pack/one": {
        source: "npm" as const,
        spec: "@acme/pack",
        installPath: sharedPath,
      },
      "pack/two": {
        source: "npm" as const,
        spec: "@acme/pack",
        installPath: sharedPath,
      },
    };
    const config = {} as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "pack/one", name: "pack/one" }],
      diagnostics: [],
    });

    await expect(
      runPluginsCommand(["plugins", "uninstall", "pack/one", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain('Plugin "pack/one"');

    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("fails closed for stale policy refs without authoritative installed children", async () => {
    const baseConfig = {
      plugins: {
        allow: ["alpha", "beta"],
        deny: ["alpha"],
      },
    } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(baseConfig);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("fails closed for stale enabled entries without authoritative installed children", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(baseConfig);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a disabled channel plugin",
      status: "disabled",
      channelIds: ["custom-channel", "custom-channel-backup"],
    },
    { label: "a loaded channel plugin", status: "loaded", channelIds: ["custom-channel"] },
    { label: "a disabled non-channel plugin", status: "disabled", channelIds: [] },
  ])("preserves manifest channel ownership for $label", async ({ status, channelIds }) => {
    const pluginId = "custom-plugin";
    const installRecords = {
      [pluginId]: {
        source: "npm",
        spec: "@acme/custom-plugin@1.0.0",
        installPath: installedPluginRoot(CLI_STATE_ROOT, pluginId),
      },
    } as const;
    const channels = {
      [pluginId]: { enabled: true },
      "custom-channel": { enabled: true },
      "custom-channel-backup": { enabled: true },
      discord: { enabled: true },
    };
    const baseConfig = {
      plugins: {
        entries: {
          [pluginId]: { enabled: status === "loaded" },
        },
        installs: installRecords,
      },
      channels,
    } as OpenClawConfig;

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        { id: pluginId, name: pluginId, status, channelIds },
        {
          id: "shared-channel-owner",
          name: "shared-channel-owner",
          status: "loaded",
          channelIds: [pluginId],
        },
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "uninstall", pluginId, "--force", "--keep-files"]);

    expectInstallRecordsWrittenWithLease(
      {},
      expect.objectContaining({
        channels: Object.fromEntries(
          Object.entries(channels).filter(([channelId]) => !channelIds.includes(channelId)),
        ),
      }),
    );
    expect(configWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: Object.fromEntries(
          Object.entries(channels).filter(([channelId]) => !channelIds.includes(channelId)),
        ),
      }),
    );
    for (const channelId of channelIds) {
      expectRuntimeLogIncludes(`channel config (channels.${channelId})`);
    }
  });

  it.each([false, true])(
    "preserves another channel owner during orphan uninstall: %s",
    async (claimed) => {
      const pluginId = "orphan-channel-plugin";
      const installRecords = {
        [pluginId]: {
          source: "path",
          sourcePath: "/tmp/missing-orphan-channel-source",
          installPath: "/tmp/missing-orphan-channel-install",
        },
      } as const;
      const baseConfig = {
        channels: {
          [pluginId]: { enabled: true },
          discord: { enabled: true },
        },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(baseConfig);
      setInstalledPluginIndexInstallRecords(installRecords);
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [],
        diagnostics: [],
      });
      const installedIndexModule = await import("../plugins/installed-plugin-index.js");
      const indexSpy = vi.spyOn(installedIndexModule, "loadInstalledPluginIndex").mockReturnValue(
        createTestInstalledPluginIndex({
          policyHash: "orphan-channel",
          installRecords,
          plugins: claimed
            ? [
                {
                  pluginId: "bridge",
                  rootDir: "/tmp/bridge",
                  manifestPath: "/tmp/bridge/openclaw.plugin.json",
                  manifestHash: "bridge",
                  origin: "global",
                  enabled: true,
                  startup: { sidecar: false, memory: false, agentHarnesses: [] },
                  packageChannel: { id: pluginId },
                  compat: [],
                },
              ]
            : [],
        }),
      );
      try {
        await runPluginsCommand(["plugins", "uninstall", pluginId, "--force", "--keep-files"]);

        expectInstallRecordsWrittenWithLease(
          {},
          {
            channels: {
              ...(claimed ? { [pluginId]: { enabled: true } } : {}),
              discord: { enabled: true },
            },
            plugins: {
              entries: {
                [pluginId]: { enabled: false },
              },
            },
          },
        );
      } finally {
        indexSpy.mockRestore();
      }
    },
  );

  it.each(["pack", "pack/one"])(
    "cleans declared singleton channels through %s",
    async (requestedId) => {
      const installPath = "/tmp/singleton-pack";
      const installRecords = {
        pack: { source: "path", sourcePath: installPath, installPath },
      } as const;
      pluginCliConfigMock.mockReturnValue({
        channels: { chat: { enabled: true }, "pack/one": { enabled: true } },
      } as OpenClawConfig);
      setInstalledPluginIndexInstallRecords(installRecords);
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [{ id: "pack/one", name: "One", status: "loaded", channelIds: ["chat"] }],
        diagnostics: [],
      });
      const installedIndexModule = await import("../plugins/installed-plugin-index.js");
      const indexSpy = vi.spyOn(installedIndexModule, "loadInstalledPluginIndex").mockReturnValue(
        createTestInstalledPluginIndex({
          policyHash: "singleton",
          installRecords,
          plugins: [
            recordInstalledPluginIndexInstallOwner(
              {
                pluginId: "pack/one",
                rootDir: installPath,
                manifestPath: `${installPath}/openclaw.plugin.json`,
                manifestHash: "one",
                origin: "global" as const,
                enabled: true,
                startup: { sidecar: false, memory: false, agentHarnesses: [] },
                compat: [],
              },
              "pack",
            ),
          ],
        }),
      );
      try {
        await runPluginsCommand(["plugins", "uninstall", requestedId, "--force", "--keep-files"]);
        expectInstallRecordsWrittenWithLease(
          {},
          {
            channels: { "pack/one": { enabled: true } },
            plugins: { entries: { "pack/one": { enabled: false } } },
          },
        );
      } finally {
        indexSpy.mockRestore();
      }
    },
  );

  it("exits when uninstall target is not managed by plugin install records", async () => {
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain("is not associated with a tracked package install");
  });
});
