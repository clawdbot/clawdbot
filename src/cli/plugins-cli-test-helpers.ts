import { Command } from "commander";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { createEmptyUninstallActions } from "../plugins/uninstall.js";
import type { CliMockOutputRuntime } from "./test-runtime-capture.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type LoadConfigFn = (typeof import("../config/config.js"))["loadConfig"];
type ParseClawHubPluginSpecFn = (typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"];
type InstallPluginFromMarketplaceFn =
  (typeof import("../plugins/marketplace.js"))["installPluginFromMarketplace"];
type InstallPluginFromGitSpecFn =
  (typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"];
type ParseGitPluginSpecFn = (typeof import("../plugins/git-install.js"))["parseGitPluginSpec"];
type ListMarketplacePluginsFn =
  (typeof import("../plugins/marketplace.js"))["listMarketplacePlugins"];
type ResolveMarketplaceInstallShortcutFn =
  (typeof import("../plugins/marketplace.js"))["resolveMarketplaceInstallShortcut"];
type PluginInstallRecordMap = Record<string, PluginInstallRecord>;

let mockInstalledPluginIndexInstallRecords: PluginInstallRecordMap = {};

function clonePluginInstallRecords(records: PluginInstallRecordMap): PluginInstallRecordMap {
  return structuredClone(records);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper preserves mock call and result types.
function invokeMock<TArgs extends unknown[], TResult>(mock: unknown, ...args: TArgs): TResult {
  return (mock as (...args: TArgs) => TResult)(...args);
}

export const loadConfig: Mock<LoadConfigFn> = vi.fn<LoadConfigFn>(() => ({}) as OpenClawConfig);
export const readConfigFileSnapshot: AsyncUnknownMock = vi.fn();
export const writeConfigFile: AsyncUnknownMock = vi.fn(async () => undefined);
export const replaceConfigFile: AsyncUnknownMock = vi.fn(
  async (params: { nextConfig: OpenClawConfig }) => await writeConfigFile(params.nextConfig),
) as AsyncUnknownMock;
const resolveStateDir: Mock<() => string> = vi.fn(() => "/tmp/openclaw-state");
export const installPluginFromMarketplace: Mock<InstallPluginFromMarketplaceFn> = vi.fn();
export const installPluginFromGitSpec: Mock<InstallPluginFromGitSpecFn> = vi.fn();
const parseGitPluginSpec: Mock<ParseGitPluginSpecFn> = vi.fn();
const listMarketplacePlugins: Mock<ListMarketplacePluginsFn> = vi.fn();
const resolveMarketplaceInstallShortcut: Mock<ResolveMarketplaceInstallShortcutFn> = vi.fn();
export const enablePluginInConfig: UnknownMock = vi.fn();
export const recordPluginInstall: UnknownMock = vi.fn();
const loadInstalledPluginIndexInstallRecords: AsyncUnknownMock = vi.fn(async () =>
  clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords),
);
export const writePersistedInstalledPluginIndexInstallRecords: AsyncUnknownMock = vi.fn(
  async (records: unknown) => {
    mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(
      (records ?? {}) as PluginInstallRecordMap,
    );
  },
);
export const loadPluginManifestRegistry: UnknownMock = vi.fn();
export const buildPluginSnapshotReport: UnknownMock = vi.fn();
export const buildPluginRegistrySnapshotReport: UnknownMock = vi.fn();
export const buildPluginInspectReport: UnknownMock = vi.fn();
const buildAllPluginInspectReports: UnknownMock = vi.fn();
export const buildPluginDiagnosticsReport: UnknownMock = vi.fn();
const buildPluginCompatibilityNotices: UnknownMock = vi.fn();
export const inspectPluginRegistry: AsyncUnknownMock = vi.fn();
export const refreshPluginRegistry: AsyncUnknownMock = vi.fn();
export const applyExclusiveSlotSelection: UnknownMock = vi.fn();
export const planPluginUninstall: UnknownMock = vi.fn();
export const applyPluginUninstallDirectoryRemoval: AsyncUnknownMock = vi.fn();
const uninstallPlugin: AsyncUnknownMock = vi.fn();
export const updateNpmInstalledPlugins: AsyncUnknownMock = vi.fn();
export const updateNpmInstalledHookPacks: AsyncUnknownMock = vi.fn();
export const promptYesNo: AsyncUnknownMock = vi.fn();
export const installPluginFromNpmSpec: AsyncUnknownMock = vi.fn();
export const installPluginFromPath: AsyncUnknownMock = vi.fn();
export const installPluginFromClawHub: AsyncUnknownMock = vi.fn();
export const parseClawHubPluginSpec: Mock<ParseClawHubPluginSpecFn> = vi.fn();
export const installHooksFromNpmSpec: AsyncUnknownMock = vi.fn();
export const installHooksFromPath: AsyncUnknownMock = vi.fn();
export const recordHookInstall: UnknownMock = vi.fn();

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } = vi.hoisted(() => {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const normalizeStdout = (value: string) => (value.endsWith("\n") ? value.slice(0, -1) : value);
  const stringifyJson = (value: unknown, space = 2) =>
    JSON.stringify(value, null, space > 0 ? space : undefined);
  const defaultRuntime = {
    log: vi.fn((...args: unknown[]) => {
      runtimeLogs.push(stringifyArgs(args));
    }),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(normalizeStdout(value));
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(stringifyJson(value, space));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  } as CliMockOutputRuntime;
  return {
    defaultRuntime,
    runtimeLogs,
    runtimeErrors,
    resetRuntimeCapture: () => {
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;
    },
  };
});

export { runtimeErrors, runtimeLogs };

export function setInstalledPluginIndexInstallRecords(records: PluginInstallRecordMap): void {
  mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
}

function restoreRuntimeCaptureMocks() {
  defaultRuntime.log.mockReset();
  defaultRuntime.log.mockImplementation((...args: unknown[]) => {
    runtimeLogs.push(args.map((value) => String(value)).join(" "));
  });

  defaultRuntime.error.mockReset();
  defaultRuntime.error.mockImplementation((...args: unknown[]) => {
    runtimeErrors.push(args.map((value) => String(value)).join(" "));
  });

  defaultRuntime.writeStdout.mockReset();
  defaultRuntime.writeStdout.mockImplementation((value: string) => {
    defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
  });

  defaultRuntime.writeJson.mockReset();
  defaultRuntime.writeJson.mockImplementation((value: unknown, space = 2) => {
    defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
  });

  defaultRuntime.exit.mockReset();
  defaultRuntime.exit.mockImplementation((code: number) => {
    throw new Error(`__exit__:${code}`);
  });
}

vi.mock("../runtime.js", () => ({
  defaultRuntime,
  writeRuntimeJson: (runtime: CliMockOutputRuntime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: ((
    ...args: Parameters<(typeof import("../config/config.js"))["readConfigFileSnapshot"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../config/config.js"))["readConfigFileSnapshot"]>,
      ReturnType<(typeof import("../config/config.js"))["readConfigFileSnapshot"]>
    >(
      readConfigFileSnapshot,
      ...args,
    )) as (typeof import("../config/config.js"))["readConfigFileSnapshot"],
  writeConfigFile: ((config: OpenClawConfig) =>
    invokeMock<
      [OpenClawConfig],
      ReturnType<(typeof import("../config/config.js"))["writeConfigFile"]>
    >(writeConfigFile, config)) as (typeof import("../config/config.js"))["writeConfigFile"],
  replaceConfigFile: ((
    params: Parameters<(typeof import("../config/config.js"))["replaceConfigFile"]>[0],
  ) =>
    invokeMock<
      [Parameters<(typeof import("../config/config.js"))["replaceConfigFile"]>[0]],
      ReturnType<(typeof import("../config/config.js"))["replaceConfigFile"]>
    >(replaceConfigFile, params)) as (typeof import("../config/config.js"))["replaceConfigFile"],
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => resolveStateDir(),
}));

vi.mock("../plugins/marketplace.js", () => ({
  installPluginFromMarketplace: ((...args: Parameters<InstallPluginFromMarketplaceFn>) =>
    installPluginFromMarketplace(...args)) as InstallPluginFromMarketplaceFn,
  listMarketplacePlugins: ((...args: Parameters<ListMarketplacePluginsFn>) =>
    listMarketplacePlugins(...args)) as ListMarketplacePluginsFn,
  resolveMarketplaceInstallShortcut: ((...args: Parameters<ResolveMarketplaceInstallShortcutFn>) =>
    resolveMarketplaceInstallShortcut(...args)) as ResolveMarketplaceInstallShortcutFn,
}));

vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: ((cfg: OpenClawConfig, pluginId: string) =>
    invokeMock<[OpenClawConfig, string], unknown>(
      enablePluginInConfig,
      cfg,
      pluginId,
    )) as (typeof import("../plugins/enable.js"))["enablePluginInConfig"],
}));

vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall: ((
    ...args: Parameters<(typeof import("../plugins/installs.js"))["recordPluginInstall"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/installs.js"))["recordPluginInstall"]>,
      ReturnType<(typeof import("../plugins/installs.js"))["recordPluginInstall"]>
    >(
      recordPluginInstall,
      ...args,
    )) as (typeof import("../plugins/installs.js"))["recordPluginInstall"],
}));

vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords: ((...args: unknown[]) =>
      invokeMock<unknown[], unknown>(loadInstalledPluginIndexInstallRecords, ...args)) as (
      ...args: unknown[]
    ) => unknown,
    writePersistedInstalledPluginIndexInstallRecords: ((...args: unknown[]) =>
      invokeMock<unknown[], unknown>(
        writePersistedInstalledPluginIndexInstallRecords,
        ...args,
      )) as (...args: unknown[]) => unknown,
    recordPluginInstallInRecords: (
      records: Record<string, unknown>,
      update: { pluginId: string; installedAt?: string } & Record<string, unknown>,
    ) => {
      const { pluginId, ...record } = update;
      return {
        ...records,
        [pluginId]: {
          ...(records[pluginId] as Record<string, unknown> | undefined),
          ...record,
          installedAt: update.installedAt ?? "2026-04-25T00:00:00.000Z",
        },
      };
    },
  };
});

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: ((...args: unknown[]) =>
    invokeMock<unknown[], unknown>(loadPluginManifestRegistry, ...args)) as (
    ...args: unknown[]
  ) => unknown,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginSnapshotReport: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildPluginSnapshotReport"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginSnapshotReport"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginSnapshotReport"]>
    >(
      buildPluginSnapshotReport,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginSnapshotReport"],
  buildPluginRegistrySnapshotReport: ((
    ...args: Parameters<
      (typeof import("../plugins/status.js"))["buildPluginRegistrySnapshotReport"]
    >
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginRegistrySnapshotReport"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginRegistrySnapshotReport"]>
    >(
      buildPluginRegistrySnapshotReport,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginRegistrySnapshotReport"],
  buildPluginInspectReport: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildPluginInspectReport"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginInspectReport"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginInspectReport"]>
    >(
      buildPluginInspectReport,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginInspectReport"],
  buildAllPluginInspectReports: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildAllPluginInspectReports"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildAllPluginInspectReports"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildAllPluginInspectReports"]>
    >(
      buildAllPluginInspectReports,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildAllPluginInspectReports"],
  buildPluginDiagnosticsReport: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildPluginDiagnosticsReport"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginDiagnosticsReport"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginDiagnosticsReport"]>
    >(
      buildPluginDiagnosticsReport,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginDiagnosticsReport"],
  buildPluginCompatibilityNotices: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"]>
    >(
      buildPluginCompatibilityNotices,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"],
  formatPluginCompatibilityNotice: (entry: { message: string }) => entry.message,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: ((...args: unknown[]) =>
    invokeMock<unknown[], unknown>(loadPluginManifestRegistry, ...args)) as (
    ...args: unknown[]
  ) => unknown,
  loadPluginRegistrySnapshotWithMetadata: () => ({
    source: "derived",
    snapshot: { plugins: [] },
    diagnostics: [],
  }),
  inspectPluginRegistry: ((
    ...args: Parameters<(typeof import("../plugins/plugin-registry.js"))["inspectPluginRegistry"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/plugin-registry.js"))["inspectPluginRegistry"]>,
      ReturnType<(typeof import("../plugins/plugin-registry.js"))["inspectPluginRegistry"]>
    >(
      inspectPluginRegistry,
      ...args,
    )) as (typeof import("../plugins/plugin-registry.js"))["inspectPluginRegistry"],
  refreshPluginRegistry: ((
    ...args: Parameters<(typeof import("../plugins/plugin-registry.js"))["refreshPluginRegistry"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/plugin-registry.js"))["refreshPluginRegistry"]>,
      ReturnType<(typeof import("../plugins/plugin-registry.js"))["refreshPluginRegistry"]>
    >(
      refreshPluginRegistry,
      ...args,
    )) as (typeof import("../plugins/plugin-registry.js"))["refreshPluginRegistry"],
}));

vi.mock("../plugins/slots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/slots.js")>();
  return {
    ...actual,
    applyExclusiveSlotSelection: ((
      params: Parameters<(typeof import("../plugins/slots.js"))["applyExclusiveSlotSelection"]>[0],
    ) =>
      invokeMock<
        [Parameters<(typeof import("../plugins/slots.js"))["applyExclusiveSlotSelection"]>[0]],
        ReturnType<(typeof import("../plugins/slots.js"))["applyExclusiveSlotSelection"]>
      >(
        applyExclusiveSlotSelection,
        params,
      )) as (typeof import("../plugins/slots.js"))["applyExclusiveSlotSelection"],
  };
});

vi.mock("../plugins/uninstall.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/uninstall.js")>();
  return {
    ...actual,
    planPluginUninstall: ((
      ...args: Parameters<(typeof import("../plugins/uninstall.js"))["planPluginUninstall"]>
    ) =>
      invokeMock<
        Parameters<(typeof import("../plugins/uninstall.js"))["planPluginUninstall"]>,
        ReturnType<(typeof import("../plugins/uninstall.js"))["planPluginUninstall"]>
      >(
        planPluginUninstall,
        ...args,
      )) as (typeof import("../plugins/uninstall.js"))["planPluginUninstall"],
    applyPluginUninstallDirectoryRemoval: ((
      ...args: Parameters<
        (typeof import("../plugins/uninstall.js"))["applyPluginUninstallDirectoryRemoval"]
      >
    ) =>
      invokeMock<
        Parameters<
          (typeof import("../plugins/uninstall.js"))["applyPluginUninstallDirectoryRemoval"]
        >,
        ReturnType<
          (typeof import("../plugins/uninstall.js"))["applyPluginUninstallDirectoryRemoval"]
        >
      >(
        applyPluginUninstallDirectoryRemoval,
        ...args,
      )) as (typeof import("../plugins/uninstall.js"))["applyPluginUninstallDirectoryRemoval"],
    uninstallPlugin: ((
      ...args: Parameters<(typeof import("../plugins/uninstall.js"))["uninstallPlugin"]>
    ) =>
      invokeMock<
        Parameters<(typeof import("../plugins/uninstall.js"))["uninstallPlugin"]>,
        ReturnType<(typeof import("../plugins/uninstall.js"))["uninstallPlugin"]>
      >(uninstallPlugin, ...args)) as (typeof import("../plugins/uninstall.js"))["uninstallPlugin"],
    resolveUninstallDirectoryTarget: ({
      installRecord,
    }: {
      installRecord?: { installPath?: string; sourcePath?: string };
    }) => installRecord?.installPath ?? installRecord?.sourcePath ?? null,
  };
});

vi.mock("../plugins/update.js", () => ({
  updateNpmInstalledPlugins: ((
    ...args: Parameters<(typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]>,
      ReturnType<(typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]>
    >(
      updateNpmInstalledPlugins,
      ...args,
    )) as (typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"],
}));

vi.mock("../hooks/update.js", () => ({
  updateNpmInstalledHookPacks: ((
    ...args: Parameters<(typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]>,
      ReturnType<(typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]>
    >(
      updateNpmInstalledHookPacks,
      ...args,
    )) as (typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"],
}));

vi.mock("./prompt.js", () => ({
  promptYesNo: ((...args: Parameters<(typeof import("./prompt.js"))["promptYesNo"]>) =>
    invokeMock<
      Parameters<(typeof import("./prompt.js"))["promptYesNo"]>,
      ReturnType<(typeof import("./prompt.js"))["promptYesNo"]>
    >(promptYesNo, ...args)) as (typeof import("./prompt.js"))["promptYesNo"],
}));

vi.mock("../plugins/install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
    SECURITY_SCAN_BLOCKED: "security_scan_blocked",
    SECURITY_SCAN_FAILED: "security_scan_failed",
  },
  installPluginFromNpmSpec: ((
    ...args: Parameters<(typeof import("../plugins/install.js"))["installPluginFromNpmSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/install.js"))["installPluginFromNpmSpec"]>,
      ReturnType<(typeof import("../plugins/install.js"))["installPluginFromNpmSpec"]>
    >(
      installPluginFromNpmSpec,
      ...args,
    )) as (typeof import("../plugins/install.js"))["installPluginFromNpmSpec"],
  installPluginFromPath: ((
    ...args: Parameters<(typeof import("../plugins/install.js"))["installPluginFromPath"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/install.js"))["installPluginFromPath"]>,
      ReturnType<(typeof import("../plugins/install.js"))["installPluginFromPath"]>
    >(
      installPluginFromPath,
      ...args,
    )) as (typeof import("../plugins/install.js"))["installPluginFromPath"],
}));

vi.mock("../plugins/git-install.js", () => ({
  installPluginFromGitSpec: ((
    ...args: Parameters<(typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"]>,
      ReturnType<(typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"]>
    >(
      installPluginFromGitSpec,
      ...args,
    )) as (typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"],
  parseGitPluginSpec: ((
    ...args: Parameters<(typeof import("../plugins/git-install.js"))["parseGitPluginSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/git-install.js"))["parseGitPluginSpec"]>,
      ReturnType<(typeof import("../plugins/git-install.js"))["parseGitPluginSpec"]>
    >(
      parseGitPluginSpec,
      ...args,
    )) as (typeof import("../plugins/git-install.js"))["parseGitPluginSpec"],
}));

vi.mock("../hooks/install.js", () => ({
  installHooksFromNpmSpec: ((
    ...args: Parameters<(typeof import("../hooks/install.js"))["installHooksFromNpmSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/install.js"))["installHooksFromNpmSpec"]>,
      ReturnType<(typeof import("../hooks/install.js"))["installHooksFromNpmSpec"]>
    >(
      installHooksFromNpmSpec,
      ...args,
    )) as (typeof import("../hooks/install.js"))["installHooksFromNpmSpec"],
  installHooksFromPath: ((
    ...args: Parameters<(typeof import("../hooks/install.js"))["installHooksFromPath"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/install.js"))["installHooksFromPath"]>,
      ReturnType<(typeof import("../hooks/install.js"))["installHooksFromPath"]>
    >(
      installHooksFromPath,
      ...args,
    )) as (typeof import("../hooks/install.js"))["installHooksFromPath"],
  resolveHookInstallDir: (hookId: string) => `/tmp/hooks/${hookId}`,
}));

vi.mock("../hooks/installs.js", () => ({
  recordHookInstall: ((
    ...args: Parameters<(typeof import("../hooks/installs.js"))["recordHookInstall"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/installs.js"))["recordHookInstall"]>,
      ReturnType<(typeof import("../hooks/installs.js"))["recordHookInstall"]>
    >(recordHookInstall, ...args)) as (typeof import("../hooks/installs.js"))["recordHookInstall"],
}));

vi.mock("../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
  },
  installPluginFromClawHub: ((
    ...args: Parameters<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>,
      ReturnType<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>
    >(
      installPluginFromClawHub,
      ...args,
    )) as (typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"],
}));

vi.mock("../infra/clawhub.js", () => ({
  parseClawHubPluginSpec: ((
    ...args: Parameters<(typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"]>,
      ReturnType<(typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"]>
    >(
      parseClawHubPluginSpec,
      ...args,
    )) as (typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"],
}));

const { registerPluginsCli } = await import("./plugins-cli.js");

export { registerPluginsCli };

export async function runPluginsCommand(argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerPluginsCli(program);
  return await program.parseAsync(argv, { from: "user" });
}

export function resetPluginsCliTestState() {
  resetRuntimeCapture();
  restoreRuntimeCaptureMocks();
  loadConfig.mockReset();
  readConfigFileSnapshot.mockReset();
  writeConfigFile.mockReset();
  replaceConfigFile.mockReset();
  resolveStateDir.mockReset();
  installPluginFromMarketplace.mockReset();
  listMarketplacePlugins.mockReset();
  resolveMarketplaceInstallShortcut.mockReset();
  enablePluginInConfig.mockReset();
  recordPluginInstall.mockReset();
  mockInstalledPluginIndexInstallRecords = {};
  loadInstalledPluginIndexInstallRecords.mockReset();
  writePersistedInstalledPluginIndexInstallRecords.mockReset();
  loadPluginManifestRegistry.mockReset();
  buildPluginSnapshotReport.mockReset();
  buildPluginRegistrySnapshotReport.mockReset();
  buildPluginInspectReport.mockReset();
  buildPluginDiagnosticsReport.mockReset();
  buildPluginCompatibilityNotices.mockReset();
  inspectPluginRegistry.mockReset();
  refreshPluginRegistry.mockReset();
  applyExclusiveSlotSelection.mockReset();
  planPluginUninstall.mockReset();
  applyPluginUninstallDirectoryRemoval.mockReset();
  uninstallPlugin.mockReset();
  updateNpmInstalledPlugins.mockReset();
  updateNpmInstalledHookPacks.mockReset();
  promptYesNo.mockReset();
  installPluginFromGitSpec.mockReset();
  parseGitPluginSpec.mockReset();
  installPluginFromNpmSpec.mockReset();
  installPluginFromPath.mockReset();
  installPluginFromClawHub.mockReset();
  parseClawHubPluginSpec.mockReset();
  installHooksFromNpmSpec.mockReset();
  installHooksFromPath.mockReset();
  recordHookInstall.mockReset();

  loadConfig.mockReturnValue({} as OpenClawConfig);
  readConfigFileSnapshot.mockImplementation(async () => {
    const config = getRuntimeConfig();
    return {
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: "{}",
      parsed: config,
      resolved: config,
      sourceConfig: config,
      runtimeConfig: config,
      valid: true,
      config,
      hash: "mock",
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
  });
  writeConfigFile.mockResolvedValue(undefined);
  replaceConfigFile.mockImplementation(
    (async (params: { nextConfig: OpenClawConfig }) =>
      await writeConfigFile(params.nextConfig)) as (...args: unknown[]) => Promise<unknown>,
  );
  resolveStateDir.mockReturnValue("/tmp/openclaw-state");
  resolveMarketplaceInstallShortcut.mockResolvedValue(null);
  installPluginFromMarketplace.mockResolvedValue({
    ok: false,
    error: "marketplace install failed",
  });
  enablePluginInConfig.mockImplementation(((cfg: OpenClawConfig, pluginId: string) => ({
    config: cfg,
    enabled: true,
    pluginId,
  })) as (...args: unknown[]) => unknown);
  recordPluginInstall.mockImplementation(
    ((cfg: OpenClawConfig) => cfg) as (...args: unknown[]) => unknown,
  );
  loadInstalledPluginIndexInstallRecords.mockImplementation(async () =>
    clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords),
  );
  writePersistedInstalledPluginIndexInstallRecords.mockImplementation(async (records: unknown) => {
    mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(
      (records ?? {}) as PluginInstallRecordMap,
    );
  });
  loadPluginManifestRegistry.mockReturnValue({
    plugins: [],
    diagnostics: [],
  });
  const defaultPluginReport = {
    plugins: [],
    diagnostics: [],
  };
  buildPluginSnapshotReport.mockReturnValue(defaultPluginReport);
  buildPluginRegistrySnapshotReport.mockReturnValue({
    ...defaultPluginReport,
    registrySource: "derived",
    registryDiagnostics: [],
  });
  buildPluginDiagnosticsReport.mockReturnValue(defaultPluginReport);
  buildPluginCompatibilityNotices.mockReturnValue([]);
  const defaultRegistryIndex = {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    plugins: [],
    diagnostics: [],
  };
  inspectPluginRegistry.mockResolvedValue({
    state: "fresh",
    refreshReasons: [],
    persisted: defaultRegistryIndex,
    current: defaultRegistryIndex,
  });
  refreshPluginRegistry.mockResolvedValue(defaultRegistryIndex);
  applyExclusiveSlotSelection.mockImplementation((({ config }: { config: OpenClawConfig }) => ({
    config,
    warnings: [],
  })) as (...args: unknown[]) => unknown);
  planPluginUninstall.mockImplementation((({
    config,
    pluginId,
  }: {
    config: OpenClawConfig;
    pluginId: string;
  }) => ({
    ok: true,
    config,
    pluginId,
    actions: createEmptyUninstallActions(),
    directoryRemoval: null,
  })) as (...args: unknown[]) => unknown);
  applyPluginUninstallDirectoryRemoval.mockResolvedValue({
    directoryRemoved: false,
    warnings: [],
  });
  uninstallPlugin.mockResolvedValue({
    ok: true,
    config: {} as OpenClawConfig,
    warnings: [],
    actions: createEmptyUninstallActions(),
  });
  updateNpmInstalledPlugins.mockResolvedValue({
    outcomes: [],
    changed: false,
    config: {} as OpenClawConfig,
  });
  updateNpmInstalledHookPacks.mockResolvedValue({
    outcomes: [],
    changed: false,
    config: {} as OpenClawConfig,
  });
  promptYesNo.mockResolvedValue(true);
  installPluginFromPath.mockResolvedValue({ ok: false, error: "path install disabled in test" });
  installPluginFromGitSpec.mockResolvedValue({
    ok: false,
    error: "git install disabled in test",
  });
  parseGitPluginSpec.mockImplementation((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.toLowerCase().startsWith("git:")) {
      return null;
    }
    const body = trimmed.slice("git:".length).trim();
    if (!body) {
      return null;
    }
    return {
      input: trimmed,
      url: body,
      label: body,
      normalizedSpec: trimmed,
    };
  });
  installPluginFromNpmSpec.mockResolvedValue({
    ok: false,
    error: "npm install disabled in test",
  });
  installPluginFromClawHub.mockResolvedValue({
    ok: false,
    error: "clawhub install disabled in test",
  });
  parseClawHubPluginSpec.mockReturnValue(null);
  installHooksFromPath.mockResolvedValue({
    ok: false,
    error: "hook path install disabled in test",
  });
  installHooksFromNpmSpec.mockResolvedValue({
    ok: false,
    error: "hook npm install disabled in test",
  });
  recordHookInstall.mockImplementation(
    ((cfg: OpenClawConfig) => cfg) as (...args: unknown[]) => unknown,
  );
}
