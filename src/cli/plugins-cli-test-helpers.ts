// Shared Vitest mocks and runtime capture helpers for plugin CLI command tests.
import { Command } from "commander";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { recordPluginManifestInstallOwner } from "../plugins/manifest-install-owner.js";
import type { CliMockOutputRuntime } from "./test-runtime-capture.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type LoadConfigFn = (typeof import("../config/config.js"))["loadConfig"];
type ParseClawHubPluginSpecFn =
  (typeof import("../infra/clawhub-spec.js"))["parseClawHubPluginSpec"];
type ReportClawHubPluginInstallTelemetryFn =
  (typeof import("../infra/clawhub-packages.js"))["reportClawHubPluginInstallTelemetry"];
type InstallPluginFromMarketplaceFn =
  (typeof import("../plugins/marketplace.js"))["installPluginFromMarketplace"];
type InstallPluginFromGitSpecFn =
  (typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"];
type ParseGitPluginSpecFn = (typeof import("../plugins/git-install.js"))["parseGitPluginSpec"];
type ListMarketplacePluginsFn =
  (typeof import("../plugins/marketplace.js"))["listMarketplacePlugins"];
type ResolveMarketplaceInstallShortcutFn =
  (typeof import("../plugins/marketplace.js"))["resolveMarketplaceInstallShortcut"];
type UpdateNpmInstalledPluginsFn =
  (typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"];
type UpdateNpmInstalledHookPacksFn =
  (typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"];
type ReadPersistedInstalledPluginIndexFn =
  (typeof import("../plugins/installed-plugin-index-store.js"))["readPersistedInstalledPluginIndex"];
type RestorePersistedInstalledPluginIndexIfCurrentFn =
  (typeof import("../plugins/installed-plugin-index-store.js"))["restorePersistedInstalledPluginIndexIfCurrent"];
type WritePersistedInstalledPluginIndexInstallRecordsFn =
  (typeof import("../plugins/installed-plugin-index-records.js"))["writePersistedInstalledPluginIndexInstallRecords"];
type WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn =
  (typeof import("../plugins/installed-plugin-index-records.js"))["writePersistedInstalledPluginIndexInstallRecordsWithLease"];
type PluginInstallRecordMap = Record<string, PluginInstallRecord>;

function createEmptyUninstallActions() {
  return {
    entry: false,
    install: false,
    allowlist: false,
    denylist: false,
    loadPath: false,
    memorySlot: false,
    contextEngineSlot: false,
    channelConfig: false,
    directory: false,
  };
}

let mockInstalledPluginIndexInstallRecords: PluginInstallRecordMap = {};
let mockHookInstallRecords: Record<string, HookInstallRecord> = {};
let mockInstalledPluginIndexRevision = 0;

export function setHookInstallRecords(records: Record<string, HookInstallRecord>): void {
  mockHookInstallRecords = structuredClone(records);
}

function clonePluginInstallRecords(records: PluginInstallRecordMap): PluginInstallRecordMap {
  // Tests mutate records freely; clone to keep helper state from leaking across assertions.
  return structuredClone(records);
}

export function createTestInstalledPluginIndex(params: {
  policyHash: string;
  installRecords: PluginInstallRecordMap;
  plugins?: InstalledPluginIndex["plugins"];
}): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: params.policyHash,
    generatedAtMs: 0,
    refreshReason: "source-changed",
    installRecords: clonePluginInstallRecords(params.installRecords),
    plugins: params.plugins ?? [],
    diagnostics: [],
  };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper preserves mock call and result types.
function invokeMock<TArgs extends unknown[], TResult>(mock: unknown, ...args: TArgs): TResult {
  return (mock as (...args: TArgs) => TResult)(...args);
}

export const pluginCliConfigMock: Mock<LoadConfigFn> = vi.fn<LoadConfigFn>(
  () => ({}) as OpenClawConfig,
);
export const readConfigFileSnapshotMock: AsyncUnknownMock = vi.fn();
export const readConfigFileSnapshotForWriteMock: AsyncUnknownMock = vi.fn();
export const configWriteMock: AsyncUnknownMock = vi.fn(async () => undefined);
export const replaceConfigFileMock: AsyncUnknownMock = vi.fn(
  async (params: { nextConfig: OpenClawConfig }) => await configWriteMock(params.nextConfig),
) as AsyncUnknownMock;
const resolveStateDir: Mock<() => string> = vi.fn(() => "/tmp/openclaw-state");
export const installPluginFromMarketplaceMock: Mock<InstallPluginFromMarketplaceFn> = vi.fn();
export const installPluginFromGitSpecMock: Mock<InstallPluginFromGitSpecFn> = vi.fn();
const parseGitPluginSpec: Mock<ParseGitPluginSpecFn> = vi.fn();
const listMarketplacePlugins: Mock<ListMarketplacePluginsFn> = vi.fn();
export const resolveMarketplaceInstallShortcutMock: Mock<ResolveMarketplaceInstallShortcutFn> =
  vi.fn();
export const enablePluginInConfigMock: UnknownMock = vi.fn();
export const recordPluginInstallMock: UnknownMock = vi.fn();
const loadInstalledPluginIndexInstallRecords: AsyncUnknownMock = vi.fn(async () =>
  clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords),
);
const writePersistedInstalledPluginIndexInstallRecords: Mock<WritePersistedInstalledPluginIndexInstallRecordsFn> =
  vi.fn<WritePersistedInstalledPluginIndexInstallRecordsFn>(async (records) => {
    mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
    return "/tmp/openclaw-state/openclaw.sqlite";
  });
export const readPersistedInstalledPluginIndexMock: Mock<ReadPersistedInstalledPluginIndexFn> =
  vi.fn<ReadPersistedInstalledPluginIndexFn>(async () => null);
export const writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock: Mock<WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn> =
  vi.fn<WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn>(async (records) => {
    const previous = await readPersistedInstalledPluginIndexMock();
    mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
    mockInstalledPluginIndexRevision += 1;
    return { previous, revision: mockInstalledPluginIndexRevision };
  });
export const restorePersistedInstalledPluginIndexIfCurrentMock: Mock<RestorePersistedInstalledPluginIndexIfCurrentFn> =
  vi.fn<RestorePersistedInstalledPluginIndexIfCurrentFn>(async (index, expectedRevision) => {
    if (mockInstalledPluginIndexRevision !== expectedRevision) {
      return false;
    }
    mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(
      (index?.installRecords ?? {}) as PluginInstallRecordMap,
    );
    mockInstalledPluginIndexRevision += 1;
    return true;
  });
export const loadPluginManifestRegistryMock: UnknownMock = vi.fn();
export const buildPluginSnapshotReportMock: UnknownMock = vi.fn();
export const buildPluginRegistrySnapshotReportMock: UnknownMock = vi.fn();
export const buildPluginInspectReportMock: UnknownMock = vi.fn();
const buildAllPluginInspectReports: UnknownMock = vi.fn();
export const buildPluginDiagnosticsReportMock: UnknownMock = vi.fn();
export const buildPluginCompatibilityNoticesMock: UnknownMock = vi.fn();
export const inspectPluginRegistryMock: AsyncUnknownMock = vi.fn();
export const refreshPluginRegistryMock: AsyncUnknownMock = vi.fn();
export const notifyGatewayPluginMetadataChangedMock: AsyncUnknownMock = vi.fn();
export const clearPluginRegistryLoadCacheMock: UnknownMock = vi.fn();
export const applyExclusiveSlotSelectionMock: UnknownMock = vi.fn();
export const planPluginUninstallMock: UnknownMock = vi.fn();
export const applyPluginUninstallDirectoryRemovalMock: AsyncUnknownMock = vi.fn();
export const updateNpmInstalledPluginsMock: Mock<UpdateNpmInstalledPluginsFn> = vi.fn();
export const updateNpmInstalledHookPacksMock: Mock<UpdateNpmInstalledHookPacksFn> = vi.fn();
export const promptYesNoMock: AsyncUnknownMock = vi.fn();
const promptText: AsyncUnknownMock = vi.fn();
export class PromptInputClosedError extends Error {
  constructor() {
    super("Prompt input closed before an answer was received.");
    this.name = "PromptInputClosedError";
  }
}
export const installPluginFromNpmSpecMock: AsyncUnknownMock = vi.fn();
export const installPluginFromNpmPackArchiveMock: AsyncUnknownMock = vi.fn();
export const installPluginFromPathMock: AsyncUnknownMock = vi.fn();
export const installPluginFromClawHubMock: AsyncUnknownMock = vi.fn();
export const parseClawHubPluginSpecMock: Mock<ParseClawHubPluginSpecFn> = vi.fn();
export const reportClawHubPluginInstallTelemetryMock: Mock<ReportClawHubPluginInstallTelemetryFn> =
  vi.fn(async () => undefined);
export const findBundledPluginSourceMock: UnknownMock = vi.fn();
export const installHooksFromNpmSpecMock: AsyncUnknownMock = vi.fn();
export const installHooksFromPathMock: AsyncUnknownMock = vi.fn();
export const recordHookInstallMock: UnknownMock = vi.fn();

const { defaultRuntime, pluginsCliRuntimeLogs, runtimeErrors, resetRuntimeCapture } = vi.hoisted(
  () => {
    const runtimeLogsLocal: string[] = [];
    const runtimeErrorsLocal: string[] = [];
    const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
    const normalizeStdout = (value: string) => (value.endsWith("\n") ? value.slice(0, -1) : value);
    const stringifyJson = (value: unknown, space = 2) =>
      JSON.stringify(value, null, space > 0 ? space : undefined);
    const defaultRuntimeLocal = {
      log: vi.fn((...args: unknown[]) => {
        runtimeLogsLocal.push(stringifyArgs(args));
      }),
      error: vi.fn((...args: unknown[]) => {
        runtimeErrorsLocal.push(stringifyArgs(args));
      }),
      writeStdout: vi.fn((value: string) => {
        defaultRuntimeLocal.log(normalizeStdout(value));
      }),
      writeJson: vi.fn((value: unknown, space = 2) => {
        defaultRuntimeLocal.log(stringifyJson(value, space));
      }),
      exit: vi.fn((code: number) => {
        throw new Error(`__exit__:${code}`);
      }),
    } as CliMockOutputRuntime;
    return {
      defaultRuntime: defaultRuntimeLocal,
      pluginsCliRuntimeLogs: runtimeLogsLocal,
      runtimeErrors: runtimeErrorsLocal,
      resetRuntimeCapture: () => {
        runtimeLogsLocal.length = 0;
        runtimeErrorsLocal.length = 0;
      },
    };
  },
);

export { runtimeErrors, pluginsCliRuntimeLogs };

export function setInstalledPluginIndexInstallRecords(records: PluginInstallRecordMap): void {
  mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
}

function restoreRuntimeCaptureMocks() {
  defaultRuntime.log.mockReset();
  defaultRuntime.log.mockImplementation((...args: unknown[]) => {
    pluginsCliRuntimeLogs.push(args.map((value) => String(value)).join(" "));
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

vi.mock("./plugins-update-gateway-signal.js", () => ({
  notifyGatewayPluginMetadataChanged: (...args: unknown[]) =>
    notifyGatewayPluginMetadataChangedMock(...args),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => {
    if (process.env.OPENCLAW_NIX_MODE === "1") {
      throw new Error(
        [
          "Config is managed by Nix (`OPENCLAW_NIX_MODE=1`), so OpenClaw treats openclaw.json as immutable.",
          "Do not run setup, onboarding, openclaw update, plugin install/update/uninstall/enable, doctor repair/token-generation, or config set against this file.",
          "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
          "OpenClaw Nix overview: https://docs.openclaw.ai/install/nix",
        ].join("\n"),
      );
    }
  },
  getRuntimeConfig: () => pluginCliConfigMock(),
  loadConfig: () => pluginCliConfigMock(),
  readConfigFileSnapshot: ((
    ...args: Parameters<(typeof import("../config/config.js"))["readConfigFileSnapshot"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../config/config.js"))["readConfigFileSnapshot"]>,
      ReturnType<(typeof import("../config/config.js"))["readConfigFileSnapshot"]>
    >(
      readConfigFileSnapshotMock,
      ...args,
    )) as (typeof import("../config/config.js"))["readConfigFileSnapshot"],
  readConfigFileSnapshotForWrite: ((
    ...args: Parameters<(typeof import("../config/config.js"))["readConfigFileSnapshotForWrite"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../config/config.js"))["readConfigFileSnapshotForWrite"]>,
      ReturnType<(typeof import("../config/config.js"))["readConfigFileSnapshotForWrite"]>
    >(
      readConfigFileSnapshotForWriteMock,
      ...args,
    )) as (typeof import("../config/config.js"))["readConfigFileSnapshotForWrite"],
  writeConfigFile: ((config: OpenClawConfig) =>
    invokeMock<
      [OpenClawConfig],
      ReturnType<(typeof import("../config/config.js"))["writeConfigFile"]>
    >(configWriteMock, config)) as (typeof import("../config/config.js"))["writeConfigFile"],
  replaceConfigFile: ((
    params: Parameters<(typeof import("../config/config.js"))["replaceConfigFile"]>[0],
  ) =>
    invokeMock<
      [Parameters<(typeof import("../config/config.js"))["replaceConfigFile"]>[0]],
      ReturnType<(typeof import("../config/config.js"))["replaceConfigFile"]>
    >(
      replaceConfigFileMock,
      params,
    )) as (typeof import("../config/config.js"))["replaceConfigFile"],
}));

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveIsNixMode: () => false,
    resolveStateDir: () => resolveStateDir(),
  };
});

vi.mock("../plugins/marketplace.js", () => ({
  installPluginFromMarketplace: ((...args: Parameters<InstallPluginFromMarketplaceFn>) =>
    installPluginFromMarketplaceMock(...args)) as InstallPluginFromMarketplaceFn,
  listMarketplacePlugins: ((...args: Parameters<ListMarketplacePluginsFn>) =>
    listMarketplacePlugins(...args)) as ListMarketplacePluginsFn,
  resolveMarketplaceInstallShortcut: ((...args: Parameters<ResolveMarketplaceInstallShortcutFn>) =>
    resolveMarketplaceInstallShortcutMock(...args)) as ResolveMarketplaceInstallShortcutFn,
}));

vi.mock("../plugins/enable.js", () => ({
  enableExplicitlySelectedPluginInConfig: ((
    ...args: Parameters<
      (typeof import("../plugins/enable.js"))["enableExplicitlySelectedPluginInConfig"]
    >
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/enable.js"))["enableExplicitlySelectedPluginInConfig"]>,
      unknown
    >(
      enablePluginInConfigMock,
      ...args,
    )) as (typeof import("../plugins/enable.js"))["enableExplicitlySelectedPluginInConfig"],
  enablePluginInConfig: ((
    ...args: Parameters<(typeof import("../plugins/enable.js"))["enablePluginInConfig"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/enable.js"))["enablePluginInConfig"]>,
      unknown
    >(
      enablePluginInConfigMock,
      ...args,
    )) as (typeof import("../plugins/enable.js"))["enablePluginInConfig"],
}));

vi.mock("../plugins/installs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/installs.js")>();
  return {
    ...actual,
    recordPluginInstall: ((
      ...args: Parameters<(typeof import("../plugins/installs.js"))["recordPluginInstall"]>
    ) =>
      invokeMock<
        Parameters<(typeof import("../plugins/installs.js"))["recordPluginInstall"]>,
        ReturnType<(typeof import("../plugins/installs.js"))["recordPluginInstall"]>
      >(
        recordPluginInstallMock,
        ...args,
      )) as (typeof import("../plugins/installs.js"))["recordPluginInstall"],
  };
});

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
    writePersistedInstalledPluginIndexInstallRecordsWithLease: ((...args: unknown[]) =>
      invokeMock<unknown[], unknown>(
        writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
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

vi.mock("../plugins/installed-plugin-index-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-store.js")>();
  return {
    ...actual,
    readPersistedInstalledPluginIndex: ((...args: unknown[]) =>
      invokeMock<unknown[], unknown>(readPersistedInstalledPluginIndexMock, ...args)) as (
      ...args: unknown[]
    ) => unknown,
    restorePersistedInstalledPluginIndexIfCurrent: ((...args: unknown[]) =>
      invokeMock<unknown[], unknown>(
        restorePersistedInstalledPluginIndexIfCurrentMock,
        ...args,
      )) as (...args: unknown[]) => unknown,
  };
});

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: ((...args: unknown[]) =>
    invokeMock<unknown[], unknown>(loadPluginManifestRegistryMock, ...args)) as (
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
      buildPluginSnapshotReportMock,
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
      buildPluginRegistrySnapshotReportMock,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginRegistrySnapshotReport"],
  buildPluginInspectReport: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildPluginInspectReport"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginInspectReport"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginInspectReport"]>
    >(
      buildPluginInspectReportMock,
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
      buildPluginDiagnosticsReportMock,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginDiagnosticsReport"],
  buildPluginCompatibilityNotices: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"]>
    >(
      buildPluginCompatibilityNoticesMock,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"],
  formatPluginCompatibilityNotice: (entry: { message: string }) => entry.message,
}));

vi.mock("../plugins/status-snapshot.js", () => ({
  buildPluginRegistrySnapshotReport: ((
    ...args: Parameters<
      (typeof import("../plugins/status-snapshot.js"))["buildPluginRegistrySnapshotReport"]
    >
  ) =>
    invokeMock<
      Parameters<
        (typeof import("../plugins/status-snapshot.js"))["buildPluginRegistrySnapshotReport"]
      >,
      ReturnType<
        (typeof import("../plugins/status-snapshot.js"))["buildPluginRegistrySnapshotReport"]
      >
    >(
      buildPluginRegistrySnapshotReportMock,
      ...args,
    )) as (typeof import("../plugins/status-snapshot.js"))["buildPluginRegistrySnapshotReport"],
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: ((...args: unknown[]) =>
    invokeMock<unknown[], unknown>(loadPluginManifestRegistryMock, ...args)) as (
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
      inspectPluginRegistryMock,
      ...args,
    )) as (typeof import("../plugins/plugin-registry.js"))["inspectPluginRegistry"],
  refreshPluginRegistry: ((
    ...args: Parameters<(typeof import("../plugins/plugin-registry.js"))["refreshPluginRegistry"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/plugin-registry.js"))["refreshPluginRegistry"]>,
      ReturnType<(typeof import("../plugins/plugin-registry.js"))["refreshPluginRegistry"]>
    >(
      refreshPluginRegistryMock,
      ...args,
    )) as (typeof import("../plugins/plugin-registry.js"))["refreshPluginRegistry"],
}));

vi.mock("../plugins/loader.js", () => ({
  clearPluginRegistryLoadCache: ((...args: unknown[]) =>
    invokeMock<unknown[], unknown>(clearPluginRegistryLoadCacheMock, ...args)) as (
    ...args: unknown[]
  ) => unknown,
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
        applyExclusiveSlotSelectionMock,
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
        planPluginUninstallMock,
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
        applyPluginUninstallDirectoryRemovalMock,
        ...args,
      )) as (typeof import("../plugins/uninstall.js"))["applyPluginUninstallDirectoryRemoval"],
  };
});

vi.mock("../plugins/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/update.js")>();
  return {
    ...actual,
    updateNpmInstalledPlugins: ((
      ...args: Parameters<(typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]>
    ) =>
      invokeMock<
        Parameters<(typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]>,
        ReturnType<(typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]>
      >(
        updateNpmInstalledPluginsMock,
        ...args,
      )) as (typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"],
  };
});

vi.mock("../hooks/update.js", () => ({
  updateNpmInstalledHookPacks: ((
    ...args: Parameters<(typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]>,
      ReturnType<(typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]>
    >(
      updateNpmInstalledHookPacksMock,
      ...args,
    )) as (typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"],
}));

vi.mock("./prompt.js", () => ({
  PromptInputClosedError,
  promptText: ((...args: Parameters<(typeof import("./prompt.js"))["promptText"]>) =>
    invokeMock<
      Parameters<(typeof import("./prompt.js"))["promptText"]>,
      ReturnType<(typeof import("./prompt.js"))["promptText"]>
    >(promptText, ...args)) as (typeof import("./prompt.js"))["promptText"],
  promptYesNo: ((...args: Parameters<(typeof import("./prompt.js"))["promptYesNo"]>) =>
    invokeMock<
      Parameters<(typeof import("./prompt.js"))["promptYesNo"]>,
      ReturnType<(typeof import("./prompt.js"))["promptYesNo"]>
    >(promptYesNoMock, ...args)) as (typeof import("./prompt.js"))["promptYesNo"],
}));

vi.mock("../plugins/install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
    RELEASE_COHORT_UNAVAILABLE: "release_cohort_unavailable",
    SECURITY_SCAN_BLOCKED: "security_scan_blocked",
    SECURITY_SCAN_FAILED: "security_scan_failed",
    UNSUPPORTED_PLAIN_FILE_PLUGIN: "unsupported_plain_file_plugin",
  },
  installPluginFromNpmSpec: ((
    ...args: Parameters<(typeof import("../plugins/install.js"))["installPluginFromNpmSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/install.js"))["installPluginFromNpmSpec"]>,
      ReturnType<(typeof import("../plugins/install.js"))["installPluginFromNpmSpec"]>
    >(
      installPluginFromNpmSpecMock,
      ...args,
    )) as (typeof import("../plugins/install.js"))["installPluginFromNpmSpec"],
  installPluginFromNpmPackArchive: ((
    ...args: Parameters<(typeof import("../plugins/install.js"))["installPluginFromNpmPackArchive"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/install.js"))["installPluginFromNpmPackArchive"]>,
      ReturnType<(typeof import("../plugins/install.js"))["installPluginFromNpmPackArchive"]>
    >(
      installPluginFromNpmPackArchiveMock,
      ...args,
    )) as (typeof import("../plugins/install.js"))["installPluginFromNpmPackArchive"],
  installPluginFromPath: ((
    ...args: Parameters<(typeof import("../plugins/install.js"))["installPluginFromPath"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/install.js"))["installPluginFromPath"]>,
      ReturnType<(typeof import("../plugins/install.js"))["installPluginFromPath"]>
    >(
      installPluginFromPathMock,
      ...args,
    )) as (typeof import("../plugins/install.js"))["installPluginFromPath"],
}));

vi.mock("../plugins/bundled-sources.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/bundled-sources.js")>();
  return {
    ...actual,
    findBundledPluginSource: ((
      ...args: Parameters<
        (typeof import("../plugins/bundled-sources.js"))["findBundledPluginSource"]
      >
    ) => {
      if (findBundledPluginSourceMock.getMockImplementation()) {
        return invokeMock<
          Parameters<(typeof import("../plugins/bundled-sources.js"))["findBundledPluginSource"]>,
          ReturnType<(typeof import("../plugins/bundled-sources.js"))["findBundledPluginSource"]>
        >(findBundledPluginSourceMock, ...args);
      }
      return actual.findBundledPluginSource(...args);
    }) as (typeof import("../plugins/bundled-sources.js"))["findBundledPluginSource"],
  };
});

vi.mock("../plugins/git-install.js", () => ({
  installPluginFromGitSpec: ((
    ...args: Parameters<(typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"]>,
      ReturnType<(typeof import("../plugins/git-install.js"))["installPluginFromGitSpec"]>
    >(
      installPluginFromGitSpecMock,
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
  HOOK_INSTALL_ERROR_CODE: {
    MISSING_OPENCLAW_HOOKS: "missing_openclaw_hooks",
    EMPTY_OPENCLAW_HOOKS: "empty_openclaw_hooks",
  },
  installHooksFromNpmSpec: ((
    ...args: Parameters<(typeof import("../hooks/install.js"))["installHooksFromNpmSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/install.js"))["installHooksFromNpmSpec"]>,
      ReturnType<(typeof import("../hooks/install.js"))["installHooksFromNpmSpec"]>
    >(
      installHooksFromNpmSpecMock,
      ...args,
    )) as (typeof import("../hooks/install.js"))["installHooksFromNpmSpec"],
  installHooksFromPath: ((
    ...args: Parameters<(typeof import("../hooks/install.js"))["installHooksFromPath"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/install.js"))["installHooksFromPath"]>,
      ReturnType<(typeof import("../hooks/install.js"))["installHooksFromPath"]>
    >(
      installHooksFromPathMock,
      ...args,
    )) as (typeof import("../hooks/install.js"))["installHooksFromPath"],
  resolveHookInstallDir: (hookId: string) => `/tmp/hooks/${hookId}`,
}));

vi.mock("../hooks/installs.js", () => ({
  readHookInstalls: () => structuredClone(mockHookInstallRecords),
  recordHookInstall: ((
    ...args: Parameters<(typeof import("../hooks/installs.js"))["recordHookInstall"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/installs.js"))["recordHookInstall"]>,
      ReturnType<(typeof import("../hooks/installs.js"))["recordHookInstall"]>
    >(
      recordHookInstallMock,
      ...args,
    )) as (typeof import("../hooks/installs.js"))["recordHookInstall"],
}));

vi.mock("../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
    ARTIFACT_UNAVAILABLE: "artifact_unavailable",
  },
  installPluginFromClawHub: ((
    ...args: Parameters<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>,
      ReturnType<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>
    >(
      installPluginFromClawHubMock,
      ...args,
    )) as (typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"],
}));

vi.mock("../infra/clawhub-spec.js", () => ({
  parseClawHubPluginSpec: ((
    ...args: Parameters<(typeof import("../infra/clawhub-spec.js"))["parseClawHubPluginSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../infra/clawhub-spec.js"))["parseClawHubPluginSpec"]>,
      ReturnType<(typeof import("../infra/clawhub-spec.js"))["parseClawHubPluginSpec"]>
    >(
      parseClawHubPluginSpecMock,
      ...args,
    )) as (typeof import("../infra/clawhub-spec.js"))["parseClawHubPluginSpec"],
}));

vi.mock("../infra/clawhub-packages.js", () => ({
  reportClawHubPluginInstallTelemetry: ((
    ...args: Parameters<
      (typeof import("../infra/clawhub-packages.js"))["reportClawHubPluginInstallTelemetry"]
    >
  ) =>
    invokeMock<
      Parameters<
        (typeof import("../infra/clawhub-packages.js"))["reportClawHubPluginInstallTelemetry"]
      >,
      ReturnType<
        (typeof import("../infra/clawhub-packages.js"))["reportClawHubPluginInstallTelemetry"]
      >
    >(
      reportClawHubPluginInstallTelemetryMock,
      ...args,
    )) as (typeof import("../infra/clawhub-packages.js"))["reportClawHubPluginInstallTelemetry"],
}));

const { registerPluginsCli } = await import("./plugins-cli.js");

export async function runPluginsCommand(argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerPluginsCli(program);
  return await program.parseAsync(argv, { from: "user" });
}

export function resetPluginsCliTestState() {
  resetRuntimeCapture();
  restoreRuntimeCaptureMocks();
  pluginCliConfigMock.mockReset();
  readConfigFileSnapshotMock.mockReset();
  readConfigFileSnapshotForWriteMock.mockReset();
  configWriteMock.mockReset();
  replaceConfigFileMock.mockReset();
  resolveStateDir.mockReset();
  installPluginFromMarketplaceMock.mockReset();
  listMarketplacePlugins.mockReset();
  resolveMarketplaceInstallShortcutMock.mockReset();
  enablePluginInConfigMock.mockReset();
  recordPluginInstallMock.mockReset();
  mockInstalledPluginIndexInstallRecords = {};
  mockInstalledPluginIndexRevision = 0;
  loadInstalledPluginIndexInstallRecords.mockReset();
  writePersistedInstalledPluginIndexInstallRecords.mockReset();
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mockReset();
  readPersistedInstalledPluginIndexMock.mockReset();
  restorePersistedInstalledPluginIndexIfCurrentMock.mockReset();
  loadPluginManifestRegistryMock.mockReset();
  buildPluginSnapshotReportMock.mockReset();
  buildPluginRegistrySnapshotReportMock.mockReset();
  buildPluginInspectReportMock.mockReset();
  buildPluginDiagnosticsReportMock.mockReset();
  buildPluginCompatibilityNoticesMock.mockReset();
  inspectPluginRegistryMock.mockReset();
  refreshPluginRegistryMock.mockReset();
  notifyGatewayPluginMetadataChangedMock.mockReset();
  clearPluginRegistryLoadCacheMock.mockReset();
  applyExclusiveSlotSelectionMock.mockReset();
  planPluginUninstallMock.mockReset();
  applyPluginUninstallDirectoryRemovalMock.mockReset();
  updateNpmInstalledPluginsMock.mockReset();
  updateNpmInstalledHookPacksMock.mockReset();
  mockHookInstallRecords = {};
  promptText.mockReset();
  promptYesNoMock.mockReset();
  installPluginFromGitSpecMock.mockReset();
  parseGitPluginSpec.mockReset();
  installPluginFromNpmSpecMock.mockReset();
  installPluginFromNpmPackArchiveMock.mockReset();
  installPluginFromPathMock.mockReset();
  installPluginFromClawHubMock.mockReset();
  parseClawHubPluginSpecMock.mockReset();
  reportClawHubPluginInstallTelemetryMock.mockReset();
  reportClawHubPluginInstallTelemetryMock.mockResolvedValue(undefined);
  findBundledPluginSourceMock.mockReset();
  installHooksFromNpmSpecMock.mockReset();
  installHooksFromPathMock.mockReset();
  recordHookInstallMock.mockReset();

  pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
  readConfigFileSnapshotMock.mockImplementation(async () => {
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
  readConfigFileSnapshotForWriteMock.mockImplementation(async () => {
    const snapshot = (await readConfigFileSnapshotMock()) as { path: string };
    return {
      snapshot,
      writeOptions: {
        assertConfigPathForWrite: () => {},
        expectedConfigPath: snapshot.path,
        ownedConfigPathForWrite: snapshot.path,
      },
    };
  });
  configWriteMock.mockResolvedValue(undefined);
  replaceConfigFileMock.mockImplementation(
    (async (params: { nextConfig: OpenClawConfig }) =>
      await configWriteMock(params.nextConfig)) as (...args: unknown[]) => Promise<unknown>,
  );
  resolveStateDir.mockReturnValue("/tmp/openclaw-state");
  resolveMarketplaceInstallShortcutMock.mockResolvedValue(null);
  installPluginFromMarketplaceMock.mockResolvedValue({
    ok: false,
    error: "marketplace install failed",
  });
  enablePluginInConfigMock.mockImplementation(((cfg: OpenClawConfig, pluginId: string) => ({
    config: cfg,
    enabled: true,
    pluginId,
  })) as (...args: unknown[]) => unknown);
  recordPluginInstallMock.mockImplementation(
    ((cfg: OpenClawConfig) => cfg) as (...args: unknown[]) => unknown,
  );
  loadInstalledPluginIndexInstallRecords.mockImplementation(async () =>
    clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords),
  );
  writePersistedInstalledPluginIndexInstallRecords.mockImplementation(async (records) => {
    mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
    return "/tmp/openclaw-state/openclaw.sqlite";
  });
  readPersistedInstalledPluginIndexMock.mockResolvedValue(null);
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mockImplementation(
    async (records) => {
      const previous = await readPersistedInstalledPluginIndexMock();
      mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
      mockInstalledPluginIndexRevision += 1;
      return { previous, revision: mockInstalledPluginIndexRevision };
    },
  );
  restorePersistedInstalledPluginIndexIfCurrentMock.mockImplementation(
    async (index, expectedRevision) => {
      if (mockInstalledPluginIndexRevision !== expectedRevision) {
        return false;
      }
      mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(
        (index?.installRecords ?? {}) as PluginInstallRecordMap,
      );
      mockInstalledPluginIndexRevision += 1;
      return true;
    },
  );
  loadPluginManifestRegistryMock.mockImplementation((input: unknown) => {
    const installRecords =
      (input as { installRecords?: PluginInstallRecordMap } | undefined)?.installRecords ?? {};
    return {
      plugins: Object.entries(installRecords).map(([pluginId, record]) => {
        const rootDir = record.installPath ?? record.sourcePath ?? `/tmp/${pluginId}`;
        return recordPluginManifestInstallOwner(
          {
            id: pluginId,
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            origin: "global",
            rootDir,
            source: `${rootDir}/index.js`,
            manifestPath: `${rootDir}/openclaw.plugin.json`,
          },
          pluginId,
        );
      }),
      diagnostics: [],
    };
  });
  const defaultPluginReport = {
    plugins: [],
    diagnostics: [],
  };
  buildPluginSnapshotReportMock.mockReturnValue(defaultPluginReport);
  buildPluginRegistrySnapshotReportMock.mockReturnValue({
    ...defaultPluginReport,
    registrySource: "derived",
    registryDiagnostics: [],
  });
  buildPluginDiagnosticsReportMock.mockReturnValue(defaultPluginReport);
  buildPluginCompatibilityNoticesMock.mockReturnValue([]);
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
  inspectPluginRegistryMock.mockResolvedValue({
    state: "fresh",
    refreshReasons: [],
    persisted: defaultRegistryIndex,
    current: defaultRegistryIndex,
  });
  refreshPluginRegistryMock.mockResolvedValue(defaultRegistryIndex);
  notifyGatewayPluginMetadataChangedMock.mockResolvedValue(true);
  applyExclusiveSlotSelectionMock.mockImplementation((({ config }: { config: OpenClawConfig }) => ({
    config,
    warnings: [],
  })) as (...args: unknown[]) => unknown);
  planPluginUninstallMock.mockImplementation((({
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
  applyPluginUninstallDirectoryRemovalMock.mockResolvedValue({
    directoryRemoved: false,
    warnings: [],
  });
  updateNpmInstalledPluginsMock.mockResolvedValue({
    outcomes: [],
    changed: false,
    config: {} as OpenClawConfig,
  });
  updateNpmInstalledHookPacksMock.mockResolvedValue({
    outcomes: [],
    changed: false,
    config: {} as OpenClawConfig,
  });
  promptYesNoMock.mockResolvedValue(true);
  promptText.mockResolvedValue("demo");
  installPluginFromPathMock.mockResolvedValue({
    ok: false,
    error: "path install disabled in test",
  });
  installPluginFromGitSpecMock.mockResolvedValue({
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
  installPluginFromNpmSpecMock.mockResolvedValue({
    ok: false,
    error: "npm install disabled in test",
  });
  installPluginFromClawHubMock.mockResolvedValue({
    ok: false,
    error: "clawhub install disabled in test",
  });
  parseClawHubPluginSpecMock.mockReturnValue(null);
  installHooksFromPathMock.mockResolvedValue({
    ok: false,
    error: "hook path install disabled in test",
  });
  installHooksFromNpmSpecMock.mockResolvedValue({
    ok: false,
    error: "hook npm install disabled in test",
  });
  recordHookInstallMock.mockImplementation(
    ((cfg: OpenClawConfig) => cfg) as (...args: unknown[]) => unknown,
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
