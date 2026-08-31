// Update CLI tests cover update command behavior, runtime calls, and output handling.
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
} from "../daemon/constants.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { isBetaTag } from "../infra/update-channels.js";
import { applyDevUpdateTargetEnv } from "../infra/update-dev-target.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub-error-codes.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import { createCliRuntimeCapture, getMockCallOutput } from "./test-runtime-capture.js";

const confirm = vi.fn();
const select = vi.fn();
const text = vi.fn();
const spinner = vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), clear: vi.fn() }));
const isCancel = (value: unknown) => value === "cancel";

const readPackageName = vi.fn();
const readPackageVersion = vi.fn();
const resolveGlobalManager = vi.fn();
const serviceLoaded = vi.fn();
const serviceEnabled = vi.fn();
const serviceDefinitionMutationCapability = vi.fn();
const serviceStart = vi.fn();
const serviceStop = vi.fn();
const serviceRestart = vi.fn();
// A fixed Gateway PID can collide with the updater and trigger its self-stop safeguard.
const gatewayFixturePid = process.pid + 1;
const unrelatedGatewayFixturePid = process.pid + 2;

const suspendScheduledTaskAutoStartForUpdate = vi.fn();
const resumeScheduledTaskAutoStartAfterUpdate = vi.fn();
const prepareRestartScript = vi.fn();
const runRestartScript = vi.fn();
const mockedRunDaemonInstall = vi.fn();
const serviceReadCommand = vi.fn();
const serviceReadRuntime = vi.fn();
const mockGetSelfAndAncestorPidsSync = vi.fn(() => new Set<number>([process.pid]));
const terminateStaleGatewayPids = vi.fn();
const inspectPortUsage = vi.fn();
const classifyPortListener = vi.fn();
const formatPortDiagnostics = vi.fn();
const probeGateway = vi.fn();
const pathExists = vi.fn();
const syncPluginsForUpdateChannel = vi.fn();
const updateNpmInstalledPlugins = vi.fn();
const loadInstalledPluginIndexInstallRecords = vi.fn(
  async (params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv } = {}) =>
    params.config?.plugins?.installs ?? {},
);
const readPersistedInstalledPluginIndex = vi.fn(async () => null);
const restorePersistedInstalledPluginIndexIfCurrent = vi.fn<
  typeof import("../plugins/installed-plugin-index-store-write.js").restorePersistedInstalledPluginIndexIfCurrent
>(async () => true);
const writePersistedInstalledPluginIndexInstallRecords = vi.fn(async () => undefined);
const writePersistedInstalledPluginIndexInstallRecordsWithLease = vi.fn(async () => ({
  previous: null,
  revision: 1,
}));
const checkShellCompletionStatus = vi.fn();
const ensureCompletionCacheExists = vi.fn();
const installCompletion = vi.fn();
const createPreUpdateConfigSnapshotMock = vi.fn();
const legacyConfigRepairMocks = vi.hoisted(() => ({
  repairLegacyConfigForUpdateChannel: vi.fn(),
}));
const launchdUpdateCleanupMocks = vi.hoisted(() => ({
  disableCurrentOpenClawUpdateLaunchdJob: vi.fn(async () => false),
}));
const databasePreflightMocks = vi.hoisted(() => ({
  preflightOpenClawDatabaseSchemas: vi.fn(),
}));
const restartHealthTestControl = vi.hoisted(() => ({
  snapshot: undefined as unknown,
}));
const nodeVersionSatisfiesEngine = vi.fn();
const execFile = vi.fn((...args: unknown[]) => {
  const callback = args.at(-1);
  if (typeof callback === "function") {
    callback(null, new Date(Date.now() - 1000).toString(), "");
  }
  return new EventEmitter();
});
const spawn = vi.fn();
const { defaultRuntime: runtimeCapture, resetRuntimeCapture } = createCliRuntimeCapture();
const serviceEnvSnapshot = captureEnv([
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
]);

vi.mock("@clack/prompts", () => ({
  confirm,
  select,
  text,
  isCancel,
  spinner,
}));

// Mock the update-runner module
vi.mock("../infra/update-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-runner.js")>()),
  runGatewayUpdate: vi.fn(),
}));

vi.mock("../state/openclaw-database-preflight.js", () => ({
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL: "https://docs.openclaw.ai/reference/database-schemas",
  preflightOpenClawDatabaseSchemas: databasePreflightMocks.preflightOpenClawDatabaseSchemas,
}));

vi.mock("../state/openclaw-state-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-ownership.js")>()),
  assertOpenClawStateWriteAllowedAtPath: vi.fn(async () => undefined),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
  resolveOpenClawPackageRootSync: vi.fn(() => process.cwd()),
}));

vi.mock("../daemon/gateway-entrypoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/gateway-entrypoint.js")>();
  return {
    ...actual,
    resolveGatewayInstallEntrypoint: vi.fn(actual.resolveGatewayInstallEntrypoint),
  };
});

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
  ConfigMutationConflictError: class ConfigMutationConflictError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ConfigMutationConflictError";
    }
  },
  parseConfigJson5: (raw: string) => {
    try {
      return { ok: true, parsed: JSON.parse(raw) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
  readConfigFileSnapshot: vi.fn(),
  readSourceConfigBestEffort: vi.fn(),
  mutateConfigFileWithRetry: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
}));

vi.mock("../infra/update-check.js", async (importOriginal) => ({
  formatGitInstallLabel: (await importOriginal<typeof import("../infra/update-check.js")>())
    .formatGitInstallLabel,
  checkUpdateStatus: vi.fn(),
  resolveUpdateInstallKind: vi.fn(),
  resolveUpdateInstallIdentity: vi.fn(),
  compareSemverStrings: vi.fn((left: string | null, right: string | null) => {
    const parse = (value: string | null) => {
      if (!value) {
        return null;
      }
      const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!match) {
        return null;
      }
      return [
        Number.parseInt(match[1] ?? "0", 10),
        Number.parseInt(match[2] ?? "0", 10),
        Number.parseInt(match[3] ?? "0", 10),
      ] as const;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) {
      return null;
    }
    for (let index = 0; index < a.length; index += 1) {
      const diff =
        expectDefined(a[index], "a[index] test invariant") -
        expectDefined(b[index], "b[index] test invariant");
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }),
  fetchNpmTagVersion: vi.fn(),
  resolveExtendedStablePackage: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));

vi.mock("../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: vi.fn(),
}));

vi.mock("../infra/runtime-guard.js", () => ({
  nodeVersionSatisfiesEngine,
  parseSemver: (version: string | null) => {
    if (!version) {
      return null;
    }
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return null;
    }
    return {
      major: Number.parseInt(match[1] ?? "0", 10),
      minor: Number.parseInt(match[2] ?? "0", 10),
      patch: Number.parseInt(match[3] ?? "0", 10),
    };
  },
}));

vi.mock("../infra/restart-stale-pids.js", () => ({
  getSelfAndAncestorPidsSync: () => mockGetSelfAndAncestorPidsSync(),
  terminateStaleGatewayPids: (...args: unknown[]) => terminateStaleGatewayPids(...args),
}));

vi.mock("../infra/update-managed-service-handoff-cleanup.js", () => ({
  cleanupStaleManagedServiceUpdateHandoffs: vi.fn(async () => 0),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile,
    spawn,
    spawnSync: vi.fn(() => ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    })),
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
  runExec: vi.fn(async () => ({
    stdout: new Date(Date.now() - 1000).toString(),
    stderr: "",
  })),
}));

vi.mock("../utils.js", async (importOriginal) => {
  const [actual, { isRecord }] = await Promise.all([
    importOriginal<typeof import("../utils.js")>(),
    import("@openclaw/normalization-core/record-coerce"),
  ]);
  return {
    ...actual,
    displayString: (input: string) => input,
    isRecord,
    pathExists: (...args: unknown[]) => pathExists(...args),
    resolveConfigDir: () => "/tmp/openclaw-config",
    sleep: vi.fn(async () => undefined),
  };
});

vi.mock("../plugins/official-external-install-records.js", () => ({
  resolveTrustedSourceLinkedOfficialClawHubSpec: vi.fn(() => undefined),
  resolveTrustedSourceLinkedOfficialNpmSpec: vi.fn(() => undefined),
}));

vi.mock("../plugins/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/update.js")>();
  return {
    ...actual,
    syncPluginsForUpdateChannel: (...args: unknown[]) => syncPluginsForUpdateChannel(...args),
    updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPlugins(...args),
  };
});

vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords,
    writePersistedInstalledPluginIndexInstallRecords,
    writePersistedInstalledPluginIndexInstallRecordsWithLease,
  };
});

vi.mock("../plugins/installed-plugin-index-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-store.js")>();
  return {
    ...actual,
    readPersistedInstalledPluginIndex,
  };
});

vi.mock("../plugins/installed-plugin-index-store-write.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-store-write.js")>();
  return {
    ...actual,
    restorePersistedInstalledPluginIndexIfCurrent,
  };
});

vi.mock("./update-cli/post-core-plugin-convergence.js", () => ({
  convergenceWarningsToOutcomes: (convergence: {
    warnings: Array<{ pluginId?: string; message: string }>;
    errored: boolean;
  }) => ({
    warnings: convergence.warnings,
    outcomes: convergence.warnings
      .filter((warning): warning is { pluginId: string; message: string } =>
        Boolean(warning.pluginId),
      )
      .map((warning) => ({
        pluginId: warning.pluginId,
        status: "error",
        message: warning.message,
      })),
    errored: convergence.errored,
  }),
  runPostCorePluginConvergence: vi.fn(async (params: { baselineInstallRecords?: unknown }) => ({
    changes: [],
    warnings: [],
    errored: false,
    smokeFailures: [],
    installRecords: params.baselineInstallRecords ?? {},
  })),
}));

vi.mock("../config/backup-rotation.js", () => ({
  createPreUpdateConfigSnapshot: (...args: unknown[]) => createPreUpdateConfigSnapshotMock(...args),
}));

vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: async (
    _service: unknown,
    args?: {
      requireEffective?: boolean;
      validateEnvBeforeStatusRead?: (env: NodeJS.ProcessEnv) => void;
    },
  ) => {
    const command = await serviceReadCommand(
      args?.requireEffective ? { requireEffective: true } : undefined,
    );
    const env = {
      ...process.env,
      ...(process.platform === "win32" ? { PATH: path.dirname(process.execPath) } : undefined),
      ...(command && typeof command === "object" && "environment" in command
        ? (command.environment as NodeJS.ProcessEnv | undefined)
        : undefined),
    };
    args?.validateEnvBeforeStatusRead?.(env);
    const [loadState, runtime] = await Promise.all([
      serviceLoaded({ env })
        .then((loaded: boolean) =>
          loaded ? ({ status: "loaded" } as const) : ({ status: "not-loaded" } as const),
        )
        .catch((error: unknown) => ({ status: "unknown" as const, detail: String(error) })),
      serviceReadRuntime(env).catch(() => undefined),
    ]);
    return {
      installed: command !== null,
      loadState,
      running: runtime?.status === "running",
      env,
      command,
      runtime,
      definitionMutationCapability: await serviceDefinitionMutationCapability(),
    };
  },
  resolveGatewayService: vi.fn(() => ({
    isLoaded: (...args: unknown[]) => serviceLoaded(...args),
    isEnabled: (...args: unknown[]) => serviceEnabled(...args),
    readCommand: (...args: unknown[]) => serviceReadCommand(...args),
    readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
    start: (...args: unknown[]) => serviceStart(...args),
    stop: (...args: unknown[]) => serviceStop(...args),
    restart: (...args: unknown[]) => serviceRestart(...args),
  })),
}));

vi.mock("../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd.js")>()),
  disableCurrentOpenClawUpdateLaunchdJob:
    launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
}));

vi.mock("../daemon/schtasks.js", () => ({
  suspendScheduledTaskAutoStartForUpdate: (...args: unknown[]) =>
    suspendScheduledTaskAutoStartForUpdate(...args),
  resumeScheduledTaskAutoStartAfterUpdate: (...args: unknown[]) =>
    resumeScheduledTaskAutoStartAfterUpdate(...args),
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortUsage: (...args: unknown[]) => inspectPortUsage(...args),
}));

vi.mock("../infra/ports-format.js", () => ({
  classifyPortListener: (...args: unknown[]) => classifyPortListener(...args),
  formatPortDiagnostics: (...args: unknown[]) => formatPortDiagnostics(...args),
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: (...args: unknown[]) => probeGateway(...args),
}));

vi.mock("./update-cli/restart-helper.js", () => ({
  prepareRestartScript: (...args: unknown[]) => prepareRestartScript(...args),
  runRestartScript: (...args: unknown[]) => runRestartScript(...args),
}));

vi.mock("./daemon-cli/restart-health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon-cli/restart-health.js")>();
  return {
    ...actual,
    waitForGatewayHealthyRestart: (
      ...args: Parameters<typeof actual.waitForGatewayHealthyRestart>
    ) =>
      restartHealthTestControl.snapshot === undefined
        ? actual.waitForGatewayHealthyRestart(...args)
        : Promise.resolve(
            restartHealthTestControl.snapshot as Awaited<
              ReturnType<typeof actual.waitForGatewayHealthyRestart>
            >,
          ),
  };
});

// Mock doctor (heavy module; should not run in unit tests)
vi.mock("../commands/doctor.js", () => ({
  doctorCommand: vi.fn(),
}));
vi.mock("../commands/doctor-completion.js", () => ({
  checkShellCompletionStatus: (...args: unknown[]) => checkShellCompletionStatus(...args),
  ensureCompletionCacheExists: (...args: unknown[]) => ensureCompletionCacheExists(...args),
}));
vi.mock("../commands/doctor/legacy-config-repair.js", () => ({
  repairLegacyConfigForUpdateChannel: legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel,
}));
vi.mock("./completion-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./completion-runtime.js")>();
  return {
    ...actual,
    installCompletion: (...args: unknown[]) => installCompletion(...args),
  };
});
// Mock the daemon-cli module
vi.mock("./daemon-cli.js", () => ({
  runDaemonInstall: mockedRunDaemonInstall,
  runDaemonRestart: vi.fn(),
}));

// Mock the runtime
vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeCapture,
}));

const { runGatewayUpdate } = await import("../infra/update-runner.js");
const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
const { resolveGatewayInstallEntrypoint } = await import("../daemon/gateway-entrypoint.js");
const {
  mutateConfigFileWithRetry,
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
  replaceConfigFile,
} = await import("../config/config.js");
const {
  checkUpdateStatus,
  fetchNpmTagVersion,
  resolveExtendedStablePackage,
  resolveNpmChannelTag,
  resolveUpdateInstallKind,
  resolveUpdateInstallIdentity,
} = await import("../infra/update-check.js");
const { fetchNpmPackageTargetStatus } = await import("../infra/update-check-package-target.js");
const { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } =
  await import("../infra/update-control-plane-sentinel.js");
const { runCommandWithTimeout, runExec } = await import("../process/exec.js");
const { runDaemonRestart, runDaemonInstall } = await import("./daemon-cli.js");
const { doctorCommand } = await import("../commands/doctor.js");
const { defaultRuntime } = await import("../runtime.js");
const postCorePluginConvergence = await import("./update-cli/post-core-plugin-convergence.js");
const { completePostCorePluginUpdate } =
  await import("./update-cli/update-command-fresh-doctor.js");
const { continuePostCoreUpdateInFreshProcess } =
  await import("./update-cli/update-command-post-core.js");
const runPostCorePluginConvergenceSpy = vi.spyOn(
  postCorePluginConvergence,
  "runPostCorePluginConvergence",
);
const { registerUpdateCli } = await import("./update-cli.js");
const { updateCommand } = await import("./update-cli/update-command.js");
const { updateFinalizeCommand } = await import("./update-cli/update-command-finalize.js");
const { updateStatusCommand } = await import("./update-cli/status.js");
const { updateWizardCommand } = await import("./update-cli/wizard.js");
const updateCliShared = await import("./update-cli/shared.js");
const { resolveGitInstallDir } = updateCliShared;
const { spawnSync } = await import("node:child_process");
const { clearRestartSentinel, readRestartSentinel } = await import("../infra/restart-sentinel.js");

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

type UpdateCliScenario = {
  name: string;
  run: () => Promise<void>;
  assert: () => void;
};

describe("update-cli", () => {
  // Per-run unique root: concurrent runs on one machine (CI shards, sibling checkouts) must
  // never share fixture paths — some cases write real files and rm them in cleanup. Realpath'd
  // because macOS os.tmpdir() is a /var -> /private/var symlink.
  const fixtureRoot = fsSync.realpathSync(
    fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-tests-")),
  );
  const profileStateDir = (profile = "default") =>
    path.join(
      expectDefined(process.env.HOME, "isolated test home"),
      profile === "default" ? ".openclaw" : `.openclaw-${profile}`,
    );
  let fixtureCount = 0;
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const tempDirsToCleanup = new Set<string>();

  const createCaseDir = (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    // Callers that only need a stable path skip creating it; real-I/O callers mkdir themselves.
    return dir;
  };

  const baseConfig = {} as OpenClawConfig;
  const baseSnapshot: ConfigFileSnapshot = {
    path: "/tmp/openclaw-config.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: baseConfig,
    sourceConfig: baseConfig,
    valid: true,
    config: baseConfig,
    runtimeConfig: baseConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };

  const clawHubRiskWarning =
    "╭─ ClawHub Security Audit ─────────────────────────────────╮\n" +
    "│ Outcome: Review                                         │\n" +
    "╰───────────────────────────────────────────────────────────────────────╯";
  const clawHubSuspiciousPayloadWarning =
    "╭─ ClawHub Security Audit ─────────────────────────────────╮\n" +
    "│ Outcome: Review                                         │\n" +
    "│ Overview: Review the requested capabilities.             │\n" +
    "╰───────────────────────────────────────────────────────────────────────╯";
  const clawHubSyncRiskError =
    "Failed to update demo: ClawHub blocked this release; update was not started. (ClawHub clawhub:demo@1.2.4).";

  const setTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  };

  const setStdoutTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
    });
  };

  const mockPackageInstallStatus = (root: string) => {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(resolveUpdateInstallKind).mockResolvedValue("package");
    vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "package" });
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root,
      installKind: "package",
      packageManager: "npm",
      deps: {
        manager: "npm",
        status: "ok",
        lockfilePath: null,
        markerPath: null,
      },
    });
  };

  const mockPackageInstallAtCaseDir = (prefix = "openclaw-update") => {
    const root = createCaseDir(prefix);
    mockPackageInstallStatus(root);
    return root;
  };

  const primeNpmChannelTag = (tag: string, version: string | null): void => {
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag, version });
  };

  const primeServiceCommand = (
    programArguments: Array<string | undefined>,
    environment?: NodeJS.ProcessEnv,
  ): void => {
    const managedDefinition = {
      programArguments,
      ...(environment === undefined ? {} : { environment }),
    };
    serviceReadCommand.mockResolvedValue({
      ...managedDefinition,
      managedDefinition,
    });
  };

  const expectUpdateCallChannel = (channel: string) => {
    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.channel).toBe(channel);
    return call;
  };
  const commandCalls = () =>
    vi.mocked(runCommandWithTimeout).mock.calls as unknown as Array<
      [string[], Record<string, unknown>]
    >;

  const packageInstallCommandCall = () =>
    commandCalls().find(([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");

  const packagePackCommandCall = () =>
    commandCalls().find(([argv]) => argv[0] === "npm" && argv[1] === "pack");

  const stripOpenClawPackageAlias = (spec: string) => {
    const trimmed = spec.trim();
    return trimmed.toLowerCase().startsWith("openclaw@")
      ? trimmed.slice("openclaw@".length)
      : trimmed;
  };

  const isNpmGitPackageSpec = (spec: string) => {
    const target = stripOpenClawPackageAlias(spec);
    const [repo] = target.split("#", 1);
    const isGitHubShorthand =
      Boolean(repo) &&
      !expectDefined(repo, "repo test invariant").startsWith(".") &&
      !expectDefined(repo, "repo test invariant").startsWith("/") &&
      !expectDefined(repo, "repo test invariant").startsWith("@") &&
      expectDefined(repo, "repo test invariant").split("/").length === 2 &&
      expectDefined(repo, "repo test invariant")
        .split("/")
        .every((part) => /^[^\s/:@]+$/u.test(part));
    let isHttpGitUrl;
    try {
      const url = new URL(target);
      const pathname = url.pathname.replace(/\/+$/u, "");
      const pathParts = pathname.split("/").filter(Boolean);
      isHttpGitUrl =
        (url.protocol === "https:" || url.protocol === "http:") &&
        (pathname.endsWith(".git") ||
          (url.hostname.toLowerCase() === "github.com" && pathParts.length === 2));
    } catch {
      isHttpGitUrl = false;
    }
    return (
      /^github:/i.test(target) ||
      /^git(?:\+|:)/i.test(target) ||
      /^ssh:\/\//i.test(target) ||
      /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(target) ||
      isHttpGitUrl ||
      isGitHubShorthand
    );
  };

  const doctorCommandCall = () =>
    commandCalls().find(
      ([argv]) =>
        argv[2] === "doctor" &&
        argv[3] === "--non-interactive" &&
        (argv.length === 4 || argv[4] === "--fix"),
    );

  const doctorCommandCallIndex = () =>
    commandCalls().findIndex(
      ([argv]) =>
        argv[2] === "doctor" &&
        argv[3] === "--non-interactive" &&
        (argv.length === 4 || argv[4] === "--fix"),
    );

  const freshRestartCalls = () =>
    vi
      .mocked(runCommandWithTimeout)
      .mock.calls.filter(([argv]) => argv[2] === "gateway" && argv[3] === "restart");

  const gatewayCommandCall = (entryPath: string, action: "install" | "restart") =>
    commandCalls().find(
      ([argv]) => argv[1] === entryPath && argv[2] === "gateway" && argv[3] === action,
    );

  const spawnCall = (index = 0) => {
    const calls = spawn.mock.calls as unknown as Array<
      [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }]
    >;
    return calls[index];
  };

  const spawnSyncCall = (index = 0) => {
    const calls = vi.mocked(spawnSync).mock.calls as unknown as Array<
      [string, string[], { env?: NodeJS.ProcessEnv; timeout?: number }]
    >;
    return calls[index];
  };

  const syncPluginCall = (index = 0) => {
    const calls = syncPluginsForUpdateChannel.mock.calls as unknown as Array<
      [Record<string, unknown> & { channel?: string; config?: OpenClawConfig }]
    >;
    return calls[index]?.[0];
  };

  const npmPluginUpdateCall = (index = 0) => {
    const calls = updateNpmInstalledPlugins.mock.calls as unknown as Array<
      [Record<string, unknown> & { config?: OpenClawConfig; timeoutMs?: number }]
    >;
    return calls[index]?.[0];
  };
  const lastNpmPluginUpdateCall = () =>
    npmPluginUpdateCall(updateNpmInstalledPlugins.mock.calls.length - 1);

  const replaceConfigCall = (index = 0) => vi.mocked(replaceConfigFile).mock.calls[index]?.[0];
  const lastReplaceConfigCall = () =>
    replaceConfigCall(vi.mocked(replaceConfigFile).mock.calls.length - 1);
  const setupConfigMutationWithRetryMock = () => {
    vi.mocked(mutateConfigFileWithRetry).mockImplementation(async (params) => {
      const snapshot = await readConfigFileSnapshot();
      const nextConfig = structuredClone(snapshot.sourceConfig) as OpenClawConfig;
      await params.mutate(nextConfig, {
        snapshot,
        previousHash: snapshot.hash ?? null,
        attempt: 0,
      });
      await replaceConfigFile({
        nextConfig,
        ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
      });
      return {
        path: snapshot.path,
        previousHash: snapshot.hash ?? null,
        snapshot,
        nextConfig,
        persistedHash: snapshot.hash ?? null,
        result: undefined,
        attempts: 1,
        afterWrite: { mode: "none", reason: "test" },
        followUp: { mode: "none", reason: "test", requiresRestart: false },
      };
    });
  };

  const writeJsonCall = (index = 0) => vi.mocked(defaultRuntime.writeJson).mock.calls[index]?.[0];
  const lastWriteJsonCall = () =>
    writeJsonCall(vi.mocked(defaultRuntime.writeJson).mock.calls.length - 1);
  const getLogOutput = () => getMockCallOutput(vi.mocked(defaultRuntime.log));
  const getErrorOutput = () => getMockCallOutput(vi.mocked(defaultRuntime.error));
  const expectNoSideEffects = (...effects: unknown[]) => {
    for (const effect of effects) {
      expect(effect).not.toHaveBeenCalled();
    }
  };

  const probeGatewayCall = (index = 0) => probeGateway.mock.calls[index]?.[0];

  const pluginWarning = (result?: UpdateRunResult) => result?.postUpdate?.plugins?.warnings?.[0];
  const pluginOutcome = (result?: UpdateRunResult) => result?.postUpdate?.plugins?.npm.outcomes[0];

  const expectPackageInstallSpec = (spec: string) => {
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    let installSpec = spec;
    if (isNpmGitPackageSpec(spec)) {
      const packCall = packagePackCommandCall();
      expect(packCall?.[0]).toEqual([
        "npm",
        "pack",
        spec,
        "--pack-destination",
        expect.any(String),
        "--json",
        "--loglevel=error",
      ]);
      const packDir = packCall?.[0][4];
      if (!packDir) {
        throw new Error("Expected package pack directory");
      }
      installSpec = path.join(packDir, "openclaw-9999.0.0.tgz");
    } else {
      expect(packagePackCommandCall()).toBeUndefined();
    }
    const allowScriptsIdentity = isNpmGitPackageSpec(spec)
      ? `./${path.basename(installSpec)}`
      : spec.toLowerCase().startsWith("openclaw@")
        ? "openclaw"
        : spec;
    const call = packageInstallCommandCall();
    expect(call?.[0]).toEqual([
      "npm",
      "i",
      "-g",
      `--allow-scripts=${allowScriptsIdentity}`,
      installSpec,
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
      "--min-release-age=0",
    ]);
    if (call?.[1] === undefined) {
      throw new Error("Expected package install command options");
    }
  };

  const statfsFixture = (params: {
    bavail: number;
    bsize?: number;
    blocks?: number;
  }): ReturnType<typeof fsSync.statfsSync> => ({
    type: 0,
    bsize: params.bsize ?? 1024,
    blocks: params.blocks ?? 2_000_000,
    bfree: params.bavail,
    bavail: params.bavail,
    files: 0,
    frsize: params.bsize ?? 1024,
    ffree: 0,
  });

  const makeOkUpdateResult = (overrides: Partial<UpdateRunResult> = {}): UpdateRunResult =>
    ({
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
      ...overrides,
    }) as UpdateRunResult;

  const mockGitUpdateAfterMutation = (result = makeOkUpdateResult({ mode: "git" })) => {
    const preparations: Array<{
      allowGatewayServiceRepair?: boolean;
      allowGatewayActivation?: boolean;
    } | void> = [];
    vi.mocked(runGatewayUpdate).mockImplementationOnce(async (opts) => {
      preparations.push(await opts?.beforeGitMutation?.({}));
      return result;
    });
    return preparations;
  };

  const mockOwnedGitService = () => {
    const serviceEntrypoint = path.join(process.cwd(), "dist", "index.js");
    primeServiceCommand(["node", serviceEntrypoint, "gateway", "run"]);
    pathExists.mockImplementation(
      async (candidate: string) => candidate === path.join(process.cwd(), "package.json"),
    );
  };

  const runUpdateCliScenario = async (testCase: UpdateCliScenario) => {
    vi.clearAllMocks();
    await testCase.run();
    testCase.assert();
  };

  const runRestartFallbackScenario = async (params: { daemonInstall: "ok" | "fail" }) => {
    mockOwnedGitService();
    mockGitUpdateAfterMutation();
    if (params.daemonInstall === "fail") {
      vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));
    } else {
      vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    }
    prepareRestartScript.mockResolvedValue(null);
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({
      force: true,
      json: undefined,
    });
    expect(runDaemonRestart).toHaveBeenCalledTimes(1);
  };

  const setupNonInteractiveDowngrade = async () => {
    const tempDir = mockPackageInstallAtCaseDir();
    setTty(false);
    readPackageVersion.mockResolvedValue("2.0.0");
    primeNpmChannelTag(isBetaTag(VERSION) ? "beta" : "latest", "0.0.1");
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult({ mode: "npm" }));
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    return tempDir;
  };

  const setupUpdatedRootRefresh = (params?: {
    gatewayUpdateImpl?: (root: string) => Promise<UpdateRunResult>;
    entrypoints?: string[];
  }) => {
    const root = createCaseDir("openclaw-updated-root");
    const entrypoints = params?.entrypoints ?? [path.join(root, "dist", "entry.js")];
    const packageRoots = entrypoints.map((entrypoint) => path.dirname(path.dirname(entrypoint)));
    const packageJsonPaths = new Set(
      packageRoots.map((packageRoot) => path.join(packageRoot, "package.json")),
    );
    for (const entrypoint of entrypoints) {
      const packageRoot = path.dirname(path.dirname(entrypoint));
      const packageJsonPath = path.join(packageRoot, "package.json");
      fsSync.mkdirSync(path.dirname(entrypoint), { recursive: true });
      fsSync.writeFileSync(entrypoint, "// test entrypoint\n", "utf8");
      fsSync.writeFileSync(
        packageJsonPath,
        JSON.stringify({ name: "openclaw", version: "2026.4.24" }),
        "utf8",
      );
      tempDirsToCleanup.add(packageRoot);
    }
    pathExists.mockImplementation(
      async (candidate: string) =>
        packageJsonPaths.has(candidate) || entrypoints.includes(candidate),
    );
    if (params?.gatewayUpdateImpl) {
      vi.mocked(runGatewayUpdate).mockImplementation(() => params.gatewayUpdateImpl!(root));
    } else {
      vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult({ mode: "npm", root }));
    }
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", entrypoints[0], "gateway", "run"]);
    return { root, entrypoints };
  };

  const FRESH_POST_UPDATE_ENTRYPOINT = "/tmp/openclaw-updated-entry.mjs";

  const mockCurrentProcessFreshDoctor = (params: { postCoreResumeAttempt?: boolean } = {}) => {
    if (params.postCoreResumeAttempt !== false) {
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(undefined);
    }
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
  };

  const expectFreshPostUpdateDoctor = (params: {
    yes: boolean;
    workspaceSuggestions?: boolean;
  }) => {
    const calls = vi
      .mocked(runExec)
      .mock.calls.filter(
        ([, args]) => args[0] === FRESH_POST_UPDATE_ENTRYPOINT && args[1] === "doctor",
      );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual([
      FRESH_POST_UPDATE_ENTRYPOINT,
      "doctor",
      "--repair",
      "--non-interactive",
      ...(params.workspaceSuggestions ? [] : ["--no-workspace-suggestions"]),
      ...(params.yes ? ["--yes"] : []),
    ]);
  };

  const commandResult = (
    overrides: Partial<{
      stdout: string;
      stderr: string;
      code: number;
      signal: NodeJS.Signals | null;
      killed: boolean;
      termination: "exit" | "timeout";
    }> = {},
  ) => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
    ...overrides,
  });

  const mockNpmGlobalCommands = (
    nodeModules: string,
    handle?: (
      ...args: Parameters<typeof runCommandWithTimeout>
    ) =>
      | Awaited<ReturnType<typeof runCommandWithTimeout>>
      | undefined
      | Promise<Awaited<ReturnType<typeof runCommandWithTimeout>> | undefined>,
    sourceCheckout?: string,
  ) => {
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      const handled = await handle?.(argv, options);
      if (handled !== undefined) {
        return handled;
      }
      if (sourceCheckout && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        expect(argv).toContain(sourceCheckout);
        const stagePrefix = requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
        const stageRoot = path.join(stagePrefix, "lib", "node_modules");
        await fs.mkdir(stageRoot, { recursive: true });
        await fs.symlink(
          sourceCheckout,
          path.join(stageRoot, "openclaw"),
          process.platform === "win32" ? "junction" : undefined,
        );
      }
      if (argv[0] === "npm" && argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return commandResult({ stdout: `${nodeModules}\n` });
      }
      return commandResult();
    });
  };

  const packageTargetStatus = (
    overrides: Partial<{
      target: string;
      version: string | null;
      nodeEngine: string | null;
      schemaVersions: { state: number; agent: number };
      error: string;
    }> = {},
  ) => ({
    target: "9999.0.0",
    version: "9999.0.0",
    nodeEngine: ">=22.19.0",
    ...overrides,
  });

  const mockFileBackedPathExists = () => {
    pathExists.mockImplementation(async (candidate: string) => {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    });
  };

  const pluginSyncResult = (
    config: OpenClawConfig,
    changed = false,
    overrides: { warnings?: string[]; errors?: string[] } = {},
  ) => ({
    changed,
    config,
    summary: {
      switchedToBundled: [],
      switchedToClawHub: [],
      switchedToNpm: [],
      warnings: [],
      errors: [],
      ...overrides,
    },
  });

  const npmPluginUpdateResult = (config: OpenClawConfig) => ({
    changed: false,
    config,
    outcomes: [],
  });

  const mockNpmPluginOutcomes = (outcomes: unknown[], changed = false) => {
    updateNpmInstalledPlugins.mockResolvedValueOnce({ changed, config: baseConfig, outcomes });
  };

  const postCoreConvergenceResult = (
    overrides: Partial<{
      changes: string[];
      warnings: Array<{ pluginId?: string; reason: string; message: string; guidance: string[] }>;
      errored: boolean;
    }> = {},
  ) => ({
    changes: [],
    warnings: [],
    errored: false,
    smokeFailures: [],
    installRecords: {},
    ...overrides,
  });

  const mockNoopPostUpdatePluginConvergence = () => {
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) => pluginSyncResult(config));
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );
  };

  const mockPostDoctorSnapshot = (
    configPath: string,
    config: OpenClawConfig,
    options: { preserveParsed?: boolean } = {},
  ) => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      path: configPath,
      ...(options.preserveParsed ? {} : { parsed: config }),
      sourceConfig: config,
      config,
      runtimeConfig: config,
      hash: "post-doctor-hash",
    });
  };

  const configSnapshot = (
    config: OpenClawConfig,
    overrides: Partial<ConfigFileSnapshot> = {},
  ): ConfigFileSnapshot => ({
    ...baseSnapshot,
    parsed: config,
    resolved: config,
    sourceConfig: config,
    config,
    runtimeConfig: config,
    ...overrides,
  });

  const stableConfig = (overrides: Omit<OpenClawConfig, "update"> = {}): OpenClawConfig => ({
    update: { channel: "stable" },
    ...overrides,
  });

  const stableWhatsAppConfig = (): OpenClawConfig =>
    stableConfig({
      channels: {
        whatsapp: { enabled: true, dmPolicy: "pairing" },
      },
    });

  const runPostCoreUpdate = (env: NodeJS.ProcessEnv = {}) => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    return withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        ...env,
      },
      async () => {
        await updateCommand({ yes: true, restart: false });
      },
    );
  };

  const runPostCoreCommand = (
    options: Parameters<typeof updateCommand>[0],
    env: NodeJS.ProcessEnv = {},
  ) => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    return withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        ...env,
      },
      async () => {
        await updateCommand(options);
      },
    );
  };

  const writeJsonFixture = (
    filePath: string,
    value: unknown,
    trailingNewline = true,
  ): Promise<void> =>
    fs.writeFile(filePath, `${JSON.stringify(value)}${trailingNewline ? "\n" : ""}`, "utf-8");

  const writeOpenClawPackageFixture = async (
    root: string,
    version: string,
    options: {
      entryPath?: string;
      entrySource?: string;
      git?: boolean;
      builtSha?: string;
      inventory?: boolean;
    } = {},
  ) => {
    const entryPath = options.entryPath ?? path.join(root, "dist", "index.js");
    await fs.mkdir(options.entrySource === undefined ? root : path.dirname(entryPath), {
      recursive: true,
    });
    if (options.git) {
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
    }
    await writeJsonFixture(path.join(root, "package.json"), { name: "openclaw", version }, false);
    if (options.entrySource !== undefined) {
      await fs.writeFile(entryPath, options.entrySource, "utf-8");
    }
    if (options.builtSha) {
      for (const dir of ["src", "extensions", "dist/control-ui/assets"]) {
        await fs.mkdir(path.join(root, dir), { recursive: true });
      }
      for (const [file, contents] of Object.entries({
        "openclaw.mjs": "export {};\n",
        "dist/entry.js": "export {};\n",
        "dist/build-info.json": JSON.stringify({ commit: options.builtSha }),
        "dist/.buildstamp": JSON.stringify({ head: options.builtSha }),
        "dist/.runtime-postbuildstamp": JSON.stringify({ head: options.builtSha }),
        "dist/control-ui/index.html": '<script src="./assets/startup.js"></script>',
        "dist/control-ui/assets/startup.js": "export {};\n",
      })) {
        await fs.writeFile(path.join(root, file), contents);
      }
    }
    if (options.inventory) {
      await writePackageDistInventory(root);
    }
    return entryPath;
  };

  const setupPostCoreConfigFixture = async (params: {
    backupConfig?: OpenClawConfig;
    postDoctorConfig: OpenClawConfig;
    preUpdateConfig?: OpenClawConfig;
    snapshotSuffix?: ".bak" | ".pre-update";
    preserveParsed?: boolean;
  }) => {
    const tempDir = createCaseDir("openclaw-update");
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.mkdir(tempDir, { recursive: true });
    if (params.preUpdateConfig) {
      await writeJsonFixture(
        `${configPath}${params.snapshotSuffix ?? ".pre-update"}`,
        params.preUpdateConfig,
      );
    }
    if (params.backupConfig) {
      await writeJsonFixture(`${configPath}.bak`, params.backupConfig);
    }
    await writeJsonFixture(configPath, params.postDoctorConfig);
    mockPostDoctorSnapshot(configPath, params.postDoctorConfig, {
      preserveParsed: params.preserveParsed,
    });
    mockNoopPostUpdatePluginConvergence();
    return { tempDir, configPath };
  };

  const setupInstalledPackageAtNodeModules = async (nodeModules: string, version = "2026.4.21") => {
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(pkgRoot);
    const entryPath = await writeOpenClawPackageFixture(pkgRoot, version, {
      entrySource: "export {};\n",
      inventory: true,
    });
    return { nodeModules, pkgRoot, entryPath };
  };

  const setupInstalledPackageRoot = (baseDir: string, version = "2026.4.21") =>
    setupInstalledPackageAtNodeModules(path.join(baseDir, "node_modules"), version);

  const setupServicePackageAtPrefix = async (params: {
    prefix: string;
    version?: string;
    withNpm?: boolean;
  }) => {
    const nodeModules = path.join(params.prefix, "lib", "node_modules");
    const root = path.join(nodeModules, "openclaw");
    const serviceNode = path.join(params.prefix, "bin", "node");
    const serviceNpm = path.join(params.prefix, "bin", "npm");
    await fs.mkdir(path.dirname(serviceNode), { recursive: true });
    await fs.writeFile(serviceNode, "#!/bin/sh\n", { encoding: "utf-8", mode: 0o755 });
    const serviceNpmReal =
      params.withNpm === false
        ? undefined
        : await fs.writeFile(serviceNpm, "", "utf-8").then(() => fs.realpath(serviceNpm));
    const entrypoint = await writeOpenClawPackageFixture(root, params.version ?? "2026.5.18", {
      entrySource: "",
      inventory: true,
    });
    return { nodeModules, root, serviceNode, serviceNpm, serviceNpmReal, entrypoint };
  };

  const mockServicePackageCommands = (params: {
    nodeModules: string;
    packageRoot: string;
    targetVersion: string;
    npmCommands: string[];
    nodeVersions: Record<string, string>;
  }) => {
    const npmCommands = new Set(params.npmCommands);
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      const command = argv[0] ?? "";
      if (argv[1] === "--version" && params.nodeVersions[command]) {
        return commandResult({ stdout: `${params.nodeVersions[command]}\n` });
      }
      if (npmCommands.has(command) && argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (npmCommands.has(command) && argv[1] === "root" && argv[2] === "-g") {
        return commandResult({ stdout: `${params.nodeModules}\n` });
      }
      if (npmCommands.has(command) && argv[1] === "i") {
        const stagePrefix = argv.includes("--prefix")
          ? argv[argv.indexOf("--prefix") + 1]
          : undefined;
        const stageRoot = stagePrefix
          ? path.join(stagePrefix, "lib", "node_modules", "openclaw")
          : params.packageRoot;
        await writeOpenClawPackageFixture(stageRoot, params.targetVersion, {
          entrySource: "export {};\n",
          inventory: true,
        });
      }
      return commandResult();
    });
  };

  const mockRunningManagedGateway = (
    programArguments: string[] = ["openclaw", "gateway", "run"],
  ) => {
    serviceReadCommand.mockResolvedValue({
      programArguments,
      environment: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
  };

  const mockStoppedManagedGitGateway = () => {
    mockRunningManagedGateway([
      "node",
      path.join(process.cwd(), "dist", "index.js"),
      "gateway",
      "run",
    ]);
    serviceLoaded.mockImplementation(async () => serviceStop.mock.calls.length === 0);
    serviceReadRuntime.mockImplementation(async () =>
      serviceStop.mock.calls.length === 0
        ? { status: "running", pid: gatewayFixturePid, state: "running" }
        : { status: "stopped", pid: null, state: "stopped" },
    );
  };

  const expectFailedManagedGitRestart = (message: string) => {
    const logs = getLogOutput();
    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(runRestartScript).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect([logs, ...vi.mocked(defaultRuntime.error).mock.calls.flat()].join("\n")).toContain(
      message,
    );
    expect(logs).not.toContain("Gateway: restarted and verified.");
    expect(logs).not.toContain("Update Result: OK");
  };

  const mockGatewayProbe = (version: string, connId: string) => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version, connId },
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
      connectLatencyMs: 1,
      error: null,
      url: "ws://127.0.0.1:18789",
    });
  };

  const completeChangedPostCorePluginUpdate = (
    overrides: Partial<Parameters<typeof completePostCorePluginUpdate>[0]> = {},
  ) =>
    completePostCorePluginUpdate({
      root: "/tmp/openclaw-updated-root",
      pluginUpdate: {
        status: "ok",
        changed: true,
        warnings: [],
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: { changed: true, outcomes: [] },
        integrityDrifts: [],
      },
      freshDoctorRequired: true,
      yes: true,
      json: true,
      timeoutMs: 30_000,
      ...overrides,
    });

  const setupNpmUpdatedRootRefresh = () => {
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    setupUpdatedRootRefresh({
      entrypoints: [updatedEntrypoint],
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.23" },
          after: { version: "2026.4.24" },
        }),
    });
    return { updatedRoot, updatedEntrypoint };
  };

  const mockNpmGlobalRoot = (nodeModules: string) => {
    mockNpmGlobalCommands(nodeModules);
  };

  const mockPackageReplacementFailure = (message: string) => {
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        throw new Error(message);
      }
      return commandResult();
    });
  };

  const mockGatewayInstallFailure = (entrypoint: string) => {
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      const failed = argv[1] === entrypoint && argv[2] === "gateway" && argv[3] === "install";
      return commandResult({
        stderr: failed ? "launchctl bootstrap failed" : "",
        code: failed ? 1 : 0,
      });
    });
  };

  const runWithGatewayServiceEnv = (
    options: Parameters<typeof updateCommand>[0],
    env: NodeJS.ProcessEnv = {},
  ) =>
    withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        ...env,
      },
      async () => {
        await updateCommand(options);
      },
    );

  const runControlPlaneUpdate = async (params: {
    meta: Record<string, unknown>;
    options: Parameters<typeof updateCommand>[0];
    beforeUpdate?: () => void | Promise<void>;
  }) => {
    const home = tempDirs.make("openclaw-update-sentinel-home-");
    const stateDir = path.join(home, ".openclaw");
    await fs.mkdir(stateDir);
    const metaDir = tempDirs.make("openclaw-update-sentinel-meta-");
    const metaPath = path.join(metaDir, "meta.json");
    await writeJsonFixture(metaPath, { version: 1, meta: params.meta }, false);
    await params.beforeUpdate?.();
    await withEnvAsync(
      {
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
      },
      async () => {
        await updateCommand(params.options);
      },
    );
    return readRestartSentinel({ OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
  };

  beforeEach(async () => {
    const gatewayEntrypoint = await import("../daemon/gateway-entrypoint.js");
    const actualGatewayEntrypoint = await vi.importActual<
      typeof import("../daemon/gateway-entrypoint.js")
    >("../daemon/gateway-entrypoint.js");
    vi.mocked(gatewayEntrypoint.resolveGatewayInstallEntrypoint).mockImplementation(
      actualGatewayEntrypoint.resolveGatewayInstallEntrypoint,
    );
    delete process.env.OPENCLAW_SERVICE_MARKER;
    delete process.env.OPENCLAW_SERVICE_KIND;
    delete process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV];
    for (const key of GATEWAY_SERVICE_SELECTOR_ENV_KEYS) {
      delete process.env[key];
    }
    restartHealthTestControl.snapshot = undefined;
    vi.resetAllMocks();
    serviceEnabled.mockResolvedValue(true);
    serviceDefinitionMutationCapability.mockResolvedValue(undefined);
    readPersistedInstalledPluginIndex.mockResolvedValue(null);
    restorePersistedInstalledPluginIndexIfCurrent.mockResolvedValue(true);
    writePersistedInstalledPluginIndexInstallRecords.mockResolvedValue(undefined);
    writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
      previous: null,
      revision: 1,
    });
    resetRuntimeCapture();
    spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child;
    });
    vi.mocked(defaultRuntime.exit).mockImplementation(() => {});
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [],
      indeterminate: [],
    });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    vi.mocked(readSourceConfigBestEffort).mockResolvedValue(baseSnapshot.config);
    setupConfigMutationWithRetryMock();
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(fetchNpmPackageTargetStatus).mockImplementation(async ({ target }) => ({
      target,
      version: /^\d/u.test(target) ? target : "9999.0.0",
      nodeEngine: ">=22.19.0",
    }));
    vi.mocked(resolveExtendedStablePackage).mockResolvedValue({
      status: "resolved",
      selector: "extended-stable",
      version: "2026.6.33",
      packageSpec: "openclaw@2026.6.33",
    });
    primeNpmChannelTag("latest", "9999.0.0");
    nodeVersionSatisfiesEngine.mockReturnValue(true);
    vi.mocked(resolveUpdateInstallKind).mockResolvedValue("git");
    vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({
      installKind: "git",
      git: { tag: "v1.2.3", branch: "main" },
    });
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/test/path",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/test/path",
        sha: "abcdef1234567890",
        tag: "v1.2.3",
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 0,
        fetchOk: true,
      },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "/test/path/pnpm-lock.yaml",
        markerPath: "/test/path/node_modules",
      },
      registry: {
        latestVersion: "1.2.3",
      },
    });
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (argv[0] === "npm" && argv[1] === "pack") {
        const destination = argv[argv.indexOf("--pack-destination") + 1];
        if (destination) {
          await fs.writeFile(path.join(destination, "openclaw-9999.0.0.tgz"), "packed\n", "utf8");
        }
      }
      return commandResult();
    });
    vi.spyOn(updateCliShared, "readPackageName").mockImplementation(readPackageName);
    vi.spyOn(updateCliShared, "readPackageVersion").mockImplementation(readPackageVersion);
    vi.spyOn(updateCliShared, "resolveGlobalManager").mockImplementation(resolveGlobalManager);
    readPackageName.mockResolvedValue("openclaw");
    readPackageVersion.mockResolvedValue("1.0.0");
    resolveGlobalManager.mockResolvedValue("npm");
    serviceStart.mockResolvedValue(undefined);
    serviceStop.mockResolvedValue(undefined);
    terminateStaleGatewayPids.mockResolvedValue(undefined);
    serviceRestart.mockResolvedValue({ outcome: "completed" });
    mockSystemAccountHome();
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(false);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(false);
    serviceLoaded.mockResolvedValue(false);
    serviceReadCommand.mockImplementation(async () =>
      (await serviceLoaded()) ? { programArguments: ["openclaw", "gateway", "run"] } : null,
    );
    serviceReadRuntime.mockImplementation(async () =>
      (await serviceLoaded())
        ? { status: "running", pid: gatewayFixturePid, state: "running" }
        : { status: "stopped", state: "stopped", missingUnit: true },
    );
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid]));
    prepareRestartScript.mockResolvedValue("/tmp/openclaw-restart-test.sh");
    runRestartScript.mockResolvedValue(undefined);
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: gatewayFixturePid, command: "openclaw-gateway" }],
      hints: [],
    });
    classifyPortListener.mockReturnValue("gateway");
    formatPortDiagnostics.mockReturnValue(["Port 18789 is already in use."]);
    mockGatewayProbe("1.0.0", "conn-test");
    pathExists.mockResolvedValue(false);
    syncPluginsForUpdateChannel.mockResolvedValue(pluginSyncResult(baseConfig));
    updateNpmInstalledPlugins.mockResolvedValue(npmPluginUpdateResult(baseConfig));
    checkShellCompletionStatus.mockResolvedValue({
      shell: "zsh",
      profileInstalled: false,
      cacheExists: false,
      cachePath: "/tmp/openclaw-completion.zsh",
      usesSlowPattern: false,
    });
    ensureCompletionCacheExists.mockResolvedValue(true);
    installCompletion.mockResolvedValue(undefined);
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);
    vi.mocked(doctorCommand).mockResolvedValue(undefined);
    legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementation(
      async (params: { configSnapshot: ConfigFileSnapshot }) => ({
        snapshot: params.configSnapshot,
        repaired: false,
      }),
    );
    launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mockReset();
    launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mockResolvedValue(false);
    confirm.mockResolvedValue(false);
    select.mockResolvedValue("stable");
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    setTty(false);
    setStdoutTty(false);
  });

  afterAll(async () => {
    serviceEnvSnapshot.restore();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempDirsToCleanup.size === 0) {
      return;
    }
    await Promise.allSettled(
      [...tempDirsToCleanup].map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
    tempDirsToCleanup.clear();
  });

  it("recovers a stopped sealed service after a restart-safe failure", async () => {
    mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
    serviceDefinitionMutationCapability.mockResolvedValue({ kind: "sealed", detail: "root owner" });
    const {
      maybeStopManagedServiceBeforeMutableUpdate,
      maybeRestartServiceAfterFailedMutableUpdate,
    } = await import("./update-cli/update-command-service.js");
    const before = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "git",
      shouldRestart: true,
      jsonMode: true,
    });
    await maybeRestartServiceAfterFailedMutableUpdate({
      preManagedServiceStop: before,
      jsonMode: true,
    });
    expect(serviceRestart).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: "git", restart: false },
    { kind: "git", restart: true },
    { kind: "package", restart: false },
    { kind: "package", restart: true },
  ] as const)(
    "handles $kind with restart=$restart when service inspection is unavailable",
    async ({ kind, restart }) => {
      if (kind === "package") {
        mockPackageInstallAtCaseDir();
        mockCurrentProcessFreshDoctor();
      } else {
        mockGitUpdateAfterMutation();
      }
      serviceReadCommand.mockRejectedValue(new Error("inspection-secret-canary"));

      await updateCommand({ yes: true, json: true, restart });

      if (restart) {
        expect(runGatewayUpdate).not.toHaveBeenCalled();
        expect(packageInstallCommandCall()).toBeUndefined();
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
        expect(getErrorOutput()).toContain(
          "Gateway service inspection is unavailable. Refusing to mutate code",
        );
        expect(getErrorOutput()).toContain("gateway status --deep");
        expect(getErrorOutput()).toContain("stop the Gateway manually before the update");
        expect(lastWriteJsonCall()).not.toMatchObject({ status: "ok" });
      } else {
        if (kind === "package") {
          expectPackageInstallSpec("openclaw@9999.0.0");
        } else {
          expect(runGatewayUpdate).toHaveBeenCalledOnce();
        }
        expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
        expect(getErrorOutput()).toContain(
          "Gateway service management skipped: inspection is unavailable",
        );
        expect(getErrorOutput()).toContain("gateway status --deep");
        expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
      }
      expectNoSideEffects(
        serviceStop,
        serviceStart,
        serviceRestart,
        runDaemonInstall,
        runDaemonRestart,
        prepareRestartScript,
        runRestartScript,
      );
      expect(getErrorOutput()).not.toContain("inspection-secret-canary");
    },
  );

  it("refuses a restart-enabled update when service load inspection is unknown", async () => {
    mockRunningManagedGateway();
    mockGitUpdateAfterMutation();
    serviceLoaded.mockRejectedValue(new Error("load-state-secret-canary"));

    await updateCommand({ yes: true, json: true });

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(getErrorOutput()).toContain(
      "Gateway service inspection is unavailable. Refusing to mutate code",
    );
    expect(getErrorOutput()).not.toContain("load-state-secret-canary");
  });

  it.each([
    { kind: "git", restart: false, capability: "sealed" },
    { kind: "git", restart: true, capability: "sealed" },
    { kind: "package", restart: false, capability: "sealed" },
    { kind: "package", restart: true, capability: "sealed" },
    { kind: "git", restart: true, capability: "unknown" },
    { kind: "package", restart: true, capability: "unknown" },
  ] as const)(
    "updates $kind with stale $capability metadata and restart=$restart",
    async ({ kind, restart, capability }) => {
      const root =
        kind === "package" ? createCaseDir("openclaw-sealed-code-update") : process.cwd();
      const entrypoint =
        kind === "package"
          ? await writeOpenClawPackageFixture(root, "1.0.0", {
              entrySource: "export {};\n",
              inventory: true,
            })
          : path.join(root, "dist", "index.js");
      if (kind === "package") {
        mockPackageInstallStatus(root);
        mockCurrentProcessFreshDoctor();
        mockGatewayProbe("9999.0.0", "updated-service");
      } else {
        mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root }));
      }
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
      // No managed mode, token, or env-key metadata: this must not become an install-plan veto.
      mockRunningManagedGateway(["node", entrypoint, "gateway", "--port", "18789"]);
      serviceDefinitionMutationCapability.mockResolvedValue({
        kind: capability,
        detail: "definition-owner-secret-canary",
      });

      await updateCommand({ yes: true, json: true, restart });

      if (kind === "package") {
        expectPackageInstallSpec("openclaw@9999.0.0");
      } else {
        expect(runGatewayUpdate).toHaveBeenCalledOnce();
      }
      expect(serviceStop).toHaveBeenCalledTimes(restart ? 1 : 0);
      expect(freshRestartCalls().length).toBe(restart ? 1 : 0);
      expect(serviceStart).not.toHaveBeenCalled();
      expectNoSideEffects(
        runDaemonInstall,
        runDaemonRestart,
        prepareRestartScript,
        runRestartScript,
      );
      expect(getErrorOutput()).toContain("service definition left unchanged");
      expect(getErrorOutput()).not.toContain("definition-owner-secret-canary");
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
    },
  );

  it.each([
    ["sealed", "writable"],
    ["writable", "unknown"],
  ] as const)(
    "retains activation but not refresh when authority changes %s -> %s",
    async (beforeKind, afterKind) => {
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
      serviceDefinitionMutationCapability.mockResolvedValue({ kind: beforeKind, detail: "owner" });
      const {
        maybeStopManagedServiceBeforeMutableUpdate,
        revalidateManagedGatewayServiceAfterUpdate,
      } = await import("./update-cli/update-command-service.js");
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "git",
        shouldRestart: true,
        jsonMode: true,
      });
      serviceDefinitionMutationCapability.mockResolvedValue({ kind: afterKind, detail: "owner" });
      const { readGatewayServiceState, resolveGatewayService } =
        await import("../daemon/service.js");
      const state = await readGatewayServiceState(resolveGatewayService(), {
        requireEffective: true,
      });
      await expect(
        revalidateManagedGatewayServiceAfterUpdate({
          state,
          root: process.cwd(),
          preManagedServiceStop: before,
        }),
      ).resolves.toMatchObject({ kind: "owned", refreshDefinition: false });
    },
  );

  it.each(["unchanged", "changed", "unreadable"] as const)(
    "recovers stopped unresolved services only with unchanged inspection (%s)",
    async (inspection) => {
      mockRunningManagedGateway();
      const {
        maybeStopManagedServiceBeforeMutableUpdate,
        maybeRestartServiceAfterFailedMutableUpdate,
      } = await import("./update-cli/update-command-service.js");
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "git",
        shouldRestart: true,
        jsonMode: true,
      });
      expect(before).toMatchObject({
        stopped: true,
        serviceUpdateVerdict: { kind: "unresolved" },
      });
      if (inspection === "changed") {
        mockRunningManagedGateway(["foreign-openclaw", "gateway", "run"]);
      } else if (inspection === "unreadable") {
        serviceReadCommand.mockRejectedValueOnce(new Error("manager unavailable"));
      }

      await maybeRestartServiceAfterFailedMutableUpdate({
        preManagedServiceStop: before,
        jsonMode: true,
      });

      expect(serviceRestart).toHaveBeenCalledTimes(inspection === "unchanged" ? 1 : 0);
      if (inspection !== "unchanged") {
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining("Failed to restart managed gateway service after failed update"),
        );
      }
    },
  );

  it("fails sealed-service activation without claiming a successful restart", async () => {
    vi.mocked(runCommandWithTimeout).mockResolvedValueOnce(
      commandResult({ code: 1, stderr: "systemctl restart denied" }),
    );
    const { maybeRestartService } = await import("./update-cli/update-command-service.js");
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue("/updated/dist/index.js");

    await expect(
      maybeRestartService({
        channel: "stable",
        shouldRestart: true,
        result: makeOkUpdateResult({ mode: "npm", after: { version: "2026.4.24" } }),
        opts: { json: true },
        refreshServiceEnv: false,
        serviceUpdateVerdict: {
          kind: "owned",
          root: process.cwd(),
          refreshDefinition: false,
          fingerprint: "sealed",
        },
        serviceEnv: { MANAGED_VALUE: "revalidated" },
        gatewayPort: 18789,
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(false);

    expect(freshRestartCalls().length).toBe(1);
    expect(serviceStart).not.toHaveBeenCalled();
    expectNoSideEffects(runRestartScript, runDaemonInstall, runDaemonRestart, serviceRestart);
  });

  it("reads the initial update config without schema validation or observation", async () => {
    await updateCommand({ yes: true, restart: false });

    expect(vi.mocked(readConfigFileSnapshot).mock.calls[0]?.[0]).toEqual({
      skipPluginValidation: true,
      observe: false,
    });
  });

  it("bounds completion cache refresh during update follow-up", async () => {
    const root = createCaseDir("openclaw-completion-timeout");
    pathExists.mockResolvedValue(true);

    await updateCliShared.tryWriteCompletionCache(root, false);

    const call = spawnSyncCall();
    expect(typeof call?.[0]).toBe("string");
    expect(call?.[1]).toEqual([path.join(root, "openclaw.mjs"), "completion", "--write-state"]);
    expect(call?.[2]?.env?.OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS).toBe("1");
    expect(call?.[2]?.timeout).toBe(30_000);
  });

  it("disarms legacy launchd updater jobs before refusing mutating updates in Nix mode", async () => {
    await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
      await expect(updateCommand({ yes: true })).rejects.toThrow("OPENCLAW_NIX_MODE=1");
    });

    expect(launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob).toHaveBeenCalledOnce();
    expectNoSideEffects(runGatewayUpdate, replaceConfigFile, updateNpmInstalledPlugins);
  });

  it("delegates mutating updates when an external supervisor owns gateway lifecycle", async () => {
    await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
      await updateCommand({ yes: true });
    });

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(runtimeCapture.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Use the external supervisor's update workflow so it can stop the gateway",
      ),
    );
    expectNoSideEffects(
      runGatewayUpdate,
      readConfigFileSnapshot,
      replaceConfigFile,
      updateNpmInstalledPlugins,
    );
  });

  it("logs friendly hint with manual refresh command when completion cache write times out", async () => {
    const root = createCaseDir("openclaw-completion-timeout-msg");
    pathExists.mockResolvedValue(true);
    const timeoutErr = Object.assign(new Error("spawnSync /usr/bin/node ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: timeoutErr,
    });
    vi.mocked(runtimeCapture.log).mockClear();

    await updateCliShared.tryWriteCompletionCache(root, false);

    const logOutput = getLogOutput();
    expect(logOutput).toContain("timed out after 30s");
    expect(logOutput).toContain("openclaw completion --write-state");
    expect(logOutput).not.toContain("Error: spawnSync");
  });

  it("keeps update completion refresh best-effort when profile install fails", async () => {
    setTty(true);
    checkShellCompletionStatus.mockResolvedValue({
      shell: "zsh",
      profileInstalled: true,
      cacheExists: true,
      cachePath: "/tmp/openclaw-completion.zsh",
      usesSlowPattern: true,
    });
    installCompletion.mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await updateCommand({ yes: true, restart: false });

    const logOutput = getLogOutput();
    expect(logOutput).toContain("Shell completion refresh failed: EACCES: permission denied");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it.each([true, false])("honors --yes=%s for optional shell completion setup", async (yes) => {
    setTty(true);
    confirm.mockResolvedValue(true);

    await updateCommand({ yes, restart: false });

    expect(confirm).toHaveBeenCalledTimes(yes ? 0 : 1);
    if (yes) {
      expect(installCompletion).not.toHaveBeenCalled();
    } else {
      expect(installCompletion).toHaveBeenCalledWith("zsh", false, "openclaw");
    }
  });

  it("respawns into the updated package root before running post-update tasks", async () => {
    const { entrypoints } = setupUpdatedRootRefresh();

    await updateCommand({ yes: true, timeout: "1800" });

    const call = spawnCall();
    expect(call?.[0]).toMatch(/node/);
    expect(call?.[1]).toEqual([entrypoints[0], "update", "--yes", "--timeout", "1800"]);
    expect(call?.[2]?.stdio).toBe("inherit");
    expect(call?.[2]?.env?.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe("dev");
    expect(call?.[2]?.env?.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("1.0.0");
    expect(vi.mocked(readConfigFileSnapshot).mock.calls[1]?.[0]).toEqual({
      skipPluginValidation: true,
      suppressFutureVersionWarning: true,
    });
    expectNoSideEffects(updateNpmInstalledPlugins, runDaemonInstall, runDaemonRestart);
  });

  it("isolates stale handoff values at the post-core CLI spawn boundary", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    readPackageVersion.mockResolvedValueOnce(null);

    await withEnvAsync(
      {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "stale-version",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "beta",
        OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: "/tmp/stale-config.json",
        OPENCLAW_UNRELATED: "preserved",
      },
      async () => {
        await continuePostCoreUpdateInFreshProcess({
          root: "/tmp/openclaw-updated-root",
          channel: "stable",
          requestedChannel: null,
          opts: {},
          pluginInstallRecords: {},
          updateStartedAtMs: 123,
          timeoutMs: 30_000,
        });

        const env = spawnCall()?.[2]?.env;
        expect(env?.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        expect(env?.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBeUndefined();
        expect(env?.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH).toBeUndefined();
        expect(env?.OPENCLAW_UNRELATED).toBe("preserved");
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("stale-version");
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBe("beta");
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH).toBe(
          "/tmp/stale-config.json",
        );
      },
    );
  });

  it("keeps stopped owned-service config and plugin state through fresh post-core handoff", async () => {
    const { root, entrypoints } = setupUpdatedRootRefresh();
    mockOwnedGitService();
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root,
        before: { sha: "old-managed-sha", version: "2026.4.26" },
        after: { sha: "new-managed-sha", version: "2026.4.27" },
      }),
    );
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === path.join(process.cwd(), "package.json") ||
        candidate === path.join(root, "package.json") ||
        entrypoints.includes(candidate),
    );
    const managedState = profileStateDir("work");
    const personalState = profileStateDir("personal");
    const managedConfig = {
      ...baseConfig,
      update: { channel: "beta" as const },
    };
    const managedSnapshot = configSnapshot(managedConfig, {
      path: path.join(managedState, "openclaw.json"),
    });
    const managedRecords = {
      telegram: { source: "npm", spec: "@openclaw/telegram@beta" },
    } satisfies Record<string, PluginInstallRecord>;
    primeServiceCommand(["node", path.join(process.cwd(), "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: managedState,
      OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: "19222",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(unrelatedGatewayFixturePid),
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    vi.mocked(readConfigFileSnapshot).mockImplementation(async () =>
      process.env.OPENCLAW_PROFILE === "work" ? managedSnapshot : baseSnapshot,
    );
    loadInstalledPluginIndexInstallRecords.mockImplementation(async (options = {}) =>
      options.env?.OPENCLAW_PROFILE === "work" ? managedRecords : {},
    );
    let handedConfig: unknown;
    let handedRecords: unknown;
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      handedConfig = JSON.parse(
        fsSync.readFileSync(env?.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH ?? "", "utf-8"),
      );
      handedRecords = JSON.parse(
        fsSync.readFileSync(env?.OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH ?? "", "utf-8"),
      );
      const child = new EventEmitter() as EventEmitter & { once: EventEmitter["once"] };
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: personalState,
        OPENCLAW_CONFIG_PATH: path.join(personalState, "openclaw.json"),
        OPENCLAW_GATEWAY_PORT: "19111",
      },
      async () => {
        await updateCommand({ yes: true });
      },
    );

    expect(serviceStop).toHaveBeenCalledOnce();
    expect(spawnCall()?.[2]?.env).toMatchObject({
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: managedState,
      OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: "19222",
    });
    expect(spawnCall()?.[2]?.env?.OPENCLAW_SERVICE_MARKER).toBeUndefined();
    expect(spawnCall()?.[2]?.env?.[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBeUndefined();
    expect(handedConfig).toEqual({ sourceConfig: managedConfig, authoredConfig: managedConfig });
    expect(handedRecords).toEqual(managedRecords);
  });

  it("keeps foreign-service updates in the caller profile", async () => {
    const personalState = profileStateDir("personal");
    const { root, entrypoints } = setupUpdatedRootRefresh();
    const foreignRoot = tempDirs.make("openclaw-update-foreign-profile-");
    const foreignEntrypoint = await writeOpenClawPackageFixture(foreignRoot, "2026.4.21", {
      entrySource: "export {};\n",
    });
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root,
        before: { sha: "old-caller-sha", version: "2026.4.26" },
        after: { sha: "new-caller-sha", version: "2026.4.27" },
      }),
    );
    serviceReadCommand.mockResolvedValue({
      programArguments: ["node", foreignEntrypoint, "gateway", "run"],
      environment: {
        OPENCLAW_PROFILE: "foreign",
        OPENCLAW_STATE_DIR: profileStateDir("foreign"),
        OPENCLAW_GATEWAY_PORT: "19333",
      },
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    pathExists.mockImplementation(
      async (candidate: string) =>
        entrypoints.includes(candidate) || candidate.endsWith("package.json"),
    );

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: personalState,
        OPENCLAW_GATEWAY_PORT: "19111",
      },
      async () => {
        await updateCommand({ yes: true });
      },
    );

    expect(serviceStop).not.toHaveBeenCalled();
    expect(serviceEnabled).not.toHaveBeenCalled();
    expect(spawnCall()?.[2]?.env).toMatchObject({
      OPENCLAW_PROFILE: "personal",
      OPENCLAW_STATE_DIR: personalState,
      OPENCLAW_GATEWAY_PORT: "19111",
    });
  });

  it("keeps forced post-core fallback and fresh validation in the stopped service profile", async () => {
    const { root } = setupUpdatedRootRefresh();
    mockOwnedGitService();
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root,
        before: { sha: "old-managed-sha", version: "2026.4.26" },
        after: { sha: "new-managed-sha", version: "2026.4.27" },
      }),
    );
    const managedState = profileStateDir("work");
    primeServiceCommand(["node", path.join(process.cwd(), "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: managedState,
      OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: "19222",
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(undefined);
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    const convergenceProfiles: Array<string | undefined> = [];
    syncPluginsForUpdateChannel.mockImplementation(async () => {
      convergenceProfiles.push(process.env.OPENCLAW_PROFILE);
      return pluginSyncResult(baseConfig);
    });

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: profileStateDir("personal"),
        OPENCLAW_GATEWAY_PORT: "19111",
      },
      async () => {
        await updateCommand({ yes: true });
        expect(process.env.OPENCLAW_PROFILE).toBe("personal");
      },
    );

    expect(convergenceProfiles).toEqual(["work"]);
    const freshCalls = vi
      .mocked(runExec)
      .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? ""));
    expect(freshCalls).toHaveLength(2);
    for (const call of freshCalls) {
      const options = call[2];
      const baseEnv = typeof options === "number" ? undefined : options?.baseEnv;
      expect(baseEnv).toMatchObject({
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: managedState,
        OPENCLAW_GATEWAY_PORT: "19222",
      });
    }
  });

  it("finishes a human restart without rerunning stale doctor or leaking the service profile", async () => {
    mockOwnedGitService();
    mockGitUpdateAfterMutation();
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === path.join(process.cwd(), "package.json") ||
        candidate === path.join(process.cwd(), "openclaw.mjs"),
    );
    const managedState = profileStateDir("work");
    primeServiceCommand(["node", path.join(process.cwd(), "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: managedState,
      OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: "19222",
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    prepareRestartScript.mockResolvedValue(null);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: profileStateDir("personal"),
        OPENCLAW_GATEWAY_PORT: "19111",
      },
      async () => {
        await updateCommand({});
        expect(process.env.OPENCLAW_PROFILE).toBe("personal");
      },
    );

    expect(doctorCommand).not.toHaveBeenCalled();
    expect(runDaemonRestart).toHaveBeenCalledOnce();
    const completionCall = vi
      .mocked(spawnSync)
      .mock.calls.find(([, args]) => args?.[1] === "completion");
    expect(completionCall?.[2]?.env?.OPENCLAW_PROFILE).toBe("personal");
  });

  it("routes JSON post-core child output to stderr", async () => {
    const { entrypoints } = setupUpdatedRootRefresh();
    const stdoutPipe = vi.fn();
    const stderrPipe = vi.fn();
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
        stdout: { pipe: typeof stdoutPipe };
        stderr: { pipe: typeof stderrPipe };
      };
      child.stdout = { pipe: stdoutPipe };
      child.stderr = { pipe: stderrPipe };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child;
    });

    await updateCommand({ json: true, restart: false });

    const call = spawnCall();
    expect(call?.[1]).toEqual([entrypoints[0], "update", "--json", "--no-restart"]);
    expect(call?.[2]?.stdio).toBe("pipe");
    expect(stdoutPipe).toHaveBeenCalledWith(process.stderr);
    expect(stdoutPipe).not.toHaveBeenCalledWith(process.stdout);
    expect(stderrPipe).toHaveBeenCalledWith(process.stderr);
  });

  it("stops a post-core process with open handles only once when result reads overlap", async () => {
    setupUpdatedRootRefresh();
    const kill = vi.fn();
    let resultPath: string | undefined;
    const readsReady = createDeferred();
    const releaseReads = createDeferred();
    const jsonFiles = await import("../infra/json-files.js");
    const readJsonIfExists = jsonFiles.readJsonIfExists;
    const pendingReads: Promise<unknown>[] = [];
    let resultReads = 0;
    const readSpy = vi
      .spyOn(jsonFiles, "readJsonIfExists")
      .mockImplementation(<T>(...args: Parameters<typeof readJsonIfExists>) => {
        const read = readJsonIfExists<T>(...args).then(async (result) => {
          if (args[0] === resultPath) {
            if (++resultReads === 2) {
              readsReady.resolve();
            }
            await releaseReads.promise;
          }
          return result;
        });
        pendingReads.push(read);
        return read;
      });
    spawn.mockImplementationOnce((_command: unknown, _argv: unknown, options: unknown) => {
      resultPath = (options as { env?: NodeJS.ProcessEnv }).env
        ?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
      if (!resultPath) {
        throw new Error("missing post-core result path");
      }
      fsSync.writeFileSync(resultPath, `${JSON.stringify({ status: "ok" })}\n`, "utf-8");
      const child = new EventEmitter() as EventEmitter & {
        kill: typeof kill;
        once: EventEmitter["once"];
      };
      child.kill = kill;
      return child;
    });

    const updating = updateCommand({ yes: true, restart: false });
    try {
      await Promise.race([
        readsReady.promise,
        updating.then(() => {
          throw new Error("update finished before overlapping result reads");
        }),
      ]);
      releaseReads.resolve();
      await updating;
      await Promise.all(pendingReads);

      expect(kill).toHaveBeenCalledTimes(1);
      expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    } finally {
      releaseReads.resolve();
      await Promise.allSettled([updating, ...pendingReads]);
      readSpy.mockRestore();
    }
  });

  it("does not restart a stopped managed gateway after post-core plugin errors", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
    const root = createCaseDir("openclaw-update");
    const entryPath = path.join(root, "dist", "index.js");
    mockPackageInstallStatus(root);
    serviceLoaded.mockResolvedValue(true);
    pathExists.mockImplementation(async (candidate: string) => candidate === entryPath);
    spawn.mockImplementationOnce((_command: unknown, _argv: unknown, options: unknown) => {
      const resultPath = (options as { env?: NodeJS.ProcessEnv }).env
        ?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
      if (!resultPath) {
        throw new Error("missing post-core result path");
      }
      queueMicrotask(() => {
        void fs.writeFile(
          resultPath,
          JSON.stringify({
            status: "error",
            changed: false,
            warnings: [
              {
                pluginId: "demo",
                reason: "missing-extension-entry: ./dist/index.js",
                message:
                  'Plugin "demo" failed post-core payload smoke check (missing-extension-entry): ./dist/index.js',
                guidance: ["Run openclaw update repair to retry post-update plugin repair."],
              },
            ],
            sync: {
              changed: false,
              switchedToBundled: [],
              switchedToNpm: [],
              warnings: [],
              errors: [],
            },
            npm: {
              changed: false,
              outcomes: [
                {
                  pluginId: "demo",
                  status: "error",
                  message: "Plugin extension entry missing",
                },
              ],
            },
            integrityDrifts: [],
          }),
          "utf-8",
        );
      });
      const child = new EventEmitter() as EventEmitter & {
        kill: () => boolean;
        once: EventEmitter["once"];
      };
      child.kill = vi.fn(() => true);
      return child;
    });

    await updateCommand({ yes: true });
    platformSpy.mockRestore();

    expect(serviceStop).toHaveBeenCalled();
    expectNoSideEffects(serviceRestart, runDaemonRestart);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(getLogOutput()).not.toContain("Update Result: OK");
    expect(
      requireValue(spawn.mock.invocationCallOrder[0], "post-core update process order"),
    ).toBeLessThan(
      requireValue(
        resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0],
        "Scheduled Task resume order",
      ),
    );
  });

  it("does not carry gateway service markers into the post-core update process", async () => {
    setupUpdatedRootRefresh();

    await runWithGatewayServiceEnv(
      { yes: true },
      { [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(unrelatedGatewayFixturePid) },
    );

    const spawnEnv = spawnCall()?.[2]?.env;
    expect(spawnEnv?.OPENCLAW_SERVICE_MARKER).toBeUndefined();
    expect(spawnEnv?.OPENCLAW_SERVICE_KIND).toBeUndefined();
    expect(spawnEnv?.[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBeUndefined();
  });

  it("passes pre-update plugin install records into the post-core update process", async () => {
    setupUpdatedRootRefresh();
    const pluginInstallRecords = {
      demo: {
        source: "npm",
        spec: "@openclaw/demo@1.0.0",
        installPath: "/tmp/openclaw-demo-plugin",
      },
    } as const;
    const preUpdateConfig = {
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "pairing",
        },
      },
    } as OpenClawConfig;
    let capturedRecords: unknown;
    let capturedSourceConfig: unknown;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(
      configSnapshot(preUpdateConfig, { resolved: baseConfig }),
    );
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(pluginInstallRecords);
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      const recordsPath = env?.OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH;
      const sourceConfigPath = env?.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH;
      if (!recordsPath) {
        throw new Error("missing post-core install records path");
      }
      if (!sourceConfigPath) {
        throw new Error("missing post-core source config path");
      }
      capturedRecords = JSON.parse(fsSync.readFileSync(recordsPath, "utf-8"));
      capturedSourceConfig = JSON.parse(fsSync.readFileSync(sourceConfigPath, "utf-8"));
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child;
    });

    await updateCommand({ yes: true, restart: false });

    expect(capturedRecords).toEqual(pluginInstallRecords);
    expect(capturedSourceConfig).toEqual({
      sourceConfig: preUpdateConfig,
      authoredConfig: preUpdateConfig,
    });
    expectNoSideEffects(syncPluginsForUpdateChannel, updateNpmInstalledPlugins);
  });

  it("clears stale npm resolution metadata before post-core downgrade resume", async () => {
    const { root } = setupUpdatedRootRefresh();
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === root ? "0.0.1" : "2026.5.28",
    );
    const preUpdateConfig = {
      plugins: {
        entries: {
          msteams: { enabled: false },
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(preUpdateConfig));
    const pluginInstallRecords = {
      msteams: {
        source: "npm",
        spec: "@openclaw/msteams",
        installPath: "/tmp/openclaw-msteams-plugin",
        version: "1.0.0",
        resolvedName: "@openclaw/msteams",
        resolvedVersion: "1.0.0",
        resolvedSpec: "@openclaw/msteams@1.0.0",
        integrity: "sha512-newer",
      },
    } as const;
    let capturedRecords: unknown;
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(pluginInstallRecords);
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      const recordsPath = env?.OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH;
      if (!recordsPath) {
        throw new Error("missing post-core install records path");
      }
      capturedRecords = JSON.parse(fsSync.readFileSync(recordsPath, "utf-8"));
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child;
    });

    await updateCommand({ yes: true, restart: false });

    expect(capturedRecords).toEqual({
      msteams: {
        source: "npm",
        spec: "@openclaw/msteams",
        installPath: "/tmp/openclaw-msteams-plugin",
        version: "1.0.0",
        resolvedName: "@openclaw/msteams",
        integrity: "sha512-newer",
      },
    });
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledWith(
      capturedRecords,
      {
        config: preUpdateConfig,
        lease: expect.anything(),
      },
    );
    expect(restorePersistedInstalledPluginIndexIfCurrent).not.toHaveBeenCalled();
  });

  it("restores the exact plugin index revision when post-core handoff fails", async () => {
    const { root } = setupUpdatedRootRefresh();
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === root ? "0.0.1" : "2026.5.28",
    );
    const previousPersistedIndex = {
      policyHash: "previous-policy",
      installRecords: {
        msteams: {
          source: "npm",
          spec: "@openclaw/msteams",
          resolvedVersion: "1.0.0",
        },
      } satisfies Record<string, PluginInstallRecord>,
    };
    writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
      previous: previousPersistedIndex as never,
      revision: 17,
    });
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(
      previousPersistedIndex.installRecords,
    );
    spawn.mockImplementationOnce(() => {
      throw new Error("post-core spawn failed");
    });

    await expect(updateCommand({ yes: true, restart: false })).rejects.toThrow(
      "post-core spawn failed",
    );

    expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledTimes(1);
    expect(restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
      previousPersistedIndex,
      17,
      { lease: expect.anything() },
    );
  });

  it("honors a committed post-core result when stopping the child delivers a signal", async () => {
    // The poll owns the settle: it stops the child only after claiming the result. Stopping
    // delivers SIGTERM, so an unclaimed exit handler would reject an update the child already
    // committed and then roll its plugin index back.
    const { root } = setupUpdatedRootRefresh();
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === root ? "0.0.1" : "2026.5.28",
    );
    spawn.mockImplementationOnce((_command: string, _args: string[], options: unknown) => {
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      const resultPath = expectDefined(
        (options as { env: Record<string, string> }).env["OPENCLAW_UPDATE_POST_CORE_RESULT_PATH"],
        "post-core result path test invariant",
      );
      fsSync.writeFileSync(resultPath, JSON.stringify({ status: "ok" }), "utf8");
      child.kill = () => {
        child.emit("exit", null, "SIGTERM");
      };
      return child;
    });

    await expect(updateCommand({ yes: true, restart: false })).resolves.not.toThrow();
  });

  it("keeps a child-committed plugin index when the post-core handoff is signaled", async () => {
    const { root } = setupUpdatedRootRefresh();
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === root ? "0.0.1" : "2026.5.28",
    );
    const previousPersistedIndex = {
      policyHash: "previous-policy",
      installRecords: {
        msteams: {
          source: "npm",
          spec: "@openclaw/msteams",
          resolvedVersion: "1.0.0",
        },
      } satisfies Record<string, PluginInstallRecord>,
    };
    let currentRevision = 17;
    writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
      previous: previousPersistedIndex as never,
      revision: currentRevision,
    });
    restorePersistedInstalledPluginIndexIfCurrent.mockImplementation(
      async (_index, expectedRevision) => {
        if (currentRevision !== expectedRevision) {
          return false;
        }
        currentRevision += 1;
        return true;
      },
    );
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(
      previousPersistedIndex.installRecords,
    );
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      currentRevision = 18;
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
      });
      return child;
    });

    await expect(updateCommand({ yes: true, restart: false })).rejects.toThrow(
      "post-update process terminated by signal SIGTERM",
    );

    expect(restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
      previousPersistedIndex,
      17,
      { lease: expect.anything() },
    );
    expect(currentRevision).toBe(18);
  });

  it("respawns into the updated git root before requested channel persistence", async () => {
    const { entrypoints } = setupUpdatedRootRefresh({
      gatewayUpdateImpl: async (root) =>
        makeOkUpdateResult({
          mode: "git",
          root,
          before: { sha: "old-sha", version: "2026.4.26" },
          after: { sha: "new-sha", version: "2026.4.27" },
        }),
    });

    await updateCommand({ channel: "dev", yes: true, restart: false });

    const call = spawnCall();
    expect(call?.[0]).toMatch(/node/);
    expect(call?.[1]).toEqual([entrypoints[0], "update", "--no-restart", "--yes"]);
    expect(call?.[2]?.stdio).toBe("inherit");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe("dev");
    expect(call?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBe("dev");
    expectNoSideEffects(replaceConfigFile, syncPluginsForUpdateChannel, updateNpmInstalledPlugins);
  });

  it("carries explicit capability consent into post-core plugin convergence", async () => {
    const { entrypoints } = setupUpdatedRootRefresh({
      gatewayUpdateImpl: async (root) =>
        makeOkUpdateResult({
          mode: "git",
          root,
          before: { sha: "old-sha", version: "2026.4.26" },
          after: { sha: "new-sha", version: "2026.4.27" },
        }),
    });
    vi.mocked(runExec).mockResolvedValueOnce({
      stdout: new Command("update").option("--accept-capabilities").helpInformation(),
      stderr: "",
    });

    await updateCommand({ acceptCapabilities: true, yes: true, restart: false });

    expect(spawnCall()?.[1]).toEqual([
      entrypoints[0],
      "update",
      "--no-restart",
      "--yes",
      "--accept-capabilities",
    ]);
  });

  it.each([
    { acceptCapabilities: true, supported: true, resumed: true },
    { acceptCapabilities: true, supported: false, resumed: false },
    { acceptCapabilities: false, supported: false, resumed: true },
  ])(
    "checks target consent support before handoff (explicit=$acceptCapabilities, supported=$supported)",
    async ({ acceptCapabilities, supported, resumed }) => {
      const { root, entrypoints } = setupUpdatedRootRefresh();
      readPackageVersion.mockResolvedValue(VERSION);
      const targetCommand = new Command("update");
      if (supported) {
        targetCommand.option("--accept-capabilities");
      }
      vi.mocked(runExec).mockResolvedValue({ stdout: targetCommand.helpInformation(), stderr: "" });

      const result = await continuePostCoreUpdateInFreshProcess({
        root,
        channel: "stable",
        requestedChannel: null,
        opts: { acceptCapabilities, restart: false },
        pluginInstallRecords: {},
        updateStartedAtMs: Date.now(),
        timeoutMs: 30_000,
      });

      expect(result).toEqual({ resumed });
      if (acceptCapabilities) {
        expect(runExec).toHaveBeenCalledWith(
          expect.any(String),
          [entrypoints[0], "update", "--help"],
          expect.objectContaining({ timeoutMs: 30_000, logOutput: false }),
        );
      } else {
        expect(runExec).not.toHaveBeenCalled();
      }
      if (resumed) {
        expect(spawnCall()?.[1]).toEqual([
          entrypoints[0],
          "update",
          "--no-restart",
          ...(acceptCapabilities ? ["--accept-capabilities"] : []),
        ]);
      } else {
        expect(spawn).not.toHaveBeenCalled();
      }
    },
  );

  it("does not treat failed target consent help as an unsupported option", async () => {
    const { root } = setupUpdatedRootRefresh();
    const failure = new Error("target help failed");
    vi.mocked(runExec).mockRejectedValueOnce(failure);

    await expect(
      continuePostCoreUpdateInFreshProcess({
        root,
        channel: "stable",
        requestedChannel: null,
        opts: { acceptCapabilities: true },
        pluginInstallRecords: {},
        updateStartedAtMs: Date.now(),
        timeoutMs: 30_000,
      }),
    ).rejects.toBe(failure);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps downgrade post-update work in the current process", async () => {
    const downgradedRoot = createCaseDir("openclaw-downgraded-root");
    setupUpdatedRootRefresh({
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: downgradedRoot,
          before: { version: "2026.4.14" },
          after: { version: "2026.4.10" },
        }),
    });
    readPackageVersion.mockResolvedValue("2026.4.14");
    primeNpmChannelTag("latest", "2026.4.10");
    mockCurrentProcessFreshDoctor();

    await updateCommand({ yes: true, tag: "2026.4.10", restart: false });

    expect(spawn).not.toHaveBeenCalled();
    expect(syncPluginsForUpdateChannel).toHaveBeenCalledTimes(1);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expectFreshPostUpdateDoctor({ yes: true });
    expectNoSideEffects(runDaemonInstall, probeGateway);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it.each([false, true])(
    "keeps downgrade consent separate from --yes (explicit=%s)",
    async (acceptCapabilities) => {
      const downgradedRoot = createCaseDir("openclaw-downgraded-consent-root");
      setupUpdatedRootRefresh({
        gatewayUpdateImpl: async () =>
          makeOkUpdateResult({
            mode: "npm",
            root: downgradedRoot,
            before: { version: "2026.4.14" },
            after: { version: "2026.4.10" },
          }),
      });
      readPackageVersion.mockResolvedValue("2026.4.14");
      primeNpmChannelTag("latest", "2026.4.10");
      mockCurrentProcessFreshDoctor();

      await updateCommand({
        acceptCapabilities,
        yes: true,
        tag: "2026.4.10",
        restart: false,
      });

      const handler = npmPluginUpdateCall()?.onCapabilityConsent as
        | ((review: { reviewToken: string }) => Promise<{ reviewToken: string }>)
        | undefined;
      if (acceptCapabilities) {
        await expect(handler?.({ reviewToken: "reviewed-surface" })).resolves.toEqual({
          reviewToken: "reviewed-surface",
        });
      } else {
        expect(handler).toBeUndefined();
      }
      expect(syncPluginCall()?.onCapabilityConsent).toBe(handler);
    },
  );

  it("pins the compatibility host version to the downgraded target during current-process post-core plugin convergence (#87914)", async () => {
    const downgradedRoot = createCaseDir("openclaw-downgraded-compat-root");
    setupUpdatedRootRefresh({
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: downgradedRoot,
          before: { version: "2026.4.14" },
          after: { version: "2026.4.10" },
        }),
    });
    // The old core is still installed at the invocation root; the freshly
    // installed downgraded target lives at the post-update root.
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === downgradedRoot ? "2026.4.10" : "2026.4.14",
    );
    primeNpmChannelTag("latest", "2026.4.10");

    delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    let hostVersionDuringPluginUpdate: string | undefined = "unset";
    updateNpmInstalledPlugins.mockImplementation(async () => {
      hostVersionDuringPluginUpdate = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
      return { changed: false, config: baseConfig, outcomes: [] };
    });

    try {
      await updateCommand({ yes: true, tag: "2026.4.10", restart: false });

      expect(spawn).not.toHaveBeenCalled();
      expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
      // Compatibility is evaluated against the downgraded target core, not the
      // still-running old VERSION, so incompatible newer plugins are disabled
      // before restart.
      expect(hostVersionDuringPluginUpdate).toBe("2026.4.10");
      expect(runPostCorePluginConvergenceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ compatibilityHostVersion: "2026.4.10" }),
      );
      // The override is scoped to the plugin convergence and restored afterward.
      expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
    } finally {
      delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    }
  });

  it("runs updated plugin migrations for a plugin-only current-process update", async () => {
    mockGitUpdateAfterMutation();
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    mockNpmPluginOutcomes([], true);
    let strictValidationEnv: string | undefined;
    vi.mocked(readConfigFileSnapshot).mockImplementation(async (options) => {
      if (!options) {
        strictValidationEnv = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
      }
      return baseSnapshot;
    });
    vi.mocked(runExec).mockImplementationOnce(async (_file, args) => {
      expect(args).toEqual([
        "/tmp/openclaw-updated-entry.mjs",
        "doctor",
        "--repair",
        "--non-interactive",
        "--no-workspace-suggestions",
        "--yes",
      ]);
      return { stdout: "", stderr: "" };
    });

    await updateCommand({ yes: true, restart: false });

    expect(spawn).not.toHaveBeenCalled();
    expect(resolveGatewayInstallEntrypoint).toHaveBeenCalledTimes(1);
    expect(runExec).toHaveBeenCalledTimes(2);
    expect(strictValidationEnv).toBe("0");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("runs the final fresh doctor for convergence-only current-process changes", async () => {
    mockGitUpdateAfterMutation();
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    runPostCorePluginConvergenceSpy.mockResolvedValueOnce(
      postCoreConvergenceResult({
        changes: ["Repaired configured plugin install records."],
      }),
    );

    await updateCommand({ yes: true, restart: false });

    expect(spawn).not.toHaveBeenCalled();
    const doctorCall = vi.mocked(runExec).mock.calls.find(([, args]) => args[1] === "doctor");
    expect(doctorCall?.[2]).toMatchObject({
      env: { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
    });
    const strictValidationCall = vi
      .mocked(runExec)
      .mock.calls.find(([, args]) => args[1] === "config" && args[2] === "validate");
    expect(strictValidationCall?.[2]).toMatchObject({
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" },
    });
  });

  it("runs the fresh plugin doctor with the selected Node runner", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    await completeChangedPostCorePluginUpdate({ nodeRunner: "/opt/openclaw-service/bin/node" });

    expect(vi.mocked(runExec).mock.calls[0]?.[0]).toBe("/opt/openclaw-service/bin/node");
  });

  it("runs the fresh plugin doctor when the migration owner changed even if config is valid", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate.status).toBe("ok");
    expect(runExec).toHaveBeenCalledTimes(2);
    expect(resolveGatewayInstallEntrypoint).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error when the fresh plugin doctor cannot run", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    vi.mocked(runExec).mockRejectedValueOnce(new Error("doctor process failed"));
    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-doctor-execution-failed",
    });
    expect(result.pluginUpdate.warnings?.at(-1)?.reason).toContain("doctor process failed");
  });

  it("keeps an invalid config authoritative after a fresh plugin doctor failure", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    vi.mocked(runExec)
      .mockRejectedValueOnce(new Error("doctor process failed"))
      .mockRejectedValueOnce(new Error("config invalid"));
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce(
      configSnapshot(baseConfig, {
        valid: false,
        issues: [{ path: "channels.signal.httpUrl", message: "legacy Signal transport field" }],
      }),
    );

    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-doctor-invalid-config",
    });
  });

  it("keeps entrypoint resolution failures structured and fail-closed", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockRejectedValueOnce(
      new Error("entrypoint lookup failed"),
    );

    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-doctor-invalid-config",
    });
    expect(result.pluginUpdate.warnings?.[0]?.reason).toContain("entrypoint lookup failed");
    expect(runExec).not.toHaveBeenCalled();
  });

  it("fails the update when the fresh process exits non-zero", async () => {
    setupUpdatedRootRefresh();
    spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      queueMicrotask(() => {
        child.emit("exit", 2, null);
      });
      return child;
    });

    await updateCommand({ yes: true, json: true });

    expect(defaultRuntime.exit).toHaveBeenCalledWith(2);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "post-core-update-failed",
    });
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it("post-core resume mode skips the core update and only runs post-update tasks", async () => {
    await runPostCoreCommand({ restart: false }, { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" });

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    const installCall = (
      vi.mocked(runCommandWithTimeout).mock.calls as unknown as Array<[string[], unknown]>
    ).find(([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");
    expect(installCall).toBeUndefined();
    expect(
      vi
        .mocked(readConfigFileSnapshot)
        .mock.calls.some(
          ([options]) =>
            options?.skipPluginValidation === true && options.suppressFutureVersionWarning === true,
        ),
    ).toBe(true);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
    expectFreshPostUpdateDoctor({ yes: false });
    const freshDoctorCall = vi
      .mocked(runExec)
      .mock.calls.find(
        ([, args]) => args[0] === FRESH_POST_UPDATE_ENTRYPOINT && args[1] === "doctor",
      );
    expect(freshDoctorCall).toBeDefined();
    expect(freshDoctorCall?.[2]).toMatchObject({
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      },
    });
    expect(
      (freshDoctorCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env
        ?.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE,
    ).toBeUndefined();
    expect(
      (freshDoctorCall?.[2] as { baseEnv?: NodeJS.ProcessEnv } | undefined)?.baseEnv
        ?.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE,
    ).toBeUndefined();
    expect(vi.mocked(runExec).mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      syncPluginsForUpdateChannel.mock.invocationCallOrder[0] ?? 0,
    );
    expect(syncPluginsForUpdateChannel).toHaveBeenCalledTimes(1);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stages plugin-changing post-core config before updated plugin migrations run", async () => {
    syncPluginsForUpdateChannel.mockImplementationOnce(async ({ config }) =>
      pluginSyncResult(config, true),
    );

    await runPostCoreCommand({ restart: false });

    expect(lastReplaceConfigCall()).toMatchObject({
      writeOptions: { skipPluginValidation: true },
    });
  });

  it("runs the final fresh doctor for convergence-only post-core changes", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    runPostCorePluginConvergenceSpy.mockResolvedValueOnce(
      postCoreConvergenceResult({
        changes: ["Repaired configured plugin install records."],
      }),
    );

    await runPostCoreCommand({ restart: false });

    expect(syncPluginCall()?.config).toBeDefined();
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    const doctorCalls = vi.mocked(runExec).mock.calls.filter(([, args]) => args[1] === "doctor");
    expect(doctorCalls).toHaveLength(2);
    expect(doctorCalls[1]?.[2]).toMatchObject({
      env: { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
    });
    const strictValidationCall = vi
      .mocked(runExec)
      .mock.calls.find(
        ([, args]) =>
          args[0] === FRESH_POST_UPDATE_ENTRYPOINT &&
          args[1] === "config" &&
          args[2] === "validate" &&
          args[3] === "--json",
      );
    expect(strictValidationCall?.[2]).toMatchObject({
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" },
    });
  });

  it("keeps fresh doctor output off stdout during json post-core resume", async () => {
    vi.mocked(runExec).mockImplementation(async (_file, args) => ({
      stdout: args.includes("doctor") ? "doctor ui output" : "",
      stderr: args.includes("doctor") ? "doctor diagnostic output" : "",
    }));

    await runPostCoreCommand({ json: true, restart: false });

    expectFreshPostUpdateDoctor({ yes: false });
    expect(getLogOutput()).not.toContain("doctor ui output");
    expect(getErrorOutput()).toContain("doctor ui output");
    expect(getErrorOutput()).toContain("doctor diagnostic output");
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok" }),
    );
  });

  it("post-core resume children exit after writing a plugin update result", async () => {
    const resultDir = createCaseDir("openclaw-post-core-result");
    const resultPath = path.join(resultDir, "plugins.json");
    await fs.mkdir(resultDir, { recursive: true });

    await runPostCoreCommand(
      { restart: false },
      { OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: resultPath },
    );

    const result = JSON.parse(await fs.readFile(resultPath, "utf-8")) as {
      status?: string;
    };
    expect(result.status).toBe("ok");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
    expectNoSideEffects(runGatewayUpdate, spawn);
  });

  it("post-core resume mode uses the parent install records snapshot for missing payload warnings", async () => {
    const resultDir = createCaseDir("openclaw-post-core-records");
    const recordsPath = path.join(resultDir, "plugin-install-records.json");
    const installPath = path.join(resultDir, "demo-plugin");
    await fs.mkdir(installPath, { recursive: true });
    await writeJsonFixture(recordsPath, {
      demo: { source: "npm", spec: "@openclaw/demo@1.0.0", installPath },
    });
    pathExists.mockImplementation(async (candidate: string) => candidate === installPath);

    await runPostCoreCommand(
      { json: true, restart: false },
      { OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: recordsPath },
    );

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(jsonOutput?.postUpdate?.plugins?.warnings?.[0]?.reason).toContain(
      "package.json is missing",
    );
    const updateCall = lastNpmPluginUpdateCall() as { skipIds?: Set<string> } | undefined;
    expect(updateCall?.skipIds?.has("demo")).toBe(true);
  });

  it("post-core resume mode prefers post-doctor disk install records over the stale parent snapshot", async () => {
    const resultDir = createCaseDir("openclaw-post-core-disk-records");
    const recordsPath = path.join(resultDir, "plugin-install-records.json");
    await fs.mkdir(resultDir, { recursive: true });
    await writeJsonFixture(recordsPath, {
      stale: {
        source: "npm",
        spec: "@openclaw/stale@1.0.0",
        installPath: "/tmp/stale-plugin",
      },
    });
    const postDoctorRecords = {
      codex: {
        source: "npm",
        spec: "@openclaw/codex@2026.5.17",
        installPath: "/tmp/codex-plugin",
      },
    } satisfies Record<string, PluginInstallRecord>;
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(postDoctorRecords);

    await runPostCoreCommand(
      { json: true, restart: false },
      { OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: recordsPath },
    );

    expect(syncPluginCall()?.config?.plugins?.installs).toEqual(postDoctorRecords);
  });

  it("post-core resume mode persists the requested update channel with the updated process", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(
      configSnapshot({ update: { channel: "stable" } }, { hash: "stable-hash" }),
    );

    await runPostCoreCommand(
      { restart: false },
      {
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "dev",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "dev",
      },
    );

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        update: {
          channel: "dev",
        },
      },
      baseHash: "stable-hash",
    });
    expect(mutateConfigFileWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        writeOptions: { skipPluginValidation: true },
      }),
    );
    expect(syncPluginCall()?.channel).toBe("dev");
    expect(syncPluginCall()?.config?.update?.channel).toBe("dev");
  });

  it("post-core resume mode retries update channel persistence after config hash drift", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce(
      configSnapshot({ update: { channel: "stable" } }, { hash: "stable-hash" }),
    );
    const newerSnapshot = {
      ...configSnapshot({
        meta: { lastTouchedVersion: "2026.4.30" },
        update: { channel: "stable" },
      }),
      hash: "newer-hash",
    };
    vi.mocked(mutateConfigFileWithRetry).mockImplementationOnce(async (params) => {
      const nextConfig = structuredClone(newerSnapshot.sourceConfig);
      await params.mutate(nextConfig, {
        snapshot: newerSnapshot,
        previousHash: newerSnapshot.hash,
        attempt: 1,
      });
      return {
        path: newerSnapshot.path,
        previousHash: newerSnapshot.hash,
        snapshot: newerSnapshot,
        nextConfig,
        persistedHash: newerSnapshot.hash,
        result: undefined,
        attempts: 2,
        afterWrite: { mode: "none", reason: "test" },
        followUp: { mode: "none", reason: "test", requiresRestart: false },
      };
    });

    await runPostCoreCommand(
      { restart: false },
      {
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "dev",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "dev",
      },
    );

    expect(mutateConfigFileWithRetry).toHaveBeenCalledTimes(1);
    expect(syncPluginCall()?.config?.meta?.lastTouchedVersion).toBe("2026.4.30");
    expect(syncPluginCall()?.config?.update?.channel).toBe("dev");
  });

  it("passes the update timeout budget into post-core plugin updates", async () => {
    await runPostCoreCommand({ restart: false, timeout: "1800" });

    expect(npmPluginUpdateCall()?.timeoutMs).toBe(1_800_000);
  });

  it("prints plugin channel fallbacks near the post-core plugin summary", async () => {
    mockNpmPluginOutcomes([
      {
        pluginId: "lossless-claw",
        status: "updated",
        message: "Updated lossless-claw: 1.0.0 -> 1.0.1.",
        channelFallback: {
          requestedSpec: "lossless-claw@beta",
          usedSpec: "lossless-claw",
          requestedLabel: "@beta",
          usedLabel: "@latest",
          reason: "unavailable",
          message:
            "plugin channel fallback: lossless-claw used @latest because @beta was unavailable",
        },
      },
    ]);

    await runPostCoreCommand({ restart: false }, { OPENCLAW_UPDATE_POST_CORE_CHANNEL: "beta" });

    const logs = vi.mocked(runtimeCapture.log).mock.calls.map((call) => String(call[0]));
    expect(logs.some((line) => line.includes("npm plugins: 1 updated, 0 unchanged."))).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          "plugin channel fallback: lossless-claw used @latest because @beta was unavailable",
        ),
      ),
    ).toBe(true);
  });

  it("uses a fail-closed integrity policy for post-core plugin updates", async () => {
    await runPostCoreCommand({ restart: false });

    const updateCall = npmPluginUpdateCall() as
      | {
          onIntegrityDrift?: (drift: {
            pluginId: string;
            spec: string;
            expectedIntegrity: string;
            actualIntegrity: string;
            resolvedSpec?: string;
          }) => Promise<boolean>;
        }
      | undefined;
    const onIntegrityDrift = updateCall?.onIntegrityDrift;
    expect(onIntegrityDrift).toBeTypeOf("function");
    if (!onIntegrityDrift) {
      throw new Error("missing integrity drift handler");
    }

    vi.mocked(runtimeCapture.log).mockClear();
    await expect(
      onIntegrityDrift({
        pluginId: "demo",
        spec: "@openclaw/demo@1.0.0",
        resolvedSpec: "@openclaw/demo@1.0.0",
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
      }),
    ).resolves.toBe(false);
    expect(getLogOutput()).toContain("Plugin update aborted");
  });

  it("keeps json update output successful when post-core plugin updates warn", async () => {
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        config: OpenClawConfig;
        onIntegrityDrift?: (drift: {
          pluginId: string;
          spec: string;
          resolvedSpec?: string;
          resolvedVersion?: string;
          expectedIntegrity: string;
          actualIntegrity: string;
          dryRun: boolean;
        }) => Promise<boolean>;
      }) => {
        const proceed = await params.onIntegrityDrift?.({
          pluginId: "demo",
          spec: "@openclaw/demo@1.0.0",
          resolvedSpec: "@openclaw/demo@1.0.0",
          resolvedVersion: "1.0.0",
          expectedIntegrity: "sha512-old",
          actualIntegrity: "sha512-new",
          dryRun: false,
        });
        return {
          changed: false,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "error",
              message:
                proceed === false
                  ? "Failed to update demo: aborted: npm package integrity drift detected for @openclaw/demo@1.0.0"
                  : "unexpected drift continuation",
            },
          ],
        };
      },
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.reason).toBeUndefined();
    expect(jsonOutput?.postUpdate?.plugins?.integrityDrifts).toEqual([
      {
        pluginId: "demo",
        spec: "@openclaw/demo@1.0.0",
        resolvedSpec: "@openclaw/demo@1.0.0",
        resolvedVersion: "1.0.0",
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
        action: "aborted",
      },
    ]);
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.guidance).toEqual([
      "Run openclaw update repair to retry post-update plugin repair.",
      "Run openclaw plugins inspect demo --runtime --json for details.",
    ]);
    expect(pluginWarning(jsonOutput)?.reason).toContain("npm package integrity drift");
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.status).toBe("error");
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain(
      "Run openclaw update repair to retry post-update plugin repair.",
    );
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain(
      "Run openclaw plugins inspect demo --runtime --json for details.",
    );
  });

  it("includes non-blocking ClawHub trust warnings in json post-core plugin output", async () => {
    const trustWarning =
      "╭─ ClawHub Security Audit ─────────────────────────────────────────────╮\n" +
      "│ Outcome: Review                                                     │\n" +
      "│ Overview: The security scan is pending.                             │\n" +
      "╰────────────────────────────────────────────────────────────────────────╯";
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        config: OpenClawConfig;
        logger?: { terminalLinks?: boolean; warn?: (message: string) => void };
      }) => {
        expect(params.logger?.terminalLinks).toBe(false);
        params.logger?.warn?.(trustWarning);
        return {
          changed: false,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "unchanged",
              message: "demo is up to date.",
            },
          ],
        };
      },
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.reason).toBe(trustWarning);
    expect(pluginWarning(jsonOutput)?.guidance).toEqual([]);
    expect(pluginOutcome(jsonOutput)?.status).toBe("unchanged");
  });

  it("includes colored ClawHub trust warnings in json post-core plugin output", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    const trustWarning = clawHubRiskWarning;
    const coloredTrustWarning = `\u001b[33m${trustWarning}\u001b[39m`;
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        config: OpenClawConfig;
        logger?: { terminalLinks?: boolean; warn?: (message: string) => void };
      }) => {
        expect(params.logger?.terminalLinks).toBe(false);
        params.logger?.warn?.(coloredTrustWarning);
        return {
          changed: true,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "updated",
              currentVersion: "1.2.3",
              nextVersion: "1.2.4",
              message: "Updated demo: 1.2.3 -> 1.2.4.",
            },
          ],
        };
      },
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.reason).toBe(trustWarning);
    expect(pluginWarning(jsonOutput)?.reason).not.toContain("\u001b");
    expect(pluginOutcome(jsonOutput)?.status).toBe("updated");
  });

  it("includes failed ClawHub sync trust warnings in json post-core plugin output", async () => {
    const trustWarning = clawHubSuspiciousPayloadWarning;
    syncPluginsForUpdateChannel.mockResolvedValueOnce(
      pluginSyncResult(baseConfig, false, {
        warnings: [trustWarning],
        errors: [clawHubSyncRiskError],
      }),
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(jsonOutput?.postUpdate?.plugins?.sync.warnings).toEqual([trustWarning]);
    expect(jsonOutput?.postUpdate?.plugins?.sync.errors).toEqual([clawHubSyncRiskError]);
  });

  it("does not print duplicate failed ClawHub sync trust warnings in human post-core output", async () => {
    const trustWarning = clawHubSuspiciousPayloadWarning;
    syncPluginsForUpdateChannel.mockImplementationOnce(
      async (params: { config: OpenClawConfig; logger?: { warn?: (message: string) => void } }) => {
        params.logger?.warn?.(trustWarning);
        return pluginSyncResult(params.config, false, {
          warnings: [trustWarning],
          errors: [clawHubSyncRiskError],
        });
      },
    );

    await updateCommand({ yes: true, restart: false });

    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logs.filter((line) => line === trustWarning)).toHaveLength(1);
  });

  it("does not print duplicate ClawHub update trust warnings in human post-core output", async () => {
    const trustWarning = clawHubSuspiciousPayloadWarning;
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: { config: OpenClawConfig; logger?: { warn?: (message: string) => void } }) => {
        params.logger?.warn?.(trustWarning);
        return {
          changed: false,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "skipped",
              code: CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED,
              warning: trustWarning,
              message:
                "Skipped demo ClawHub update: ClawHub blocked this release; update was not started. Existing installed plugin left unchanged.",
            },
          ],
        };
      },
    );

    await updateCommand({ yes: true, restart: false });

    const output = getLogOutput();
    const trustWarningOccurrences = output.split(trustWarning).length - 1;
    expect(trustWarningOccurrences).toBe(1);
    expect(output).toContain("Skipped demo ClawHub update");
    expect(output).toContain("Run openclaw update repair to retry post-update plugin repair.");
    expect(output).toContain("Run openclaw plugins inspect demo --runtime --json for details.");
  });

  it("detects missing plugin payloads from persisted records before npm updates", async () => {
    const installPath = createCaseDir("openclaw-missing-plugin-payload");
    fsSync.mkdirSync(installPath, { recursive: true });
    const config = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
    loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: "npm",
        spec: "@openclaw/demo@1.0.0",
        installPath,
      },
    });
    syncPluginsForUpdateChannel.mockResolvedValueOnce(pluginSyncResult(config));
    pathExists.mockImplementation(async (candidate: string) => candidate === installPath);
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const updateCall = lastNpmPluginUpdateCall() as { skipIds?: Set<string> } | undefined;
    expect(updateCall?.skipIds?.has("demo")).toBe(true);
    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.reason).toContain("package.json is missing");
    expect(pluginOutcome(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginOutcome(jsonOutput)?.status).toBe("error");
  });

  it("prints non-fatal plugin warnings in human update output", async () => {
    mockNpmPluginOutcomes([
      {
        pluginId: "demo",
        status: "error",
        message: "Failed to update demo: registry timeout",
      },
    ]);

    await updateCommand({ yes: true, restart: false });

    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expectNoSideEffects(runDaemonInstall, runDaemonRestart, runRestartScript);
    expect(getErrorOutput()).not.toContain("Update failed during plugin post-update sync.");
    const logs = getLogOutput();
    expect(logs).toContain("Failed to update demo: registry timeout");
    expect(logs).toContain("Run openclaw update repair to retry post-update plugin repair.");
    expect(logs).toContain("Run openclaw plugins inspect demo --runtime --json for details.");
  });

  it("marks disabled-after-failure plugin skips as post-update warnings", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    mockNpmPluginOutcomes(
      [
        {
          pluginId: "demo",
          status: "skipped",
          message:
            'Disabled "demo" after plugin update failure; OpenClaw will continue without it. Failed to update demo: registry timeout',
        },
      ],
      true,
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.guidance).toEqual([
      "Run openclaw update repair to retry post-update plugin repair.",
      "Run openclaw plugins inspect demo --runtime --json for details.",
    ]);
    expect(pluginOutcome(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginOutcome(jsonOutput)?.status).toBe("skipped");
  });

  it("marks blocked ClawHub update skips as post-update warnings", async () => {
    const trustWarning =
      "╭─ BLOCKED - ClawHub flagged this release as malicious ─╮\n" +
      "│ • Security scan: malicious                           │\n" +
      "╰──────────────────────────────────────────────────────╯";
    mockNpmPluginOutcomes([
      {
        pluginId: "demo",
        status: "skipped",
        code: "clawhub_download_blocked",
        warning: trustWarning,
        message:
          "Skipped demo ClawHub update: ClawHub blocked this release; update was not started. Existing installed plugin left unchanged.",
      },
    ]);
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.reason).toContain("Security scan: malicious");
    expect(pluginWarning(jsonOutput)?.reason).toContain("ClawHub blocked this release");
    expect(pluginOutcome(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginOutcome(jsonOutput)?.status).toBe("skipped");
    expect(pluginOutcome(jsonOutput)?.message).toContain("Run openclaw update repair");
  });

  it("fails unexpected post-core plugin sync exceptions", async () => {
    syncPluginsForUpdateChannel.mockRejectedValueOnce(new Error("plugin sync invariant broke"));

    await expect(updateCommand({ json: true, restart: false })).rejects.toThrow(
      "plugin sync invariant broke",
    );
  });

  it("fails unexpected post-core npm update exceptions", async () => {
    updateNpmInstalledPlugins.mockRejectedValueOnce(new Error("npm update invariant broke"));

    await expect(updateCommand({ json: true, restart: false })).rejects.toThrow(
      "npm update invariant broke",
    );
  });

  it("preserves fresh-process plugin warning details in parent json output", async () => {
    setupUpdatedRootRefresh();
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      queueMicrotask(() => {
        void (async () => {
          const resultPath = env?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
          if (resultPath) {
            await fs.writeFile(
              resultPath,
              JSON.stringify({
                status: "warning",
                changed: false,
                warnings: [
                  {
                    pluginId: "demo",
                    reason: "Failed to update demo: registry timeout",
                    message:
                      'Plugin "demo" could not be processed after the core update: Failed to update demo: registry timeout Run openclaw update repair to retry post-update plugin repair. Run openclaw plugins inspect demo --runtime --json for details.',
                    guidance: [
                      "Run openclaw update repair to retry post-update plugin repair.",
                      "Run openclaw plugins inspect demo --runtime --json for details.",
                    ],
                  },
                ],
                sync: {
                  changed: false,
                  switchedToBundled: [],
                  switchedToNpm: [],
                  warnings: [],
                  errors: [],
                },
                npm: {
                  changed: false,
                  outcomes: [
                    {
                      pluginId: "demo",
                      status: "error",
                      message: "Failed to update demo: registry timeout",
                    },
                  ],
                },
                integrityDrifts: [],
              }),
              "utf-8",
            );
          }
          child.emit("exit", 0, null);
        })();
      });
      return child;
    });
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ yes: true, json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.reason).toBeUndefined();
    expect(jsonOutput?.postUpdate?.plugins?.warnings?.[0]?.guidance).toContain(
      "Run openclaw update repair to retry post-update plugin repair.",
    );
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain("registry timeout");
  });

  it.each([
    {
      name: "preview mode",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        serviceLoaded.mockResolvedValue(true);
        await updateCommand({ dryRun: true, channel: "beta" });
      },
      assert: () => {
        expectNoSideEffects(
          cleanupStaleManagedServiceUpdateHandoffs,
          replaceConfigFile,
          runGatewayUpdate,
          runDaemonInstall,
          runRestartScript,
          runDaemonRestart,
          launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
        );

        const logs = getLogOutput();
        expect(logs).toContain("Update dry-run");
        expect(logs).toContain("No changes were applied.");
      },
    },
    {
      name: "downgrade bypass",
      run: async () => {
        await setupNonInteractiveDowngrade();
        vi.mocked(defaultRuntime.exit).mockClear();
        await updateCommand({ dryRun: true });
      },
      assert: () => {
        expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
        expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
        expect(runGatewayUpdate).not.toHaveBeenCalled();
        expect(
          launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
        ).not.toHaveBeenCalled();
      },
    },
  ] as const)("updateCommand dry-run behavior: $name", runUpdateCliScenario);

  it.each([
    { name: "text", options: { dryRun: true, channel: "beta" } },
    { name: "JSON", options: { dryRun: true, json: true, channel: "beta" } },
  ])("reads config without recording observations during a $name dry run", async ({ options }) => {
    await updateCommand(options);

    expect(readConfigFileSnapshot).toHaveBeenCalledWith({
      skipPluginValidation: true,
      observe: false,
    });
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
  });

  it("does not clean managed-service handoffs during a JSON dry run", async () => {
    await updateCommand({ dryRun: true, json: true, channel: "beta", acceptCapabilities: true });

    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expectNoSideEffects(
      replaceConfigFile,
      runGatewayUpdate,
      runDaemonInstall,
      syncPluginsForUpdateChannel,
      updateNpmInstalledPlugins,
    );
    expect(defaultRuntime.writeJson).toHaveBeenCalled();
  });

  it("does not clean managed-service handoffs before rejecting an invalid timeout", async () => {
    await updateCommand({ timeout: "" });

    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { name: "update", run: async () => await updateCommand({ channel: "" }) },
    { name: "finalization", run: async () => await updateFinalizeCommand({ channel: "" }) },
  ])("rejects an explicitly empty $name channel before mutation", async ({ run }) => {
    await run();

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      '--channel must be "stable", "extended-stable", "beta", or "dev" (got "")',
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expectNoSideEffects(
      cleanupStaleManagedServiceUpdateHandoffs,
      replaceConfigFile,
      runGatewayUpdate,
      doctorCommand,
      syncPluginsForUpdateChannel,
    );
  });

  it("refuses an incompatible package target before service stop or install", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-refusal"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 9 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [
        {
          kind: "agent",
          path: "/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite",
          agentId: "main",
          foundVersion: 11,
          supportedVersion: 9,
          writerAppVersion: "2026.7.2",
        },
      ],
      indeterminate: [],
    });

    await updateCommand({ yes: true });

    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).toHaveBeenCalledWith({
      env: process.env,
      supportedVersions: { state: 3, agent: 9 },
    });
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("agent database (agent main)"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("skips package schema preflight when target metadata is missing", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-missing"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(packageTargetStatus());

    await updateCommand({ yes: true, restart: false });

    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeDefined();
  });

  it("refuses a package update when exact target metadata lookup fails", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-metadata-failure"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ version: null, nodeEngine: null, error: "registry timeout" }),
    );

    await updateCommand({ yes: true });

    expectNoSideEffects(databasePreflightMocks.preflightOpenClawDatabaseSchemas, serviceStop);
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("could not inspect exact package target openclaw@9999.0.0"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("continues a package update when target schemas are compatible", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-compatible"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );

    await updateCommand({ yes: true, restart: false });

    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).toHaveBeenCalledTimes(2);
    expect(packageInstallCommandCall()?.[0]).toContain("openclaw@9999.0.0");
  });

  it.each([true, false])(
    "uses inspected package runtime requirements when a later lookup disagrees (compatible=%s)",
    async (compatible) => {
      mockPackageInstallStatus(createCaseDir("openclaw-runtime-target"));
      const inspectedEngine = compatible ? ">=22.19.0" : ">=999.0.0";
      vi.mocked(fetchNpmPackageTargetStatus)
        .mockResolvedValueOnce(packageTargetStatus({ nodeEngine: inspectedEngine }))
        .mockResolvedValue(
          packageTargetStatus({ nodeEngine: compatible ? ">=999.0.0" : ">=22.19.0" }),
        );
      nodeVersionSatisfiesEngine.mockImplementation(
        (_version: string | null, engine: string | null) => engine !== ">=999.0.0",
      );

      await updateCommand({ yes: true, restart: false });

      if (compatible) {
        expect(packageInstallCommandCall()?.[0]).toContain("openclaw@9999.0.0");
      } else {
        expect(packageInstallCommandCall()).toBeUndefined();
        expect(getErrorOutput()).toContain("The requested package requires >=999.0.0");
      }
      expect(fetchNpmPackageTargetStatus).toHaveBeenCalledOnce();
    },
  );

  it("previews the resolved package owner without probing for another manager", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-dry-run-owner"));
    resolveGlobalManager.mockResolvedValueOnce("npm").mockResolvedValue("bun");

    await updateCommand({ dryRun: true, json: true });

    expect(lastWriteJsonCall()).toMatchObject({ mode: "npm" });
    expect(resolveGlobalManager).toHaveBeenCalledOnce();
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it("reports an incompatible package target during dry-run", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-dry-run"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 2, agent: 9 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [
        {
          kind: "state",
          path: "/tmp/openclaw/state/openclaw.sqlite",
          foundVersion: 3,
          supportedVersion: 2,
        },
      ],
      indeterminate: [],
    });

    await updateCommand({ dryRun: true });

    const logs = getLogOutput();
    expect(logs).toContain("Would refuse update: state database");
    expect(logs).toContain("https://docs.openclaw.ai/reference/database-schemas");
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("refuses an incompatible git target before stopping the service", async () => {
    mockOwnedGitService();
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
      await options?.beforeGitMutation?.({ schemaVersions: { state: 3, agent: 9 } });
      return makeOkUpdateResult({ mode: "git" });
    });
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [
        {
          kind: "agent",
          path: "/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite",
          foundVersion: 11,
          supportedVersion: 9,
        },
      ],
      indeterminate: [],
    });

    await updateCommand({ yes: true });

    expectNoSideEffects(serviceStop, serviceRestart);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("reports indeterminate package databases during dry-run", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-indeterminate-dry-run"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [],
      indeterminate: [
        { kind: "state", path: "/tmp/openclaw/state/openclaw.sqlite", reason: "database busy" },
      ],
    });

    await updateCommand({ dryRun: true });

    const logs = getLogOutput();
    expect(logs).toContain(
      "could not inspect state database /tmp/openclaw/state/openclaw.sqlite: database busy; retry once the gateway releases it",
    );
  });

  it("refuses a package target that changes after the service stops", async () => {
    mockPackageInstallStatus(process.cwd());
    mockOwnedGitService();
    primeServiceCommand(["node", path.join(process.cwd(), "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_STATE_DIR: profileStateDir(),
    });
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas
      .mockReturnValueOnce({ incompatible: [], indeterminate: [] })
      .mockReturnValueOnce({
        incompatible: [
          {
            kind: "agent",
            path: "/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite",
            foundVersion: 12,
            supportedVersion: 11,
          },
        ],
        indeterminate: [],
      });

    await updateCommand({ yes: true });

    expect(serviceStop).toHaveBeenCalledOnce();
    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas.mock.calls[1]?.[0].env).toEqual(
      expect.objectContaining({ OPENCLAW_STATE_DIR: profileStateDir() }),
    );
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(serviceRestart).toHaveBeenCalledOnce();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("refuses a git target that changes after the service stops", async () => {
    mockOwnedGitService();
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
      await options?.beforeGitMutation?.({ schemaVersions: { state: 3, agent: 11 } });
      return makeOkUpdateResult({ mode: "git" });
    });
    databasePreflightMocks.preflightOpenClawDatabaseSchemas
      .mockReturnValueOnce({ incompatible: [], indeterminate: [] })
      .mockReturnValueOnce({
        incompatible: [],
        indeterminate: [
          { kind: "agent", path: "/tmp/openclaw-agent.sqlite", reason: "database busy" },
        ],
      });

    await updateCommand({ yes: true });

    expect(serviceStop).toHaveBeenCalledOnce();
    expect(serviceRestart).toHaveBeenCalledOnce();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(serviceRestart.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(defaultRuntime.exit).mock.invocationCallOrder.at(-1) ?? 0,
    );
  });

  it("fails a post-stop git refusal when no managed service was running", async () => {
    vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
      await options?.beforeGitMutation?.({ schemaVersions: { state: 3, agent: 11 } });
      return makeOkUpdateResult({ mode: "git" });
    });
    databasePreflightMocks.preflightOpenClawDatabaseSchemas
      .mockReturnValueOnce({ incompatible: [], indeterminate: [] })
      .mockReturnValueOnce({
        incompatible: [],
        indeterminate: [{ kind: "state", path: "/tmp/openclaw.sqlite", reason: "database busy" }],
      });

    await updateCommand({ yes: true });

    expectNoSideEffects(serviceStop, serviceRestart);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    {
      name: "table output",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        await updateStatusCommand({ json: false });
      },
      assert: () => {
        expect(getLogOutput()).toContain("OpenClaw update status");
        expect(checkUpdateStatus).toHaveBeenCalledWith(
          expect.objectContaining({ useDetachedDevUpstream: false }),
        );
      },
    },
    {
      name: "json output",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        await updateStatusCommand({ json: true });
      },
      assert: () => {
        const last = requireValue(lastWriteJsonCall(), "update status JSON output");
        const parsed = last as Record<string, unknown>;
        const channel = parsed.channel as { value?: unknown };
        expect(channel.value).toBe(isBetaTag(VERSION) ? "beta" : "stable");
      },
    },
  ] as const)("updateStatusCommand rendering: $name", runUpdateCliScenario);

  it("renders update status when unrelated config validation would fail", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      valid: false,
      config: {} as OpenClawConfig,
    });
    vi.mocked(readSourceConfigBestEffort).mockResolvedValue({
      update: { channel: "dev" },
    } as OpenClawConfig);

    await updateStatusCommand({ json: true });

    const last = requireValue(lastWriteJsonCall(), "update status JSON output");
    const parsed = last as Record<string, unknown>;
    const channel = parsed.channel as { value?: unknown; config?: unknown };
    expect(channel.value).toBe("dev");
    expect(channel.config).toBe("dev");
    expect(checkUpdateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ useDetachedDevUpstream: true }),
    );
  });

  it("parses update status --json as the subcommand option", async () => {
    const program = new Command();
    program.name("openclaw");
    program.enablePositionalOptions();
    let seenJson = false;
    const update = program.command("update").option("--json", "", false);
    update
      .command("status")
      .option("--json", "", false)
      .action((opts) => {
        seenJson = Boolean(opts.json);
      });

    await program.parseAsync(["node", "openclaw", "update", "status", "--json"]);

    expect(seenJson).toBe(true);
  });

  it.each([
    {
      name: "defaults to dev channel for git installs when unset",
      installKind: "git" as const,
      options: {},
      storedChannel: undefined,
      expectedChannel: "dev" as const,
      expectedPersistedChannel: undefined,
    },
    {
      name: "defaults to stable channel for package installs when unset",
      installKind: "package" as const,
      options: { yes: true },
      storedChannel: undefined,
      expectedChannel: undefined,
      expectedPersistedChannel: undefined,
    },
    {
      name: "uses stored beta channel when configured",
      installKind: "git" as const,
      options: {},
      storedChannel: "beta" as const,
      expectedChannel: "beta" as const,
      expectedPersistedChannel: undefined,
    },
    {
      name: "routes a stored dev channel on package installs to the git update flow",
      installKind: "package" as const,
      options: { yes: true },
      storedChannel: "dev" as const,
      expectedChannel: "dev" as const,
      expectedPersistedChannel: undefined,
    },
    {
      name: "keeps a stored-dev package install on the package path for a one-off --tag",
      installKind: "package" as const,
      options: { tag: "latest", yes: true },
      storedChannel: "dev" as const,
      expectedChannel: undefined,
      expectedPersistedChannel: undefined,
    },
    {
      name: "keeps explicit dev channel precedence over a one-off --tag",
      installKind: "package" as const,
      options: { channel: "dev", tag: "latest", yes: true },
      storedChannel: "dev" as const,
      expectedChannel: "dev" as const,
      expectedPersistedChannel: undefined,
    },
    {
      name: "switches git installs to package mode for explicit beta and persists it",
      installKind: "git" as const,
      options: { channel: "beta" },
      storedChannel: undefined,
      expectedChannel: undefined,
      expectedPersistedChannel: "beta" as const,
    },
  ] as const)(
    "$name",
    async ({ installKind, options, storedChannel, expectedChannel, expectedPersistedChannel }) => {
      if (installKind === "package") {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
      }
      if (installKind === "git" || expectedChannel !== undefined) {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult({ mode: "git" }));
      }
      if (storedChannel) {
        vi.mocked(readConfigFileSnapshot).mockResolvedValue({
          ...baseSnapshot,
          config: { update: { channel: storedChannel } } as OpenClawConfig,
        });
      }

      if (installKind === "package" && expectedChannel !== undefined) {
        // Git commands are mocked, but package-to-git routing stages real directories.
        // Left on the default <home>/openclaw they outlive this case and make
        // a later test fail with "OPENCLAW_GIT_DIR appeared while cloning".
        await withEnvAsync({ OPENCLAW_GIT_DIR: createCaseDir("openclaw-update-git") }, async () => {
          await updateCommand(options);
        });
      } else {
        await updateCommand(options);
      }

      if (expectedChannel !== undefined) {
        expectUpdateCallChannel(expectedChannel);
      } else {
        expectPackageInstallSpec("openclaw@9999.0.0");
      }

      if (expectedPersistedChannel !== undefined) {
        expect(replaceConfigFile).toHaveBeenCalledTimes(1);
        const writeCall = replaceConfigCall() as
          | { nextConfig?: { update?: { channel?: string } } }
          | undefined;
        expect(writeCall?.nextConfig?.update?.channel).toBe(expectedPersistedChannel);
      }
    },
  );

  it("falls back to latest when beta tag is older than release", async () => {
    mockPackageInstallAtCaseDir();
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      config: { update: { channel: "beta" } } as OpenClawConfig,
    });
    primeNpmChannelTag("latest", "1.2.3-1");
    await updateCommand({});

    expectPackageInstallSpec("openclaw@1.2.3-1");
  });

  it("installs the verified exact package and persists an explicit extended-stable channel", async () => {
    mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.6.33");

    await updateCommand({ channel: "extended-stable", yes: true, restart: false });

    expect(resolveExtendedStablePackage).toHaveBeenCalledWith({
      installKind: "package",
      timeoutMs: undefined,
      packageName: "openclaw",
    });
    expectPackageInstallSpec("openclaw@2026.6.33");
    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("extended-stable");
    expect(syncPluginCall()?.channel).toBe("extended-stable");
    expect(syncPluginCall()?.coreVersion).toBe("2026.6.33");
    expect(lastNpmPluginUpdateCall()?.updateChannel).toBe("extended-stable");
    expect(lastNpmPluginUpdateCall()?.coreVersion).toBe("2026.6.33");
  });

  it("uses the same exact resolver for a bare update with stored extended-stable", async () => {
    mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.6.33");
    const config = { update: { channel: "extended-stable" } } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));

    await updateCommand({ yes: true, restart: false });

    expect(resolveExtendedStablePackage).toHaveBeenCalledWith({
      installKind: "package",
      timeoutMs: undefined,
      packageName: "openclaw",
    });
    expectPackageInstallSpec("openclaw@2026.6.33");
    expect(syncPluginCall()?.channel).toBe("extended-stable");
    expect(syncPluginCall()?.coreVersion).toBe("2026.6.33");
  });

  it("fails closed without config or package mutation when extended-stable resolution fails", async () => {
    mockPackageInstallAtCaseDir();
    vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
      status: "failed",
      reason: "selector_missing",
    });

    await updateCommand({ channel: "extended-stable", yes: true });

    expect(packageInstallCommandCall()).toBeUndefined();
    expectNoSideEffects(
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(lastWriteJsonCall()).toBeUndefined();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("fails a stored extended-stable update before launchd cleanup when resolution fails", async () => {
    mockPackageInstallAtCaseDir();
    const config = { update: { channel: "extended-stable" } } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
    vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
      status: "failed",
      reason: "selector_query_failed",
    });

    await updateCommand({ yes: true });

    expect(packageInstallCommandCall()).toBeUndefined();
    expectNoSideEffects(
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { name: "explicit", explicit: true },
    { name: "stored", explicit: false },
  ])("rejects --tag for an $name extended-stable channel", async ({ explicit }) => {
    mockPackageInstallAtCaseDir();
    if (!explicit) {
      const config = { update: { channel: "extended-stable" } } as OpenClawConfig;
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
    }

    await updateCommand({
      ...(explicit ? { channel: "extended-stable" as const } : {}),
      tag: "latest",
      yes: true,
    });

    expect(resolveExtendedStablePackage).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
    expectNoSideEffects(
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects extended-stable Git updates before handoff, conversion, or config mutation", async () => {
    await updateCommand({ channel: "extended-stable", yes: true });

    expectNoSideEffects(
      resolveExtendedStablePackage,
      runGatewayUpdate,
      runCommandWithTimeout,
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { name: "refuses", yes: false, installs: false },
    { name: "allows with --yes", yes: true, installs: true },
  ])("$name an extended-stable downgrade in non-interactive mode", async ({ yes, installs }) => {
    setTty(false);
    mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.7.10");
    vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
      status: "resolved",
      selector: "extended-stable",
      version: "2026.6.33",
      packageSpec: "openclaw@2026.6.33",
    });

    await updateCommand({ channel: "extended-stable", yes, restart: false });

    expect(packageInstallCommandCall() !== undefined).toBe(installs);
    if (installs) {
      expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("extended-stable");
    } else {
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    }
  });

  it("retains extended-stable after a post-commit plugin convergence failure", async () => {
    mockPackageInstallAtCaseDir();
    runPostCorePluginConvergenceSpy.mockResolvedValueOnce(
      postCoreConvergenceResult({
        warnings: [
          {
            pluginId: "demo",
            reason: "plugin smoke failed",
            message: "plugin smoke failed",
            guidance: ["Run openclaw update repair."],
          },
        ],
        errored: true,
      }),
    );

    await updateCommand({ channel: "extended-stable", yes: true, json: true, restart: false });

    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("extended-stable");
    const output = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(output?.status).toBe("error");
    expect(output?.reason).toBe("post-update-plugins");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("refreshes package-manager updates when the installed version already matches the target", async () => {
    mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.4.22");
    primeNpmChannelTag("latest", "2026.4.22");

    await updateCommand({ yes: true });

    const installCalls = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.filter(
        ([argv]) => Array.isArray(argv) && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g",
      );
    expect(installCalls).toHaveLength(1);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(getLogOutput()).not.toContain("already-current");
  });

  it("runs the package update when latest target lookup is unresolved", async () => {
    setTty(false);
    mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.4.22");
    primeNpmChannelTag("latest", null);
    mockCurrentProcessFreshDoctor();

    await updateCommand({});

    expect(getErrorOutput()).not.toContain("Downgrade confirmation required.");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expectPackageInstallSpec("openclaw@latest");
    expectFreshPostUpdateDoctor({ yes: false });
  });

  it("blocks the package update when a non-latest dist-tag lookup is unresolved", async () => {
    setTty(false);
    mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.4.22");
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "next",
      version: null,
      error: "HTTP 404",
    });

    await updateCommand({ tag: "next" });

    expect(getErrorOutput()).toContain("Downgrade confirmation required.");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it("warns but still runs package updates when disk space looks low", async () => {
    mockPackageInstallAtCaseDir();
    mockCurrentProcessFreshDoctor();
    vi.spyOn(fsSync, "statfsSync").mockReturnValue(
      statfsFixture({
        bavail: 256,
        bsize: 1024 * 1024,
      }),
    );

    await updateCommand({ yes: true });

    expectPackageInstallSpec("openclaw@9999.0.0");
    const preflightParams = vi
      .mocked(fetchNpmPackageTargetStatus)
      .mock.calls.find(([params]) => params.target === "9999.0.0")?.[0];
    expect(preflightParams).toEqual(
      expect.objectContaining({
        target: "9999.0.0",
        spec: "openclaw@9999.0.0",
        cwd: process.cwd(),
      }),
    );
    expect(packageInstallCommandCall()?.[1].env).toBe(preflightParams?.env);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(getLogOutput()).toContain("Low disk space near");
  });

  it("allows package updates from inherited gateway service env when the managed gateway is not running", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    serviceReadRuntime.mockResolvedValueOnce({
      status: "stopped",
      state: "stopped",
      missingUnit: true,
    });

    await runWithGatewayServiceEnv({ yes: true });

    expect(defaultRuntime.error).not.toHaveBeenCalledWith(
      [
        "Package updates cannot run from inside the gateway service process.",
        "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
        "Run `openclaw update` from a shell outside the gateway service, or stop the gateway service first and then update.",
      ].join("\n"),
    );
    expectPackageInstallSpec("openclaw@9999.0.0");
  });

  it("refuses package updates from inherited gateway service env when --no-restart leaves the gateway running", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    primeServiceCommand(["openclaw", "gateway", "run"], {
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    });
    serviceLoaded.mockResolvedValue(true);

    await runWithGatewayServiceEnv({ yes: true, restart: false });

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      [
        "Package updates cannot run from inside the gateway service process.",
        "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
        "Run `openclaw update` from a shell outside the gateway service, or stop the gateway service first and then update.",
      ].join("\n"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expectNoSideEffects(serviceStop, runGatewayUpdate);
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it.each([
    {
      name: "runtime probe fails",
      setupRuntime: () =>
        serviceReadRuntime.mockRejectedValueOnce(new Error("runtime probe failed")),
    },
    {
      name: "runtime status is unknown",
      setupRuntime: () => serviceReadRuntime.mockResolvedValueOnce({ status: "unknown" }),
    },
  ])(
    "refuses package updates from inherited gateway service env when $name",
    async ({ setupRuntime }) => {
      mockPackageInstallStatus(createCaseDir("openclaw-update"));
      primeServiceCommand(["openclaw", "gateway", "run"], {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      });
      setupRuntime();

      await runWithGatewayServiceEnv({ yes: true });

      expect(defaultRuntime.error).toHaveBeenCalledWith(
        [
          "Package updates cannot run from inside the gateway service process.",
          "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
          "Run `openclaw update` from a shell outside the gateway service, or stop the gateway service first and then update.",
        ].join("\n"),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expectNoSideEffects(serviceStop, runGatewayUpdate);
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it("refuses package updates from inherited gateway service env when the service definition is missing but runtime is live", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    serviceReadCommand.mockResolvedValue(null);
    serviceReadRuntime.mockResolvedValueOnce({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });

    await runWithGatewayServiceEnv({ yes: true });

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      [
        "Package updates cannot run from inside the gateway service process.",
        "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
        "Run `openclaw update` from a shell outside the gateway service, or stop the gateway service first and then update.",
      ].join("\n"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expectNoSideEffects(serviceStop, runGatewayUpdate);
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it("refuses package updates from inside the active gateway process tree", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    serviceLoaded.mockResolvedValue(true);
    mockGetSelfAndAncestorPidsSync.mockReturnValue(
      new Set<number>([process.pid, gatewayFixturePid]),
    );

    await updateCommand({ yes: true });

    const errors = getErrorOutput();
    expect(errors).toContain(
      "openclaw update detected it is running inside the gateway process tree.",
    );
    expect(errors).toContain(`Gateway PID ${gatewayFixturePid} is an ancestor`);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it("refuses package updates from inherited gateway runtime pid when process ancestry is truncated", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid]));

    await runWithGatewayServiceEnv(
      { yes: true },
      { [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(gatewayFixturePid) },
    );

    const errors = getErrorOutput();
    expect(errors).toContain(
      "openclaw update detected it is running inside the gateway process tree.",
    );
    expect(errors).toContain(`Gateway PID ${gatewayFixturePid} is an ancestor`);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it("blocks package updates when the target requires a newer Node runtime", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    primeNpmChannelTag("latest", "2026.3.23-2");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ target: "latest", version: "2026.3.23-2" }),
    );
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await updateCommand({ yes: true });

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    const errors = getErrorOutput();
    expect(errors).toContain("Node ");
    expect(errors).toContain(
      "Bare `npm i -g openclaw` can silently install an older compatible release.",
    );
  });

  it.each([
    {
      name: "explicit dist-tag",
      options: { tag: "next" },
      packageSpec: undefined,
      expectedSpec: "openclaw@9999.0.0",
    },
    {
      name: "explicit git package spec",
      options: { yes: true, tag: "github:openclaw/openclaw#main" },
      packageSpec: undefined,
      expectedSpec: "github:openclaw/openclaw#main",
    },
    {
      name: "aliased git package spec",
      options: { yes: true, tag: "OpenClaw@github:openclaw/openclaw#main" },
      packageSpec: undefined,
      expectedSpec: "OpenClaw@github:openclaw/openclaw#main",
    },
    {
      name: "full git URL package spec",
      options: { yes: true, tag: "https://github.com/openclaw/openclaw.git#main" },
      packageSpec: undefined,
      expectedSpec: "https://github.com/openclaw/openclaw.git#main",
    },
    {
      name: "hosted GitHub URL package spec without git suffix",
      options: { yes: true, tag: "https://github.com/openclaw/openclaw#main" },
      packageSpec: undefined,
      expectedSpec: "https://github.com/openclaw/openclaw#main",
    },
    {
      name: "aliased hosted GitHub URL package spec without git suffix",
      options: { yes: true, tag: "openclaw@https://github.com/openclaw/openclaw#main" },
      packageSpec: undefined,
      expectedSpec: "https://github.com/openclaw/openclaw#main",
    },
    {
      name: "GitHub shorthand package spec",
      options: { yes: true, tag: "openclaw/openclaw#main" },
      packageSpec: undefined,
      expectedSpec: "openclaw/openclaw#main",
    },
    {
      name: "SCP-style SSH package spec",
      options: { yes: true, tag: "git@github.com:openclaw/openclaw.git#main" },
      packageSpec: undefined,
      expectedSpec: "git@github.com:openclaw/openclaw.git#main",
    },
    {
      name: "OPENCLAW_UPDATE_PACKAGE_SPEC override",
      options: { yes: true, tag: "latest" },
      packageSpec: "http://10.211.55.2:8138/openclaw-next.tgz",
      expectedSpec: "http://10.211.55.2:8138/openclaw-next.tgz",
    },
  ] as const)(
    "resolves package install specs from tags and env overrides: $name",
    async ({ options, packageSpec, expectedSpec }) => {
      vi.clearAllMocks();
      readPackageName.mockResolvedValue("openclaw");
      readPackageVersion.mockResolvedValue("1.0.0");
      resolveGlobalManager.mockResolvedValue("npm");
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
      mockPackageInstallStatus(createCaseDir("openclaw-update"));
      if (packageSpec) {
        await withEnvAsync({ OPENCLAW_UPDATE_PACKAGE_SPEC: packageSpec }, async () => {
          await updateCommand(options);
        });
      } else {
        await updateCommand(options);
      }
      expectPackageInstallSpec(expectedSpec);
    },
  );

  it.each([
    { name: "real run", options: { yes: true, json: true, tag: "main" } },
    { name: "normalized alias", options: { yes: true, json: true, tag: "openclaw@main" } },
    {
      name: "dry-run",
      options: { dryRun: true, json: true, tag: "main", yes: true },
    },
  ] as const)("refuses --tag main before package resolution: $name", async ({ options }) => {
    mockPackageInstallStatus(createCaseDir("openclaw-update-main-refusal"));

    await updateCommand(options);

    const result = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(result).toMatchObject({
      status: "error",
      reason: "unsupported-package-target",
      steps: [],
    });
    expect(packageInstallCommandCall()).toBeUndefined();
    expectNoSideEffects(resolveGlobalManager, replaceConfigFile, runGatewayUpdate);
    if ("dryRun" in options && options.dryRun) {
      expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    }
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(getErrorOutput()).toContain("openclaw update --channel dev");
  });

  it("fails package updates when the installed correction version does not match the requested target", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(tempDir);
    await writeOpenClawPackageFixture(pkgRoot, "2026.3.23", {
      inventory: true,
    });
    readPackageVersion.mockResolvedValue("2026.3.23");
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return commandResult({ stdout: nodeModules });
      }
      return undefined;
    });

    await updateCommand({ yes: true, tag: "2026.3.23-2" });

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    const logs = getLogOutput();
    expect(logs).toContain("global install verify");
    expect(logs).toContain("expected installed version 2026.3.23-2, found 2026.3.23");
  });

  it("stops package post-update work when staged npm install verification fails", async () => {
    const tempDir = tempDirs.make("openclaw-update-staged-fail-");
    const prefix = path.join(tempDir, "prefix");
    const nodeModules = path.join(prefix, "lib", "node_modules");
    const { pkgRoot } = await setupInstalledPackageAtNodeModules(nodeModules, "2026.4.20");
    readPackageVersion.mockResolvedValue("2026.4.20");
    primeNpmChannelTag("latest", "2026.4.25");
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
        const stagePrefix = argv[argv.indexOf("--prefix") + 1];
        if (typeof stagePrefix !== "string") {
          throw new Error("missing stage prefix");
        }
        const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
        await writeOpenClawPackageFixture(stageRoot, "2026.4.25", {
          entrySource: "export {};\n",
          inventory: true,
        });
        await fs.writeFile(
          path.join(stageRoot, "dist", "stale-runtime.js"),
          "export {};\n",
          "utf-8",
        );
      }
    });

    await updateCommand({ yes: true, restart: false });

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(doctorCommandCall()).toBeUndefined();
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf-8")).resolves.toContain(
      '"version":"2026.4.20"',
    );
    const logs = getLogOutput();
    expect(logs).toContain("global install verify");
    expect(logs).toContain("unexpected packaged dist file dist/stale-runtime.js");
  });

  it("runs old package doctors without fix mode when service ownership is unknown", async () => {
    const tempDir = tempDirs.make("openclaw-update-package-");
    const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(tempDir);
    primeServiceCommand(["openclaw-wrapper", "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    readPackageVersion.mockImplementation(async (packageRoot: string) =>
      packageRoot === pkgRoot ? "2026.4.21" : "1.0.0",
    );
    primeNpmChannelTag("latest", "2026.4.21");
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await updateCommand({ yes: true });

    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0][0]).toContain("node");
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive"]);
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)?.OPENCLAW_UPDATE_IN_PROGRESS,
    ).toBe("1");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART,
    ).toBe("1");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)?.OPENCLAW_SERVICE_REPAIR_POLICY,
    ).toBeUndefined();
    const doctorIndex = doctorCommandCallIndex();
    const snapshotOrder = createPreUpdateConfigSnapshotMock.mock.invocationCallOrder[0];
    const doctorOrder = vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[doctorIndex];
    expect(requireValue(snapshotOrder, "pre-update snapshot call order")).toBeLessThan(
      requireValue(doctorOrder, "post-update doctor call order"),
    );
  });

  it("continues package post-core work for explicit post-update doctor advisories", async () => {
    const tempDir = tempDirs.make("openclaw-update-package-doctor-warning-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    primeNpmChannelTag("latest", "2026.4.21");
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, async (argv, options) => {
      if (argv[1] === entryPath && argv[2] === "doctor") {
        const env = options && typeof options !== "number" ? options.env : undefined;
        const resultPath = env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
        if (!resultPath) {
          throw new Error("missing doctor result path");
        }
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: createDeferredConfiguredPluginRepairDoctorResult([
            "deferred configured plugin repair",
          ]),
        });
        return commandResult({
          stderr: "doctor deferred configured plugin repair",
          code: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        });
      }
      return undefined;
    });

    await withEnvAsync({ OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "1" }, async () => {
      await updateCommand({ yes: true, restart: false, json: true });
    });

    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive"]);
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART,
    ).toBe("1");
    const postCoreCall = spawnCall();
    expect(postCoreCall?.[0]).toMatch(/node/);
    expect(postCoreCall?.[1]).toEqual([entryPath, "update", "--json", "--no-restart", "--yes"]);
    expect(postCoreCall?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    const doctorStep = jsonOutput?.steps.find((step) => step.name === "openclaw doctor");
    expect(jsonOutput?.status).toBe("ok");
    expect(doctorStep?.exitCode).toBe(UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE);
    expect(doctorStep?.advisory).toEqual({
      kind: "package-post-install-doctor",
      message: expect.stringContaining("recoverable update-time repair warning"),
    });
    expect(doctorStep?.advisory?.message).not.toContain("gateway restart");
    expect(doctorStep?.stderrTail).toContain("doctor deferred configured plugin repair");
    expect(doctorStep?.stderrTail).toContain("deferred configured plugin repair");
  });

  it("fails package updates when the post-update doctor is killed after verification", async () => {
    const tempDir = tempDirs.make("openclaw-update-package-doctor-timeout-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    primeNpmChannelTag("latest", "2026.4.21");
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[1] === entryPath && argv[2] === "doctor") {
        return commandResult({
          stderr: "doctor timed out",
          code: 124,
          killed: true,
          termination: "timeout",
        });
      }
      return undefined;
    });

    await updateCommand({ yes: true, restart: false, json: true });

    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    const doctorStep = jsonOutput?.steps.find((step) => step.name === "openclaw doctor");
    expect(doctorStep?.exitCode).toBe(124);
    expect(doctorStep?.advisory).toBeUndefined();
    expect(doctorStep?.termination).toBe("timeout");
    expect(getLogOutput()).not.toContain(
      "Post-install doctor failed after the package install was verified",
    );
  });

  it("runs package post-update doctor from the verified package root after a staged swap", async () => {
    const tempDir = tempDirs.make("openclaw-update-staged-doctor-");
    const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
      path.join(tempDir, "lib", "node_modules"),
    );
    primeNpmChannelTag("latest", "2026.5.14");
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
        const stagePrefix = argv[argv.indexOf("--prefix") + 1];
        const stagePackageRoot = path.join(
          requireValue(stagePrefix, "stage prefix"),
          "lib",
          "node_modules",
          "openclaw",
        );
        await writeOpenClawPackageFixture(stagePackageRoot, "2026.5.14", {
          entrySource: "export {};\n",
          inventory: true,
        });
      }
    });
    readPackageVersion.mockImplementation(async (packageRoot: string) => {
      const manifest = JSON.parse(
        await fs.readFile(path.join(packageRoot, "package.json"), "utf-8"),
      ) as { version?: string };
      return manifest.version ?? "0.0.0";
    });

    await updateCommand({ yes: true });

    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive", "--fix"]);
    expect(doctorCall?.[1].cwd).toBe(pkgRoot);
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)?.OPENCLAW_SERVICE_REPAIR_POLICY,
    ).toBe("external");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)?.OPENCLAW_COMPATIBILITY_HOST_VERSION,
    ).toBe("2026.5.14");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("stops a running managed gateway before package replacement", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const processOnSpy = vi.spyOn(process, "on");
    const processOffSpy = vi.spyOn(process, "off");
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
    const tempDir = tempDirs.make("openclaw-update-stop-service-");
    const { nodeModules } = await setupInstalledPackageRoot(tempDir);
    mockRunningManagedGateway();
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await runWithGatewayServiceEnv({ yes: true });
    platformSpy.mockRestore();

    const npmInstallCallIndex = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.findIndex(
        (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
      );
    const npmInstallCallOrder =
      vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[npmInstallCallIndex];
    const serviceStopCall = serviceStop.mock.calls[0]?.[0] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_KIND).toBe("gateway");
    const serviceStopCallOrder = serviceStop.mock.invocationCallOrder[0];
    const requiredServiceStopCallOrder = requireValue(
      serviceStopCallOrder,
      "service stop call order",
    );
    const requiredNpmInstallCallOrder = requireValue(npmInstallCallOrder, "npm install call order");
    const suspendOrder = requireValue(
      suspendScheduledTaskAutoStartForUpdate.mock.invocationCallOrder[0],
      "Scheduled Task suspend order",
    );
    const resumeOrder = requireValue(
      resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0],
      "Scheduled Task resume order",
    );
    const sigintListenerIndex = processOnSpy.mock.calls.findIndex(([event]) => event === "SIGINT");
    const sigintListenerOrder = requireValue(
      processOnSpy.mock.invocationCallOrder[sigintListenerIndex],
      "SIGINT recovery listener order",
    );
    expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      }),
    );
    expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      }),
    );
    expect(sigintListenerOrder).toBeLessThan(suspendOrder);
    expect(suspendOrder).toBeLessThan(requiredServiceStopCallOrder);
    expect(requiredServiceStopCallOrder).toBeLessThan(requiredNpmInstallCallOrder);
    expect(requiredNpmInstallCallOrder).toBeLessThan(resumeOrder);
    expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith("SIGBREAK", expect.any(Function));
    expect(processOffSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOffSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processOffSpy).toHaveBeenCalledWith("SIGBREAK", expect.any(Function));
    processOnSpy.mockRestore();
    processOffSpy.mockRestore();
  });

  it.each([
    { platform: "darwin" as const, handoff: undefined },
    { platform: "linux" as const, handoff: "1" },
    { platform: "win32" as const, handoff: "1" },
  ])(
    "quiesces a stopped loaded managed gateway on $platform before package replacement",
    async ({ platform, handoff }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const tempDir = tempDirs.make(`openclaw-update-stopped-loaded-${platform}-`);
      const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
      primeServiceCommand(["node", entryPath, "gateway", "run"], {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      });
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      mockFileBackedPathExists();
      mockNpmGlobalRoot(nodeModules);
      let finishStop: (() => void) | undefined;
      let markStopStarted: (() => void) | undefined;
      const stopStarted = new Promise<void>((resolve) => {
        markStopStarted = resolve;
      });
      serviceStop.mockImplementationOnce(() => {
        markStopStarted?.();
        return new Promise<void>((resolve) => {
          finishStop = resolve;
        });
      });

      try {
        await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: handoff }, async () => {
          const updatePromise = updateCommand({ yes: true });
          const firstOutcome = await Promise.race([
            stopStarted.then(() => "stop" as const),
            updatePromise.then(() => "update" as const),
          ]);

          expect(firstOutcome).toBe("stop");
          expect(serviceStop).toHaveBeenCalledOnce();
          expect(packageInstallCommandCall()).toBeUndefined();
          const pluginRecordCallsBeforeStop =
            loadInstalledPluginIndexInstallRecords.mock.calls.length;
          if (!finishStop) {
            throw new Error("expected the managed service stop to remain pending");
          }
          finishStop();
          await updatePromise;
          expect(loadInstalledPluginIndexInstallRecords.mock.calls.length).toBeGreaterThan(
            pluginRecordCallsBeforeStop,
          );
        });
      } finally {
        platformSpy.mockRestore();
      }

      expect(packageInstallCommandCall()).toBeDefined();
      expect(loadInstalledPluginIndexInstallRecords).toHaveBeenCalled();
      expect(serviceStop.mock.invocationCallOrder[0]).toBeLessThan(
        requireValue(
          loadInstalledPluginIndexInstallRecords.mock.invocationCallOrder.at(-1),
          "owned managed update context capture order",
        ),
      );
    },
  );

  it.each([
    { name: "an unloaded Darwin LaunchAgent", platform: "darwin" as const, loaded: false },
    { name: "an ordinary stopped systemd unit", platform: "linux" as const, loaded: true },
    { name: "an ordinary stopped Scheduled Task", platform: "win32" as const, loaded: true },
  ])("leaves $name stopped during package replacement", async ({ platform, loaded }) => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const tempDir = tempDirs.make(`openclaw-update-stopped-${platform}-`);
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    primeServiceCommand(["node", entryPath, "gateway", "run"]);
    serviceLoaded.mockResolvedValue(loaded);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    try {
      await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: undefined }, async () => {
        await updateCommand({ yes: true });
      });
    } finally {
      platformSpy.mockRestore();
    }

    expect(serviceStop).not.toHaveBeenCalled();
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeDefined();
  });

  it("restarts a quiesced stopped LaunchAgent after package replacement fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const tempDir = tempDirs.make("openclaw-update-stopped-launchagent-failure-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    primeServiceCommand(["node", entryPath, "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);
    mockPackageReplacementFailure("package replacement failed");

    try {
      await expect(updateCommand({ yes: true })).rejects.toThrow("package replacement failed");
    } finally {
      platformSpy.mockRestore();
    }

    expect(serviceStop).toHaveBeenCalledOnce();
    expect(serviceRestart).toHaveBeenCalledOnce();
    const packageInstallCallIndex = commandCalls().findIndex(
      ([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g",
    );
    const packageInstallCallOrder = requireValue(
      vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[packageInstallCallIndex],
      "package replacement call order",
    );
    expect(serviceStop.mock.invocationCallOrder[0]).toBeLessThan(packageInstallCallOrder);
    expect(packageInstallCallOrder).toBeLessThan(
      requireValue(serviceRestart.mock.invocationCallOrder[0], "service restart call order"),
    );
  });

  it("leaves a disabled stopped LaunchAgent disabled when package replacement fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const tempDir = tempDirs.make("openclaw-update-disabled-launchagent-failure-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    primeServiceCommand(["node", entryPath, "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    serviceEnabled.mockResolvedValue(false);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);
    mockPackageReplacementFailure("package replacement failed");

    try {
      await expect(updateCommand({ yes: true })).rejects.toThrow("package replacement failed");
    } finally {
      platformSpy.mockRestore();
    }

    expect(serviceEnabled).toHaveBeenCalledOnce();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(serviceRestart).not.toHaveBeenCalled();
  });

  it("does not inspect or mutate a Windows host service from an isolated install", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = tempDirs.make("openclaw-update-isolated-service-");
    const { nodeModules } = await setupInstalledPackageRoot(tempDir);
    mockRunningManagedGateway();
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await withEnvAsync({ OPENCLAW_HOME: path.join(tempDir, "relocated-home") }, async () => {
      await updateCommand({ yes: true });
    });
    platformSpy.mockRestore();

    expect(serviceReadCommand).not.toHaveBeenCalled();
    expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(prepareRestartScript).not.toHaveBeenCalled();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeDefined();
  });

  it.each([
    {
      platform: "darwin" as const,
      envKey: "OPENCLAW_LAUNCHD_LABEL",
      value: "ai.openclaw.gateway",
    },
    {
      platform: "linux" as const,
      envKey: "OPENCLAW_SYSTEMD_UNIT",
      value: "openclaw-gateway.service",
    },
    {
      platform: "win32" as const,
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "OpenClaw Gateway",
    },
  ])(
    "does not reuse a conflicting $envKey selector from the managed service on $platform",
    async ({ platform, envKey, value }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const tempDir = tempDirs.make(`openclaw-update-${platform}-selector-`);
      const home = path.join(tempDir, "home");
      const stateDir = path.join(home, ".openclaw-work");
      const { nodeModules } = await setupInstalledPackageRoot(tempDir);
      serviceReadCommand.mockResolvedValue({
        programArguments: ["openclaw", "gateway", "run"],
        environment: {
          OPENCLAW_PROFILE: "work",
          [envKey]: value,
        },
      });
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      mockFileBackedPathExists();
      mockNpmGlobalRoot(nodeModules);

      try {
        await withEnvAsync(
          {
            HOME: home,
            USERPROFILE: undefined,
            OPENCLAW_HOME: undefined,
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
            [envKey]: undefined,
          },
          async () => {
            await updateCommand({ yes: true });
          },
        );
      } finally {
        platformSpy.mockRestore();
      }

      expect(serviceReadRuntime).not.toHaveBeenCalled();
      expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
      expect(serviceStop).not.toHaveBeenCalled();
      expect(serviceRestart).not.toHaveBeenCalled();
      expect(prepareRestartScript).not.toHaveBeenCalled();
      expect(runRestartScript).not.toHaveBeenCalled();
      expect(runDaemonRestart).not.toHaveBeenCalled();
      expect(packageInstallCommandCall()).toBeUndefined();
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(getErrorOutput()).toContain(envKey);
    },
  );

  it("restores Windows Scheduled Task autostart when service stop fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockPackageInstallStatus(createCaseDir("openclaw-update-stop-failure"));
    mockRunningManagedGateway();
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    serviceStop.mockRejectedValueOnce(new Error("stop failed"));
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);

    await updateCommand({ yes: true });
    platformSpy.mockRestore();

    expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledTimes(1);
    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledTimes(1);
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    const suspendOrder = suspendScheduledTaskAutoStartForUpdate.mock.invocationCallOrder[0];
    const stopOrder = serviceStop.mock.invocationCallOrder[0];
    const resumeOrder = resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0];
    expect(requireValue(suspendOrder, "Scheduled Task suspend order")).toBeLessThan(
      requireValue(stopOrder, "service stop order"),
    );
    expect(requireValue(stopOrder, "service stop order")).toBeLessThan(
      requireValue(resumeOrder, "Scheduled Task resume order"),
    );
  });

  it("preserves both the update and Scheduled Task recovery failures", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockPackageInstallStatus(createCaseDir("openclaw-update-recovery-failure"));
    primeServiceCommand(["openclaw", "gateway", "run"], {
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    });
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    mockPackageReplacementFailure("update invariant broke");
    resumeScheduledTaskAutoStartAfterUpdate.mockRejectedValueOnce(new Error("task restore failed"));

    try {
      await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(
        expect.objectContaining({
          errors: [
            expect.objectContaining({ message: "update invariant broke" }),
            expect.objectContaining({ message: "task restore failed" }),
          ],
          cause: expect.objectContaining({ message: "update invariant broke" }),
        }),
      );
      expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledTimes(1);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it.each(["SIGINT", "SIGBREAK"] as const)(
    "restores Windows Scheduled Task autostart on %s during suspension",
    async (signal) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const processOnSpy = vi.spyOn(process, "on");
      const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      let finishSuspension: ((suspended: boolean) => void) | undefined;
      suspendScheduledTaskAutoStartForUpdate.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishSuspension = resolve;
          }),
      );
      resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
      mockPackageInstallStatus(createCaseDir("openclaw-update-suspension-signal"));
      primeServiceCommand(["openclaw", "gateway", "run"], {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      });
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });

      const updatePromise = updateCommand({ yes: true, restart: false });
      await vi.waitFor(() => expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledOnce());
      const signalListener = processOnSpy.mock.calls.find(([event]) => event === signal)?.[1];
      if (typeof signalListener !== "function" || !finishSuspension) {
        throw new Error(`expected armed ${signal} recovery and pending task suspension`);
      }
      signalListener();
      signalListener();
      expect(resumeScheduledTaskAutoStartAfterUpdate).not.toHaveBeenCalled();
      finishSuspension(true);

      await updatePromise;
      expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledTimes(1);
      expect(serviceStop).not.toHaveBeenCalled();
      expect(packageInstallCommandCall()).toBeUndefined();
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      await vi.waitFor(() => {
        expect(processExitSpy).toHaveBeenCalledTimes(2);
        expect(processExitSpy).toHaveBeenCalledWith(130);
      });
      platformSpy.mockRestore();
      processOnSpy.mockRestore();
      processExitSpy.mockRestore();
    },
  );

  it.each(["running", "stopped"] as const)(
    "guards a %s Windows Scheduled Task during a no-restart package update",
    async (runtimeStatus) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(fixtureRoot);
      mockPackageInstallStatus(createCaseDir("openclaw-update-stopped-task"));
      primeServiceCommand(["openclaw", "gateway", "run"], {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      });
      serviceReadRuntime.mockResolvedValue(
        runtimeStatus === "running"
          ? { status: "running", state: "running", pid: gatewayFixturePid }
          : { status: "stopped", state: "stopped" },
      );
      suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
      resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);

      try {
        await updateCommand({ yes: true, restart: false });
      } finally {
        homeSpy.mockRestore();
        platformSpy.mockRestore();
      }

      expect(serviceStop).not.toHaveBeenCalled();
      expect(packageInstallCommandCall()).toBeDefined();
      const suspendOrder = suspendScheduledTaskAutoStartForUpdate.mock.invocationCallOrder[0];
      const installCallIndex = vi
        .mocked(runCommandWithTimeout)
        .mock.calls.findIndex(
          (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
        );
      const installOrder =
        vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[installCallIndex];
      const resumeOrder = resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0];
      expect(requireValue(suspendOrder, "Scheduled Task suspend order")).toBeLessThan(
        requireValue(installOrder, "package install order"),
      );
      expect(requireValue(installOrder, "package install order")).toBeLessThan(
        requireValue(resumeOrder, "Scheduled Task resume order"),
      );
    },
  );

  it("does not suspend a foreign Windows Scheduled Task during a no-restart package update", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const updateRoot = tempDirs.make("openclaw-update-foreign-task-");
    const foreignRoot = tempDirs.make("openclaw-update-foreign-task-owner-");
    const foreignEntrypoint = await writeOpenClawPackageFixture(foreignRoot, "2026.4.21", {
      entrySource: "export {};\n",
    });
    primeServiceCommand(["node", foreignEntrypoint, "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      state: "running",
      pid: gatewayFixturePid,
    });
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);

    try {
      const { maybeStopManagedServiceBeforeMutableUpdate } =
        await import("./update-cli/update-command-service.js");
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({
          root: updateRoot,
          updateInstallKind: "package",
          shouldRestart: false,
          jsonMode: false,
        }),
      ).resolves.toMatchObject({
        inspected: true,
        running: true,
        serviceUpdateVerdict: { kind: "foreign" },
      });
    } finally {
      platformSpy.mockRestore();
    }

    expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
    expect(resumeScheduledTaskAutoStartAfterUpdate).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
  });

  it("stops a running managed gateway when git checkout rebuild starts", async () => {
    const serviceEntrypoint = path.join(process.cwd(), "dist", "index.js");
    mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
    const preparations = mockGitUpdateAfterMutation();

    await updateCommand({ yes: true });

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(runGatewayUpdate).toHaveBeenCalledTimes(1);
    expect(prepareRestartScript).toHaveBeenCalledWith(expect.anything(), expect.any(Number), [
      "node",
      serviceEntrypoint,
      "gateway",
      "run",
    ]);
    const serviceStopCall = serviceStop.mock.calls[0]?.[0] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_MARKER).toBe("openclaw");
    expect(serviceStopCall?.env?.OPENCLAW_SERVICE_KIND).toBe("gateway");
    const updateCall = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(updateCall?.beforeGitMutation).toEqual(expect.any(Function));
    expect(updateCall?.allowGatewayActivation).toBe(false);
    expect(preparations).toEqual([
      { allowGatewayServiceRepair: true, allowGatewayActivation: true },
    ]);
  });

  it("uses a manager-effective global user unit during update preflight", async () => {
    const entrypoint = path.join(process.cwd(), "dist", "index.js");
    const command = {
      programArguments: ["node", entrypoint, "gateway", "--port", "18789"],
      environment: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      sourcePath: "/etc/systemd/user/openclaw-gateway.service",
      definitionPaths: ["/etc/systemd/user/openclaw-gateway.service"],
    };
    serviceReadCommand.mockImplementation(async (options) =>
      options?.requireEffective ? command : null,
    );
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    serviceDefinitionMutationCapability.mockResolvedValue({
      kind: "sealed",
      detail: "privileged global user unit",
    });

    await updateCommand({ yes: true });

    expect(serviceReadCommand).toHaveBeenCalledWith({ requireEffective: true });
  });

  it("uses an explicit service wrapper when openclaw is absent from PATH", async () => {
    const wrapperDir = createCaseDir("openclaw-update-wrapper-service");
    const wrapperPath = path.join(wrapperDir, "gateway-wrapper");
    await fs.mkdir(wrapperDir, { recursive: true });
    await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const stateDir = profileStateDir("wrapper-service");
    tempDirsToCleanup.add(stateDir);
    await fs.mkdir(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify(baseSnapshot.config));
    const serviceEnv = {
      ...process.env,
      OPENCLAW_PROFILE: "wrapper-service",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WRAPPER: wrapperPath,
      PATH: path.dirname(process.execPath),
    };
    const { buildGatewayInstallPlan } = await import("../commands/daemon-install-helpers.js");
    const initialPlan = await buildGatewayInstallPlan({
      env: serviceEnv,
      config: baseSnapshot.config,
      port: 18789,
      runtime: "node",
      runtimePath: process.execPath,
      wrapperPath,
    });
    const existingEnvironment = Object.fromEntries(
      Object.entries(initialPlan.environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const { resolveOwnedManagedUpdateEnv } =
      await import("./update-cli/update-command-service-env.js");
    const { mergeInstallInvocationEnv } = await import("./daemon-cli/install.js");
    const ownedEnv = resolveOwnedManagedUpdateEnv({
      serviceEnv: { ...process.env, ...existingEnvironment },
      serviceDefinitionEnv: existingEnvironment,
      invocationCwd: process.cwd(),
    });
    const installEnv = mergeInstallInvocationEnv({
      env: ownedEnv,
      existingServiceEnv: existingEnvironment,
    });
    const servicePlan = await buildGatewayInstallPlan({
      env: installEnv,
      config: baseSnapshot.config,
      port: 18789,
      runtime: "node",
      wrapperPath,
      existingEnvironment,
      existingEnvironmentValueSources: initialPlan.environmentValueSources,
    });
    const serviceCommand = {
      ...servicePlan,
      environment: {
        ...Object.fromEntries(
          Object.entries(servicePlan.environment).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        // This sealed service deliberately has no CLI on PATH, including host-wide installs.
        PATH: wrapperDir,
      },
    };
    serviceReadCommand.mockResolvedValue(serviceCommand);
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockImplementation(async () =>
      serviceStop.mock.calls.length === 0 || freshRestartCalls().length > 0
        ? { status: "running", pid: gatewayFixturePid, state: "running" }
        : { status: "stopped", pid: null, state: "stopped" },
    );
    serviceDefinitionMutationCapability.mockResolvedValue({
      kind: "sealed",
      detail: "privileged wrapper owner",
    });
    const { resolveExecutablePath } = await import("../infra/executable-path.js");
    expect(resolveExecutablePath("openclaw", { env: serviceCommand.environment })).toBeUndefined();
    const envSnapshot = captureEnv(Object.keys(serviceCommand.environment));
    mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root: process.cwd() }));
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
      path.join(process.cwd(), "dist", "index.js"),
    );

    try {
      await updateCommand({ yes: true });
    } finally {
      envSnapshot.restore();
      const { clearConfigCache } = await import("../config/io.js");
      const { clearRuntimeConfigSnapshot } = await import("../config/runtime-snapshot.js");
      clearConfigCache();
      clearRuntimeConfigSnapshot();
    }

    expect(getErrorOutput()).toContain("service definition left unchanged");
    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(runGatewayUpdate).toHaveBeenCalledTimes(1);
    const restartOptions = freshRestartCalls()[0]?.[1];
    expect(typeof restartOptions === "object" && restartOptions.env?.OPENCLAW_WRAPPER).toBe(
      wrapperPath,
    );
    expect(serviceStart).not.toHaveBeenCalled();
    expectNoSideEffects(prepareRestartScript, runRestartScript, runDaemonInstall, runDaemonRestart);
  });

  it("fails managed git restart when the gateway responds but the service stays stopped", async () => {
    mockStoppedManagedGitGateway();
    restartHealthTestControl.snapshot = {
      runtime: { status: "stopped", pid: null, state: "stopped" },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: gatewayFixturePid, command: "openclaw-gateway" }],
        hints: [],
      },
      healthy: true,
      staleGatewayPids: [],
      gatewayVersion: "1.0.0",
      waitOutcome: "timeout",
      elapsedMs: 60_000,
    };
    mockGitUpdateAfterMutation();

    await updateCommand({ yes: true });

    expectFailedManagedGitRestart(
      "Gateway responded, but the managed service did not report running after restart.",
    );
  });

  it("fails managed git restart when the stopped service cannot be restarted", async () => {
    mockStoppedManagedGitGateway();
    runRestartScript.mockRejectedValueOnce(new Error("restart unavailable"));
    mockGitUpdateAfterMutation();

    await updateCommand({ yes: true });

    expectFailedManagedGitRestart("Gateway: restart failed: Error: restart unavailable");
  });

  it("stops a managed gateway rooted at the git checkout when switching package installs to dev", async () => {
    const packageRoot = createCaseDir("openclaw-update-package-root");
    const gitRoot = tempDirs.make("openclaw-update-git-service-root-");
    const serviceEntrypoint = await writeOpenClawPackageFixture(gitRoot, "2026.4.21", {
      entrySource: "export {};\n",
      git: true,
    });
    const canonicalGitRoot = await fs.realpath(gitRoot);
    mockPackageInstallStatus(packageRoot);
    pathExists.mockImplementation(async (candidate: string) => candidate === gitRoot);
    mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root: gitRoot,
      }),
    );

    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
      await updateCommand({ channel: "dev", yes: true });
    });

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(runGatewayUpdate).toHaveBeenCalledTimes(1);
    const updateCall = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(updateCall?.cwd).toBe(canonicalGitRoot);
    expect(updateCall?.beforeGitMutation).toEqual(expect.any(Function));
  });

  it("stops a managed gateway rooted at the package install when switching package installs to dev", async () => {
    const prefix = tempDirs.make("openclaw-update-package-service-root-");
    const nodeModules = path.join(prefix, "lib", "node_modules");
    const packageRoot = path.join(nodeModules, "openclaw");
    const sha = "a".repeat(40);
    const gitRoot = tempDirs.make("openclaw-update-git-service-root-");
    const packageEntrypoint = await writeOpenClawPackageFixture(packageRoot, "2026.4.20", {
      entrySource: "export {};\n",
    });
    const gitEntrypoint = await writeOpenClawPackageFixture(gitRoot, "2026.4.21", {
      entrySource: "export {};\n",
      git: true,
      builtSha: sha,
    });
    const canonicalGitRoot = await fs.realpath(gitRoot);
    mockPackageInstallStatus(packageRoot);
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, undefined, canonicalGitRoot);
    mockRunningManagedGateway(["node", packageEntrypoint, "gateway", "run"]);
    mockGatewayProbe("2026.4.21", "updated-checkout");
    serviceReadCommand.mockImplementation(async () => ({
      programArguments: [
        "node",
        serviceStop.mock.calls.length > 0 ? gitEntrypoint : packageEntrypoint,
        "gateway",
        "run",
      ],
      environment: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
    }));
    const preparations = mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root: gitRoot,
        after: { sha, version: "2026.4.21" },
      }),
    );

    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
      await updateCommand({ channel: "dev", yes: true });
    });

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(runGatewayUpdate).toHaveBeenCalledTimes(1);
    expect(preparations).toEqual([
      { allowGatewayServiceRepair: true, allowGatewayActivation: true },
    ]);
    expect(prepareRestartScript).toHaveBeenCalledWith(expect.anything(), expect.any(Number), [
      "node",
      gitEntrypoint,
      "gateway",
      "run",
    ]);
    expect(runRestartScript).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.exit, getErrorOutput() + getLogOutput()).not.toHaveBeenCalledWith(1);
    const updateCall = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(updateCall?.cwd).toBe(canonicalGitRoot);
    expect(updateCall?.beforeGitMutation).toEqual(expect.any(Function));
  });

  it.runIf(process.platform !== "win32")(
    "continues package-to-Git updates from the published checkout after its alias is retargeted",
    async () => {
      const root = tempDirs.make("openclaw-update-git-alias-");
      const nodeModules = path.join(root, "package", "node_modules");
      const packageRoot = path.join(nodeModules, "openclaw");
      const targetRoot = path.join(root, "checkout-target");
      const replacementRoot = path.join(root, "checkout-replacement");
      const checkoutAlias = path.join(root, "checkout-alias");
      await Promise.all([fs.mkdir(targetRoot), fs.mkdir(replacementRoot)]);
      await fs.symlink(targetRoot, checkoutAlias, "dir");
      const publishedRoot = await fs.realpath(checkoutAlias);
      mockPackageInstallStatus(packageRoot);
      mockFileBackedPathExists();
      mockNoopPostUpdatePluginConvergence();
      vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
        expect(options?.cwd).toBe(publishedRoot);
        return makeOkUpdateResult({ mode: "git", root: publishedRoot });
      });
      mockNpmGlobalCommands(nodeModules, async (argv) => {
        if (argv[0] === "git" && argv[1] === "clone") {
          const stagingDir = requireValue(argv.at(-1), "Git clone staging directory");
          await writeOpenClawPackageFixture(stagingDir, "2026.8.17", { git: true });
          await fs.unlink(checkoutAlias);
          await fs.symlink(replacementRoot, checkoutAlias, "dir");
        }
      });

      await withEnvAsync({ OPENCLAW_GIT_DIR: checkoutAlias }, async () => {
        await updateCommand({ channel: "dev", yes: true, restart: false });
      });

      const installCall = packageInstallCommandCall();
      expect(installCall?.[0]).toContain(publishedRoot);
      expect(installCall?.[0]).not.toContain(checkoutAlias);
      expect(installCall?.[1].cwd).toBe(publishedRoot);
      await expect(fs.readdir(replacementRoot)).resolves.toEqual([]);
    },
  );

  it("preserves the package and shim when package-to-Git staged activation fails", async () => {
    const root = tempDirs.make("openclaw-update-package-to-git-fail-");
    const prefix = path.join(root, "prefix");
    const nodeModules = path.join(prefix, "lib", "node_modules");
    const packageRoot = path.join(nodeModules, "openclaw");
    const shim = path.join(prefix, "bin", "openclaw");
    const gitRoot = path.join(root, "git-root");
    await writeOpenClawPackageFixture(packageRoot, "2026.4.20", {
      entrySource: "export {};\n",
      inventory: true,
    });
    await fs.mkdir(path.dirname(shim), { recursive: true });
    await fs.writeFile(shim, "old package shim\n", { mode: 0o755 });
    await writeOpenClawPackageFixture(gitRoot, "2026.8.18", { git: true });
    const packageBefore = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
    const shimBefore = await fs.readFile(shim, "utf8");
    mockPackageInstallStatus(packageRoot);
    mockFileBackedPathExists();
    mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root: gitRoot }));
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        return commandResult({ code: 1, stderr: "candidate verification fixture failure" });
      }
      return undefined;
    });

    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
      await updateCommand({ channel: "dev", yes: true, restart: false });
    });

    const installCalls = commandCalls().filter(
      ([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g",
    );
    expect(installCalls).toHaveLength(2);
    expect(installCalls.every(([argv]) => argv.includes("--prefix"))).toBe(true);
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toBe(
      packageBefore,
    );
    await expect(fs.readFile(shim, "utf8")).resolves.toBe(shimBefore);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("does not stop or restart a managed gateway owned by another git checkout", async () => {
    const otherRoot = tempDirs.make("openclaw-update-other-service-root-");
    const otherEntrypoint = await writeOpenClawPackageFixture(otherRoot, "2026.4.21", {
      entrySource: "export {};\n",
    });
    mockRunningManagedGateway(["node", otherEntrypoint, "gateway", "run"]);
    const preparations = mockGitUpdateAfterMutation();

    await updateCommand({ yes: true });

    expectNoSideEffects(serviceStop, prepareRestartScript, serviceRestart, runDaemonRestart);
    expect(runGatewayUpdate).toHaveBeenCalledTimes(1);
    expect(preparations).toEqual([
      { allowGatewayServiceRepair: false, allowGatewayActivation: false },
    ]);
  });

  it("leaves a stopped git service down when plugin post-update fails", async () => {
    const serviceEntrypoint = path.join(process.cwd(), "dist", "index.js");
    const invalidPostUpdateSnapshot = configSnapshot(baseConfig, {
      valid: false,
      issues: [{ path: "plugins", message: "invalid plugin config" }],
    });
    vi.mocked(readConfigFileSnapshot)
      .mockResolvedValueOnce(baseSnapshot)
      .mockResolvedValueOnce(baseSnapshot)
      .mockResolvedValueOnce(invalidPostUpdateSnapshot);
    mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
    mockGitUpdateAfterMutation();

    await updateCommand({ yes: true });

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expectNoSideEffects(serviceRestart, runDaemonRestart);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(getLogOutput()).toContain("Update Result: ERROR");
    expect(getErrorOutput()).not.toContain("Update failed during plugin post-update sync.");
  });

  it("restarts a stopped git service when the fresh plugin doctor cannot run", async () => {
    const serviceEntrypoint = path.join(process.cwd(), "dist", "index.js");
    mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
    mockGitUpdateAfterMutation();
    mockNpmPluginOutcomes([], true);
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    vi.mocked(runExec).mockRejectedValueOnce(new Error("doctor process failed"));
    await updateCommand({ yes: true });

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(serviceRestart).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps managed service stop output off stdout during json package updates", async () => {
    const tempDir = tempDirs.make("openclaw-update-json-stop-service-");
    const { nodeModules } = await setupInstalledPackageRoot(tempDir);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockRunningManagedGateway();
    serviceStop.mockImplementationOnce(async (params: { stdout?: NodeJS.WritableStream }) => {
      params.stdout?.write("Stopped systemd service: openclaw-gateway.service\n");
    });
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    let writes;
    try {
      await updateCommand({ yes: true, json: true });
      writes = getMockCallOutput(stdoutWrite);
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(writes).not.toContain("Stopped systemd service");
    expect(serviceStop).toHaveBeenCalled();
  });

  it("disarms legacy launchd updater jobs before stopping the gateway", async () => {
    const tempDir = tempDirs.make("openclaw-update-launchd-loop-");
    const { nodeModules } = await setupInstalledPackageRoot(tempDir);
    mockRunningManagedGateway();
    launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mockResolvedValue(true);
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await updateCommand({ yes: true });

    const cleanupOrder =
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob.mock.invocationCallOrder[0];
    const serviceStopOrder = serviceStop.mock.invocationCallOrder[0];
    expect(requireValue(cleanupOrder, "launchd updater cleanup order")).toBeLessThan(
      requireValue(serviceStopOrder, "service stop order"),
    );
  });

  it("refreshes package installs even when the current version already matches the target", async () => {
    const tempDir = tempDirs.make("openclaw-update-current-");
    const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(
      tempDir,
      "2026.4.23",
    );
    readPackageVersion.mockResolvedValue("2026.4.23");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2026.4.23",
    });
    await writeOpenClawPackageFixture(pkgRoot, "2026.4.23", {
      inventory: true,
    });
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await updateCommand({ yes: true, restart: false });

    expectPackageInstallSpec("openclaw@2026.4.23");
    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0][0]).toContain("node");
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive"]);
    const postCoreSpawn = spawnCall();
    expect(postCoreSpawn?.[0]).toContain("node");
    expect(postCoreSpawn?.[1]).toEqual([entryPath, "update", "--no-restart", "--yes"]);
    expect(postCoreSpawn?.[2].stdio).toBe("inherit");
    expect(postCoreSpawn?.[2].env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(postCoreSpawn?.[2].env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe(
      isBetaTag(VERSION) ? "beta" : "stable",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(getLogOutput()).not.toContain("already-current");
  });

  it("retries package updates without optional deps when npm global update fails", async () => {
    const tempDir = tempDirs.make("openclaw-update-optional-");
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(pkgRoot);
    mockCurrentProcessFreshDoctor();
    await writeOpenClawPackageFixture(pkgRoot, "9999.0.0", {
      inventory: true,
    });

    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv.includes("-g") && !argv.includes("--omit=optional")) {
        return commandResult({ stderr: "node-gyp failed", code: 1 });
      }
      return undefined;
    });

    await updateCommand({ yes: true, restart: false });

    const installArgvs = commandCalls()
      .map(([argv]) => argv)
      .filter((argv) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");
    expect(installArgvs).toEqual([
      [
        "npm",
        "i",
        "-g",
        "--allow-scripts=openclaw",
        "openclaw@9999.0.0",
        "--no-fund",
        "--no-audit",
        "--loglevel=error",
        "--min-release-age=0",
      ],
      [
        "npm",
        "i",
        "-g",
        "--allow-scripts=openclaw",
        "openclaw@9999.0.0",
        "--omit=optional",
        "--no-fund",
        "--no-audit",
        "--loglevel=error",
        "--min-release-age=0",
      ],
    ]);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("uses the owning npm binary for package updates when PATH npm points elsewhere", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const brewPrefix = createCaseDir("brew-prefix");
    const brewRoot = path.join(brewPrefix, "lib", "node_modules");
    const pkgRoot = path.join(brewRoot, "openclaw");
    const brewNpm = path.join(brewPrefix, "bin", "npm");
    const win32PrefixNpm = path.join(brewPrefix, "npm.cmd");
    const owningNpmCommands = new Set([brewNpm, win32PrefixNpm].map(path.normalize));
    const isOwningNpmCommand = (value: unknown) =>
      typeof value === "string" && owningNpmCommands.has(path.normalize(value));
    const pathNpmRoot = createCaseDir("nvm-root");
    mockPackageInstallStatus(pkgRoot);
    pathExists.mockResolvedValue(false);

    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (!Array.isArray(argv)) {
        return commandResult();
      }
      if (isOwningNpmCommand(argv[0]) && argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return commandResult({ stdout: `${pathNpmRoot}\n` });
      }
      if (isOwningNpmCommand(argv[0]) && argv[1] === "root" && argv[2] === "-g") {
        return commandResult({ stdout: `${brewRoot}\n` });
      }
      return commandResult();
    });

    await fs.mkdir(path.dirname(brewNpm), { recursive: true });
    await fs.writeFile(brewNpm, "", "utf8");
    await fs.writeFile(win32PrefixNpm, "", "utf8");
    await updateCommand({ yes: true });

    platformSpy.mockRestore();

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    const installCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(
        ([argv]) =>
          Array.isArray(argv) &&
          isOwningNpmCommand(argv[0]) &&
          argv[1] === "i" &&
          argv[2] === "-g" &&
          argv.includes("openclaw@9999.0.0"),
      );

    const requiredInstallCall = requireValue(installCall, "brew npm install call");
    const installCommand = requiredInstallCall[0][0] ?? "";
    expect(installCommand).not.toBe("npm");
    expect(path.isAbsolute(installCommand)).toBe(true);
    expect(path.normalize(installCommand)).toContain(path.normalize(brewPrefix));
    expect(path.normalize(installCommand)).toMatch(
      new RegExp(
        `${path
          .normalize(path.join(brewPrefix, path.sep))
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*npm(?:\\.cmd)?$`,
        "i",
      ),
    );
    expect(vi.mocked(resolveNpmChannelTag)).toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    expect(vi.mocked(fetchNpmPackageTargetStatus)).toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    const installOptions = requiredInstallCall[1] as { timeoutMs?: number };
    expect(typeof installOptions.timeoutMs).toBe("number");
  });

  it("prepends portable Git PATH for package updates on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = createCaseDir("openclaw-update");
    const localAppData = createCaseDir("openclaw-localappdata");
    const portableGitMingw = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "mingw64",
      "bin",
    );
    const portableGitUsr = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "usr",
      "bin",
    );
    await fs.mkdir(portableGitMingw, { recursive: true });
    await fs.mkdir(portableGitUsr, { recursive: true });
    mockPackageInstallStatus(tempDir);
    pathExists.mockImplementation(
      async (candidate: string) => candidate === portableGitMingw || candidate === portableGitUsr,
    );

    await withEnvAsync({ LOCALAPPDATA: localAppData }, async () => {
      await updateCommand({ yes: true });
    });

    platformSpy.mockRestore();

    const updateCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] === "npm" &&
          call[0][1] === "i" &&
          call[0][2] === "-g",
      );
    const updateOptions =
      typeof updateCall?.[1] === "object" && updateCall[1] !== null ? updateCall[1] : undefined;
    const mergedPath = updateOptions?.env?.Path ?? updateOptions?.env?.PATH ?? "";
    expect(mergedPath.split(path.delimiter).slice(0, 2)).toEqual([
      portableGitMingw,
      portableGitUsr,
    ]);
    expect(updateOptions?.env?.NPM_CONFIG_SCRIPT_SHELL).toBeUndefined();
  });

  it.each([
    {
      name: "outputs JSON when --json is set",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(defaultRuntime.writeJson).mockClear();
        await updateCommand({ json: true });
      },
      assert: () => {
        requireValue(lastWriteJsonCall(), "update JSON output");
      },
    },
    {
      name: "exits with error on failure",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue({
          status: "error",
          mode: "git",
          reason: "rebase-failed",
          steps: [],
          durationMs: 100,
        } satisfies UpdateRunResult);
        vi.mocked(defaultRuntime.exit).mockClear();
        await updateCommand({});
      },
      assert: () => {
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      },
    },
  ] as const)("updateCommand reports outcomes: $name", runUpdateCliScenario);

  it("persists the requested channel only after a successful package update", async () => {
    mockPackageInstallAtCaseDir();

    await updateCommand({ channel: "beta", yes: true });

    const installCallIndex = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.findIndex(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] === "npm" &&
          call[0][1] === "i" &&
          call[0][2] === "-g",
      );
    expect(installCallIndex).toBeGreaterThanOrEqual(0);
    expect(replaceConfigFile).toHaveBeenCalledTimes(1);
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        update: {
          channel: "beta",
        },
      },
      baseHash: undefined,
    });
    expect(
      vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[installCallIndex] ?? 0,
    ).toBeLessThan(
      vi.mocked(replaceConfigFile).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("warns when a package update targets a managed service root outside the shell root", async () => {
    const shellRoot = createCaseDir("openclaw-shell-root");
    const serviceRoot = tempDirs.make("openclaw-service-root-");
    const serviceNode = path.join(path.dirname(serviceRoot), "bin", "node");
    await fs.mkdir(path.join(serviceRoot, "dist"), { recursive: true });
    await writeOpenClawPackageFixture(serviceRoot, "2026.5.18");
    mockPackageInstallStatus(shellRoot);
    primeServiceCommand([serviceNode, path.join(serviceRoot, "dist", "index.js"), "gateway"]);

    await updateCommand({ dryRun: true });

    expect(serviceReadCommand).toHaveBeenCalledOnce();
    const logs = getLogOutput();
    expect(logs).toContain(`Targeting managed gateway service package root: ${serviceRoot}`);
    expect(logs).toContain(
      `Shell OpenClaw root differs from the managed gateway service root: ${shellRoot}`,
    );
    expect(logs).toContain("make sure `openclaw` on PATH resolves to the managed service root");
    expect(logs).toContain(`Managed gateway service Node: ${serviceNode}`);
  });

  it("blocks a stale managed service Node before a no-restart package update", async () => {
    const shellRoot = createCaseDir("openclaw-shell-root");
    const serviceRoot = tempDirs.make("openclaw-service-root-");
    const serviceNode = path.join(path.dirname(serviceRoot), "bin", "node");
    await fs.mkdir(path.join(serviceRoot, "dist"), { recursive: true });
    await fs.mkdir(path.dirname(serviceNode), { recursive: true });
    await fs.writeFile(serviceNode, "", "utf-8");
    await writeOpenClawPackageFixture(serviceRoot, "2026.5.18");
    mockPackageInstallStatus(shellRoot);
    primeServiceCommand([serviceNode, path.join(serviceRoot, "dist", "index.js"), "gateway"]);
    primeNpmChannelTag("latest", "2026.5.20");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ target: "latest", version: "2026.5.20" }),
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === serviceNode && argv[1] === "--version") {
        return commandResult({ stdout: "v22.18.0\n" });
      }
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      return commandResult();
    });
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await updateCommand({ yes: true, restart: false });

    expect(packageInstallCommandCall()).toBeUndefined();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    const errors = getErrorOutput();
    expect(errors).toContain(`Node 22.18.0 at ${serviceNode} is too old`);
    expect(errors).toContain("Upgrade the Node runtime that owns the managed Gateway service");
  });

  it("runs managed service package follow-up commands with the service Node despite heap argv", async () => {
    const shellRoot = createCaseDir("openclaw-shell-root");
    const servicePrefix = tempDirs.make("openclaw-service-prefix-");
    const {
      nodeModules,
      root: serviceRoot,
      serviceNode,
      serviceNpm,
      serviceNpmReal,
      entrypoint,
    } = await setupServicePackageAtPrefix({ prefix: servicePrefix });
    mockPackageInstallStatus(shellRoot);
    primeServiceCommand([serviceNode, "--max-old-space-size=16384", entrypoint, "gateway"]);
    serviceLoaded.mockResolvedValue(true);
    primeNpmChannelTag("latest", "2026.5.20");
    mockFileBackedPathExists();
    mockServicePackageCommands({
      nodeModules,
      packageRoot: serviceRoot,
      targetVersion: "2026.5.20",
      npmCommands: [serviceNpm, serviceNpmReal!],
      nodeVersions: { [serviceNode]: "v22.22.0" },
    });

    await updateCommand({ yes: true });

    expect(doctorCommandCall()?.[0][0]).toBe(serviceNode);
    expect(spawnCall()?.[0]).toBe(serviceNode);
    const serviceInstallCall = commandCalls().find(
      ([argv]) => argv[2] === "gateway" && argv[3] === "install",
    );
    expect(serviceInstallCall?.[0][0]).toBe(serviceNode);
  });

  it.each([
    { scenario: "different Node", command: "gateway", sameNode: false, selected: true },
    { scenario: "non-Gateway command", command: "agent", sameNode: false, selected: false },
    { scenario: "symlink to current Node", command: "gateway", sameNode: true, selected: false },
  ])(
    "plans service Node selection from one inspection ($scenario)",
    async ({ command, sameNode, selected }) => {
      const root = createCaseDir("openclaw-same-root");
      const entrypoint = await writeOpenClawPackageFixture(root, "2026.5.18");
      let serviceNode = "/opt/other-node/bin/node";
      if (sameNode) {
        const nodeAliasDir = path.join(root, "node-bin");
        await fs.symlink(
          path.dirname(process.execPath),
          nodeAliasDir,
          process.platform === "win32" ? "junction" : "dir",
        );
        serviceNode = path.join(nodeAliasDir, path.basename(process.execPath));
      }
      mockPackageInstallStatus(root);
      primeServiceCommand([serviceNode, "--import", "tsx", entrypoint, command]);

      await updateCommand({ dryRun: true });

      expect(serviceReadCommand).toHaveBeenCalledOnce();
      const logs = getLogOutput();
      expect(logs).not.toContain("Targeting managed gateway service package root");
      if (selected) {
        expect(logs).toContain("differs from the managed gateway service Node");
        expect(logs).toContain(serviceNode);
        expect(logs).toContain(
          "Using the managed service Node for this update so the gateway can start after the upgrade",
        );
      } else {
        expect(logs).not.toContain("differs from the managed gateway service Node");
        expect(logs).not.toContain(serviceNode);
      }
    },
  );

  it("refreshes the managed service to current Node when its baked Node cannot run the target", async () => {
    const servicePrefix = tempDirs.make("openclaw-service-prefix-");
    const { nodeModules, root, serviceNode, serviceNpm, serviceNpmReal, entrypoint } =
      await setupServicePackageAtPrefix({ prefix: servicePrefix });
    // Same package root for both shell and service.
    mockPackageInstallStatus(root);
    primeServiceCommand([serviceNode, entrypoint, "gateway"]);
    serviceLoaded.mockResolvedValue(true);
    primeNpmChannelTag("latest", "2026.7.1");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({
        target: "latest",
        version: "2026.7.1",
        nodeEngine: ">=24.15.0 <25",
      }),
    );
    nodeVersionSatisfiesEngine.mockImplementation(
      (version: string | null) => version === "24.15.0",
    );
    mockFileBackedPathExists();
    mockServicePackageCommands({
      nodeModules,
      packageRoot: root,
      targetVersion: "2026.7.1",
      npmCommands: [serviceNpm, serviceNpmReal!],
      nodeVersions: { [serviceNode]: "v24.14.0", [process.execPath]: "v24.15.0" },
    });

    await updateCommand({ yes: true });

    const logs = getLogOutput();
    expect(logs).toContain(`Managed gateway service Node (${serviceNode}) cannot run`);
    expect(logs).toContain(`Using current Node (${process.execPath})`);
  });

  it("pins package install to the service root when nodes differ and no owning npm exists at the prefix", async () => {
    const servicePrefix = tempDirs.make("openclaw-no-npm-prefix-");
    // Create the node binary but intentionally do NOT create <prefix>/bin/npm
    // so resolvePreferredNpmCommand returns null and the PATH npm is used.
    const { root, serviceNode, entrypoint } = await setupServicePackageAtPrefix({
      prefix: servicePrefix,
      withNpm: false,
    });
    // No npm binary at servicePrefix/bin/npm!
    mockPackageInstallStatus(root);
    primeServiceCommand([serviceNode, entrypoint, "gateway"]);
    serviceLoaded.mockResolvedValue(true);
    primeNpmChannelTag("latest", "2026.5.20");
    mockFileBackedPathExists();
    // The PATH npm returns a DIFFERENT global root (simulates Node-B's npm).
    // PATH npm returns Node-B's root, NOT the service root.
    // Install step: create the expected package structure at the target.
    const nodeBGlobalRoot = path.join(tempDirs.make("node-b-global-"), "lib", "node_modules");
    await fs.mkdir(nodeBGlobalRoot, { recursive: true });
    mockServicePackageCommands({
      nodeModules: nodeBGlobalRoot,
      packageRoot: root,
      targetVersion: "2026.5.20",
      npmCommands: ["npm"],
      nodeVersions: { [serviceNode]: "v24.14.0" },
    });

    await updateCommand({ yes: true });

    // The install command must use --prefix pointing to a location within
    // the service root's prefix tree, NOT Node-B's global root.
    const installCall = packageInstallCommandCall();
    expect(installCall).toBeDefined();
    const installArgv = installCall![0];
    const prefixIdx = installArgv.indexOf("--prefix");
    expect(prefixIdx).toBeGreaterThan(-1);
    // Staging prefix should be under the service prefix, not Node-B's.
    expect(installArgv[prefixIdx + 1]).toContain(servicePrefix);
    expect(installArgv[prefixIdx + 1]).not.toContain(nodeBGlobalRoot);
    // Follow-up commands use the service node.
    expect(doctorCommandCall()?.[0][0]).toBe(serviceNode);
  });

  it("repairs legacy config before persisting a requested update channel", async () => {
    mockPackageInstallAtCaseDir();
    mockCurrentProcessFreshDoctor();
    const legacyConfig = {
      channels: {
        slack: {
          streaming: "partial",
          nativeStreaming: false,
        },
        telegram: {
          streaming: "block",
        },
      },
    } as OpenClawConfig;
    const migratedConfig = {
      channels: {
        slack: {
          streaming: {
            mode: "partial",
            nativeTransport: false,
          },
        },
        telegram: {
          streaming: {
            mode: "block",
          },
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot)
      .mockResolvedValueOnce(
        configSnapshot(legacyConfig, {
          valid: false,
          hash: "legacy-hash",
          issues: [
            {
              path: "channels.slack.streaming",
              message: "Invalid input: expected object, received string",
            },
          ],
          legacyIssues: [
            {
              path: "channels.slack",
              message: "legacy slack streaming keys",
            },
            {
              path: "channels.telegram",
              message: "legacy telegram streaming keys",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(configSnapshot(migratedConfig, { valid: true, hash: "migrated-hash" }))
      .mockResolvedValueOnce(configSnapshot(migratedConfig, { valid: true, hash: "migrated-hash" }))
      .mockResolvedValue(configSnapshot(migratedConfig, { valid: true, hash: "migrated-hash" }));
    legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mockImplementationOnce(
      async (params: { configSnapshot: ConfigFileSnapshot; jsonMode: boolean }) => {
        await replaceConfigFile({
          nextConfig: migratedConfig,
          baseHash: params.configSnapshot.hash,
          writeOptions: {
            allowConfigSizeDrop: true,
            skipOutputLogs: params.jsonMode,
          },
        });
        return {
          snapshot: await readConfigFileSnapshot(),
          repaired: true,
        };
      },
    );

    await updateCommand({ channel: "beta", yes: true });

    const repairCall =
      legacyConfigRepairMocks.repairLegacyConfigForUpdateChannel.mock.calls[0]?.[0];
    expect(repairCall?.configSnapshot.hash).toBe("legacy-hash");
    expect(repairCall?.configSnapshot.valid).toBe(false);
    expect(repairCall?.jsonMode).toBe(false);
    expect(replaceConfigFile).toHaveBeenCalledTimes(2);
    const replaceCalls = vi.mocked(replaceConfigFile).mock.calls.map((call) => call[0]);
    expect(replaceCalls[0]).toEqual({
      nextConfig: migratedConfig,
      baseHash: "legacy-hash",
      writeOptions: {
        allowConfigSizeDrop: true,
        skipOutputLogs: false,
      },
    });
    expect(replaceCalls[1]).toEqual({
      nextConfig: {
        ...migratedConfig,
        update: {
          channel: "beta",
        },
      },
      baseHash: "migrated-hash",
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("does not auto-repair legacy config when authored includes are present", async () => {
    mockPackageInstallAtCaseDir();
    const legacyConfigWithInclude = {
      $include: "./channels.json5",
      channels: {
        slack: {
          streaming: "partial",
          nativeStreaming: false,
        },
      },
    } as unknown as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce(
      configSnapshot(legacyConfigWithInclude, {
        valid: false,
        hash: "legacy-include-hash",
        issues: [
          {
            path: "channels.slack.streaming",
            message: "Invalid input: expected object, received string",
          },
        ],
        legacyIssues: [
          {
            path: "channels.slack",
            message: "legacy slack streaming keys",
          },
        ],
      }),
    );

    await updateCommand({ channel: "beta", yes: true });

    expectNoSideEffects(replaceConfigFile, runCommandWithTimeout);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("does not repair legacy config during a dry run", async () => {
    mockPackageInstallAtCaseDir();
    const legacyConfig = {
      channels: {
        slack: {
          streaming: "partial",
          nativeStreaming: false,
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce(
      configSnapshot(legacyConfig, {
        valid: false,
        hash: "legacy-hash",
        issues: [
          {
            path: "channels.slack.streaming",
            message: "Invalid input: expected object, received string",
          },
        ],
        legacyIssues: [
          {
            path: "channels.slack",
            message: "legacy slack streaming keys",
          },
        ],
      }),
    );

    await updateCommand({ dryRun: true, channel: "beta", yes: true });

    expectNoSideEffects(
      replaceConfigFile,
      runCommandWithTimeout,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("does not persist the requested channel when the package update fails", async () => {
    mockPackageInstallAtCaseDir();
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        return commandResult({ stderr: "install failed", code: 1 });
      }
      return commandResult();
    });

    await updateCommand({ channel: "beta", yes: true });

    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps the requested channel when plugin sync writes config after update", async () => {
    mockPackageInstallAtCaseDir();
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) =>
      pluginSyncResult(config, true),
    );
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );

    await updateCommand({ channel: "beta", yes: true });

    const lastWrite = lastReplaceConfigCall() as
      | { nextConfig?: { update?: { channel?: string } } }
      | undefined;
    expect(lastWrite?.nextConfig?.update?.channel).toBe("beta");
  });

  it("refreshes post-doctor config before post-update plugin sync", async () => {
    mockPackageInstallAtCaseDir();
    const preUpdateConfig = { update: { channel: "stable" } } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "stable" },
      meta: { lastTouchedVersion: "2026.5.14" },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot)
      .mockResolvedValueOnce({
        ...baseSnapshot,
        sourceConfig: preUpdateConfig,
        config: preUpdateConfig,
        hash: "pre-update-hash",
      })
      .mockResolvedValue({
        ...baseSnapshot,
        sourceConfig: postDoctorConfig,
        config: postDoctorConfig,
        hash: "post-doctor-hash",
      });
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) =>
      pluginSyncResult(
        {
          ...config,
          plugins: {
            ...config.plugins,
            load: { paths: ["/tmp/openclaw-updated-plugin"] },
          },
        },
        true,
      ),
    );
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );

    await updateCommand({ yes: true });

    const syncConfig = syncPluginCall()?.config as
      | (OpenClawConfig & { meta?: { lastTouchedVersion?: string } })
      | undefined;
    const lastWrite = lastReplaceConfigCall() as
      | {
          baseHash?: string;
          nextConfig?: OpenClawConfig & { meta?: { lastTouchedVersion?: string } };
        }
      | undefined;
    expect(syncConfig?.meta?.lastTouchedVersion).toBe("2026.5.14");
    expect(lastWrite?.baseHash).toBe("post-doctor-hash");
    expect(lastWrite?.nextConfig?.meta?.lastTouchedVersion).toBe("2026.5.14");
  });

  it("restores pre-update channels when post-core resume sees post-doctor config without them", async () => {
    const preUpdateConfig = stableWhatsAppConfig();
    const postDoctorConfig = stableConfig({ meta: { lastTouchedVersion: "2026.5.14" } });
    await setupPostCoreConfigFixture({
      preUpdateConfig,
      backupConfig: postDoctorConfig,
      postDoctorConfig,
    });

    await runPostCoreUpdate();

    const syncConfig = syncPluginCall()?.config as
      | (OpenClawConfig & { meta?: { lastTouchedVersion?: string } })
      | undefined;
    const lastWrite = lastReplaceConfigCall() as
      | {
          baseHash?: string;
          nextConfig?: OpenClawConfig & {
            meta?: { lastTouchedVersion?: string };
            channels?: { whatsapp?: { enabled?: boolean; dmPolicy?: string } };
          };
        }
      | undefined;
    expect(syncConfig?.channels?.whatsapp).toEqual(preUpdateConfig.channels?.whatsapp);
    expect(syncConfig?.meta?.lastTouchedVersion).toBe("2026.5.14");
    expect(lastWrite?.baseHash).toBe("post-doctor-hash");
    expect(lastWrite?.nextConfig?.channels?.whatsapp).toEqual(preUpdateConfig.channels?.whatsapp);
    expect(lastWrite?.nextConfig?.meta?.lastTouchedVersion).toBe("2026.5.14");
  });

  it("restores pre-update channel model overrides when post-core resume restores a channel", async () => {
    const preUpdateConfig = {
      update: { channel: "stable" },
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "pairing",
        },
        telegram: {
          enabled: true,
        },
        modelByChannel: {
          openai: {
            whatsapp: "openai/gpt-5.5",
            telegram: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "stable" },
      channels: {
        telegram: {
          enabled: true,
        },
        modelByChannel: {
          openai: {
            telegram: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;
    await setupPostCoreConfigFixture({ preUpdateConfig, postDoctorConfig });

    await runPostCoreUpdate();

    const syncConfig = syncPluginCall()?.config as
      | (OpenClawConfig & {
          channels?: {
            modelByChannel?: Record<string, Record<string, string>>;
          };
        })
      | undefined;
    const lastWrite = lastReplaceConfigCall() as
      | {
          nextConfig?: OpenClawConfig & {
            channels?: {
              modelByChannel?: Record<string, Record<string, string>>;
            };
          };
        }
      | undefined;
    expect(syncConfig?.channels?.modelByChannel?.openai?.whatsapp).toBe("openai/gpt-5.5");
    expect(syncConfig?.channels?.modelByChannel?.openai?.telegram).toBe("openai/gpt-5.4");
    expect(lastWrite?.nextConfig?.channels?.modelByChannel?.openai?.whatsapp).toBe(
      "openai/gpt-5.5",
    );
    expect(lastWrite?.nextConfig?.channels?.modelByChannel?.openai?.telegram).toBe(
      "openai/gpt-5.4",
    );
  });

  it.each([
    {
      name: "does not restore stale backup channels when current pre-update snapshot has none",
      prepare: async (configPath: string, preUpdateConfig: OpenClawConfig) => {
        await writeJsonFixture(`${configPath}.pre-update`, stableConfig());
        await writeJsonFixture(`${configPath}.bak`, preUpdateConfig);
        return {};
      },
    },
    {
      name: "ignores pre-update channel snapshots older than the current update attempt",
      prepare: async (configPath: string, preUpdateConfig: OpenClawConfig) => {
        const updateStartedAtMs = Date.now();
        const staleTime = new Date(updateStartedAtMs - 60_000);
        for (const suffix of [".pre-update", ".bak"]) {
          const snapshotPath = `${configPath}${suffix}`;
          await writeJsonFixture(snapshotPath, preUpdateConfig);
          await fs.utimes(snapshotPath, staleTime, staleTime);
        }
        return { OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(updateStartedAtMs) };
      },
    },
    {
      name: "ignores disk fallback snapshots when the update attempt start is unknown",
      prepare: async (configPath: string, preUpdateConfig: OpenClawConfig) => {
        for (const suffix of [".pre-update", ".bak"]) {
          await writeJsonFixture(`${configPath}${suffix}`, preUpdateConfig);
        }
        vi.mocked(runExec).mockRejectedValueOnce(new Error("ps unavailable"));
        return {};
      },
    },
    {
      name: "ignores stale pre-update channel snapshots during post-core resume",
      preserveParsed: true,
      prepare: async (configPath: string) => {
        const staleConfig = {
          channels: { whatsapp: { enabled: true } },
        } as OpenClawConfig;
        const snapshotPath = `${configPath}.pre-update`;
        await writeJsonFixture(snapshotPath, staleConfig);
        const staleTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
        await fs.utimes(snapshotPath, staleTime, staleTime);
        return {};
      },
    },
  ])("$name", async ({ prepare, preserveParsed = false }) => {
    const tempDir = createCaseDir("openclaw-update");
    const configPath = path.join(tempDir, "openclaw.json");
    const preUpdateConfig = stableWhatsAppConfig();
    const postDoctorConfig = stableConfig();
    await fs.mkdir(tempDir, { recursive: true });
    const env = await prepare(configPath, preUpdateConfig);
    await writeJsonFixture(configPath, postDoctorConfig);
    mockPostDoctorSnapshot(configPath, postDoctorConfig, { preserveParsed });
    mockNoopPostUpdatePluginConvergence();

    await runPostCoreUpdate(env);

    expect(syncPluginCall()?.config?.channels?.whatsapp).toBeUndefined();
    expect(lastReplaceConfigCall()).toBeUndefined();
  });

  it("uses the Windows parent process start time for old post-core parents", async () => {
    const preUpdateConfig = stableWhatsAppConfig();
    const postDoctorConfig = stableConfig();
    await setupPostCoreConfigFixture({ preUpdateConfig, postDoctorConfig });
    vi.mocked(runExec).mockImplementationOnce(async (file, commandArgs) => {
      expect(file).toBe("powershell.exe");
      expect(commandArgs).toContain("-NonInteractive");
      return {
        stdout: new Date(Date.now() - 1_000).toISOString(),
        stderr: "",
      };
    });
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "win32",
    });
    try {
      await runPostCoreUpdate();
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }

    expect(syncPluginCall()?.config?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    expect(lastReplaceConfigCall()).toBeDefined();
  });

  it("persists authored channel values when post-core restore input is resolved", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const sourceConfigPath = path.join(tempDir, "source-config.json");
    const resolvedPreUpdateConfig = {
      update: { channel: "stable" },
      channels: {
        whatsapp: {
          enabled: true,
          token: "resolved-secret",
        },
      },
    } as OpenClawConfig;
    const authoredPreUpdateConfig = {
      update: { channel: "stable" },
      channels: {
        whatsapp: {
          enabled: true,
          token: "${WHATSAPP_TOKEN}",
        },
      },
    } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "stable" },
      meta: { lastTouchedVersion: "2026.5.14" },
    } as OpenClawConfig;
    await fs.mkdir(tempDir, { recursive: true });
    await writeJsonFixture(sourceConfigPath, {
      sourceConfig: resolvedPreUpdateConfig,
      authoredConfig: authoredPreUpdateConfig,
    });
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      sourceConfig: postDoctorConfig,
      config: postDoctorConfig,
      runtimeConfig: postDoctorConfig,
      hash: "post-doctor-hash",
    });
    mockNoopPostUpdatePluginConvergence();

    await runPostCoreUpdate({ OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: sourceConfigPath });

    const syncConfig = syncPluginCall()?.config as
      | (OpenClawConfig & { channels?: { whatsapp?: { token?: string } } })
      | undefined;
    const lastWrite = lastReplaceConfigCall() as
      | {
          nextConfig?: OpenClawConfig & {
            channels?: { whatsapp?: { token?: string } };
          };
        }
      | undefined;
    expect(syncConfig?.channels?.whatsapp?.token).toBe("resolved-secret");
    expect(lastWrite?.nextConfig?.channels?.whatsapp?.token).toBe("${WHATSAPP_TOKEN}");
  });

  it("resolves included pre-update channels for old post-core parents", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const configPath = path.join(tempDir, "openclaw.json");
    const channelsPath = path.join(tempDir, "channels.json5");
    const includedChannels = {
      whatsapp: {
        enabled: true,
        token: "${WHATSAPP_TOKEN}",
      },
    };
    const preUpdateConfig = {
      update: { channel: "stable" },
      channels: { $include: "./channels.json5" },
    } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "stable" },
      channels: {},
    } as OpenClawConfig;
    await fs.mkdir(tempDir, { recursive: true });
    await writeJsonFixture(channelsPath, includedChannels);
    await writeJsonFixture(`${configPath}.bak`, preUpdateConfig);
    await writeJsonFixture(configPath, postDoctorConfig);
    mockPostDoctorSnapshot(configPath, postDoctorConfig);
    mockNoopPostUpdatePluginConvergence();

    await runPostCoreUpdate({ WHATSAPP_TOKEN: "resolved-token" });

    const syncConfig = syncPluginCall()?.config as
      | (OpenClawConfig & { channels?: { whatsapp?: { token?: string } } })
      | undefined;
    const lastWrite = lastReplaceConfigCall() as
      | {
          nextConfig?: OpenClawConfig & {
            channels?: { $include?: string };
          };
        }
      | undefined;
    expect(syncConfig?.channels?.whatsapp?.token).toBe("resolved-token");
    expect(lastWrite?.nextConfig?.channels).toEqual({ $include: "./channels.json5" });
  });

  it("uses source config and plugin index records for post-update plugin sync", async () => {
    mockPackageInstallAtCaseDir();
    const pluginInstallRecords = {
      "lossless-claw": {
        source: "npm",
        spec: "@martian-engineering/lossless-claw",
        installPath: "/tmp/lossless-claw",
      },
    } as const;
    const sourceConfig = {
      plugins: {},
    } as OpenClawConfig;
    loadInstalledPluginIndexInstallRecords.mockResolvedValue(pluginInstallRecords);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      sourceConfig,
      config: {
        ...sourceConfig,
        gateway: { auth: { mode: "token", token: "runtime" } },
        plugins: {
          ...sourceConfig.plugins,
          entries: {
            firecrawl: {
              config: {
                webFetch: { provider: "firecrawl" },
              },
            },
          },
        },
      } as OpenClawConfig,
    });
    syncPluginsForUpdateChannel.mockResolvedValue(pluginSyncResult(sourceConfig));
    updateNpmInstalledPlugins.mockResolvedValue(npmPluginUpdateResult(sourceConfig));

    await updateCommand({ channel: "beta", yes: true });

    const syncConfig = syncPluginCall()?.config;
    const updateCall = npmPluginUpdateCall() as
      | { skipDisabledPlugins?: boolean; syncOfficialPluginInstalls?: boolean }
      | undefined;
    expect(syncConfig?.plugins?.installs).toEqual(pluginInstallRecords);
    expect(syncConfig?.update?.channel).toBe("beta");
    expect(syncConfig?.gateway?.auth).toBeUndefined();
    expect(syncConfig?.plugins?.entries).toBeUndefined();
    expect(updateCall?.skipDisabledPlugins).toBe(true);
    expect(updateCall?.syncOfficialPluginInstalls).toBe(true);
  });

  it.each(["ok", "error"] as const)(
    "hands the checkout to global activation and fresh finalization only after Git update success (%s)",
    async (status) => {
      const tempDir = createCaseDir("openclaw-update");
      const gitRoot = path.join(tempDir, "..", "openclaw");
      const completionCacheSpy = vi
        .spyOn(updateCliShared, "tryWriteCompletionCache")
        .mockResolvedValueOnce("completed");
      const nodeModules = path.join(tempDir, "prefix", "lib", "node_modules");
      const packageRoot = path.join(nodeModules, "openclaw");
      const sha = "a".repeat(40);
      await writeOpenClawPackageFixture(packageRoot, "2026.4.10", { inventory: true });
      await writeOpenClawPackageFixture(gitRoot, "2026.8.1", { git: true, builtSha: sha });
      mockPackageInstallStatus(packageRoot);
      mockFileBackedPathExists();
      mockNpmGlobalCommands(nodeModules, undefined, gitRoot);
      vi.mocked(readConfigFileSnapshot).mockResolvedValue({
        ...baseSnapshot,
        parsed: { update: { channel: "stable" } },
        resolved: { update: { channel: "stable" } } as OpenClawConfig,
        sourceConfig: { update: { channel: "stable" } } as OpenClawConfig,
        runtimeConfig: { update: { channel: "stable" } } as OpenClawConfig,
        config: { update: { channel: "stable" } } as OpenClawConfig,
      });
      vi.mocked(runGatewayUpdate).mockResolvedValue(
        makeOkUpdateResult({
          status,
          mode: "git",
          root: gitRoot,
          after: { sha, version: "2026.8.1" },
        }),
      );
      mockNoopPostUpdatePluginConvergence();

      await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
        await updateCommand({ channel: "dev", yes: true, restart: false });
      });
      if (status === "error") {
        expect(packageInstallCommandCall()).toBeUndefined();
        expectNoSideEffects(spawn, replaceConfigFile, completionCacheSpy);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2026.4.10"');
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
        return;
      }
      await expect(fs.realpath(packageRoot)).resolves.toBe(await fs.realpath(gitRoot));
      // A real built entry resumes finalization in fresh code, not this old process.
      expect(spawnCall()?.[1]?.[0]).toBe(path.join(gitRoot, "dist", "entry.js"));
      expect(spawnCall()?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_CHANNEL).toBe("dev");
      expect(spawnCall()?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
      expectNoSideEffects(
        replaceConfigFile,
        syncPluginsForUpdateChannel,
        updateNpmInstalledPlugins,
      );
      expect(completionCacheSpy).toHaveBeenCalledWith(gitRoot, false);
      expectNoSideEffects(runRestartScript, runDaemonRestart);
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    },
  );

  it("explains why git updates cannot run with edited files", async () => {
    vi.mocked(defaultRuntime.log).mockClear();
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "skipped",
      mode: "git",
      reason: "dirty",
      steps: [],
      durationMs: 100,
    } satisfies UpdateRunResult);

    await updateCommand({ channel: "dev" });

    const errors = getErrorOutput();
    const logs = getLogOutput();
    expect(errors).toContain("Update blocked: local files are edited in this checkout.");
    expect(logs).toContain(
      "Git-based updates need a clean working tree before they can switch commits, fetch, or rebase.",
    );
    expect(logs).toContain(
      "Commit, stash, or discard the local changes, then rerun `openclaw update`.",
    );
    expect(serviceStop).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
  it.each([
    {
      name: "refreshes service env when already installed",
      run: async () => {
        mockOwnedGitService();
        mockGitUpdateAfterMutation();
        vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
        serviceLoaded.mockResolvedValue(true);

        await updateCommand({});
      },
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith({
          force: true,
          json: undefined,
        });
        expect(runRestartScript).toHaveBeenCalledTimes(1);
        expect(runDaemonRestart).not.toHaveBeenCalled();
        expect(getLogOutput()).toContain("Gateway: restarted and verified.");
      },
    },
    {
      name: "falls back to daemon restart when service env refresh cannot complete",
      run: async () => {
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        await runRestartFallbackScenario({ daemonInstall: "fail" });
      },
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith({
          force: true,
          json: undefined,
        });
        expect(runDaemonRestart).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "keeps going when daemon install succeeds but restart fallback still handles relaunch",
      run: async () => {
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        await runRestartFallbackScenario({ daemonInstall: "ok" });
      },
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith({
          force: true,
          json: undefined,
        });
        expect(runDaemonRestart).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "skips service env refresh when --no-restart is set",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        serviceLoaded.mockResolvedValue(true);

        await updateCommand({ restart: false });
      },
      assert: () => {
        expectNoSideEffects(runDaemonInstall, runRestartScript, runDaemonRestart);
        expect(vi.mocked(runGatewayUpdate).mock.calls[0]?.[0]?.allowGatewayActivation).toBe(false);
        expect(getLogOutput()).toContain("Gateway: restart skipped (--no-restart).");
      },
    },
    {
      name: "skips success message when restart does not run",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(runDaemonRestart).mockResolvedValue(false);
        vi.mocked(defaultRuntime.log).mockClear();
        await updateCommand({ restart: true });
      },
      assert: () => {
        const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(logLines.some((line) => line.includes("Daemon restarted successfully."))).toBe(
          false,
        );
        expect(logLines.some((line) => line.includes("Gateway: restarted and verified."))).toBe(
          false,
        );
      },
    },
  ] as const)("updateCommand service refresh behavior: $name", runUpdateCliScenario);

  it("reports activation failure when the updated CLI entrypoint is missing", async () => {
    mockPackageInstallAtCaseDir();
    mockCurrentProcessFreshDoctor();
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));

    await updateCommand({ yes: true });

    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(serviceStart).not.toHaveBeenCalled();
    expect(freshRestartCalls().length).toBe(0);
    expectNoSideEffects(prepareRestartScript, runRestartScript);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("tries the updated install restart when package service refresh fails", async () => {
    const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", updatedEntrypoint, "gateway", "run"]);
    mockGatewayInstallFailure(updatedEntrypoint);
    mockGatewayProbe("2026.4.24", "updated-gateway");

    await updateCommand({ yes: true });

    expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
    const restartCall = gatewayCommandCall(updatedEntrypoint, "restart");
    expect(restartCall?.[0].slice(1)).toEqual([updatedEntrypoint, "gateway", "restart"]);
    expect(restartCall?.[1].cwd).toBe(updatedRoot);
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
  });

  it("accepts same-version refresh failure recovery when the managed service restarts", async () => {
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    const updatedPackageJson = path.join(updatedRoot, "package.json");
    setupUpdatedRootRefresh({
      entrypoints: [updatedEntrypoint],
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.24" },
          after: { version: "2026.4.24" },
        }),
    });
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === updatedEntrypoint || candidate === updatedPackageJson,
    );
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", updatedEntrypoint, "gateway", "run"]);
    mockGatewayInstallFailure(updatedEntrypoint);
    mockGatewayProbe("2026.4.24", "matching-old-gateway");

    await updateCommand({ yes: true });

    expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
    expect(gatewayCommandCall(updatedEntrypoint, "restart")).toBeDefined();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("leaves a same-version service untouched when its package root is foreign", async () => {
    const oldRoot = createCaseDir("openclaw-old-root");
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const oldEntrypoint = path.join(oldRoot, "dist", "entry.js");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    const oldPackageJson = path.join(oldRoot, "package.json");
    const updatedPackageJson = path.join(updatedRoot, "package.json");
    setupUpdatedRootRefresh({
      entrypoints: [oldEntrypoint, updatedEntrypoint],
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.24" },
          after: { version: "2026.4.24" },
        }),
    });
    pathExists.mockImplementation(async (candidate: string) =>
      [oldEntrypoint, updatedEntrypoint, oldPackageJson, updatedPackageJson].includes(candidate),
    );
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", oldEntrypoint, "gateway", "run"]);
    mockGatewayInstallFailure(updatedEntrypoint);
    mockGatewayProbe("2026.4.24", "matching-old-service");

    await updateCommand({ yes: true });

    expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeUndefined();
    expect(gatewayCommandCall(updatedEntrypoint, "restart")).toBeUndefined();
    expectNoSideEffects(
      serviceStop,
      serviceStart,
      serviceRestart,
      prepareRestartScript,
      runRestartScript,
    );
    expect(getErrorOutput()).toContain("service belongs to a different OpenClaw installation");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("fails a JSON package update when fallback restart leaves the old gateway running", async () => {
    const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
    prepareRestartScript.mockResolvedValue(null);
    serviceLoaded.mockResolvedValue(true);
    mockGatewayProbe("2026.4.23", "old-gateway");

    await updateCommand({ yes: true, json: true, timeout: "123" });

    expectNoSideEffects(runRestartScript, runDaemonRestart);
    const restartCall = gatewayCommandCall(updatedEntrypoint, "restart");
    expect(restartCall?.[0][0]).toContain("node");
    expect(restartCall?.[0].slice(1)).toEqual([updatedEntrypoint, "gateway", "restart", "--json"]);
    expect(restartCall?.[1].cwd).toBe(updatedRoot);
    expect(restartCall?.[1].timeoutMs).toBe(123_000);
    const probeCall = probeGatewayCall() as { includeDetails?: boolean } | undefined;
    expect(probeCall?.includeDetails).toBe(true);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "restart-unhealthy" });
    expect(getErrorOutput()).toContain(
      "Gateway version mismatch: expected 2026.4.24, running gateway reported 2026.4.23.",
    );
    expect(doctorCommand).not.toHaveBeenCalled();
  });

  it("shows the matching-version probe failure when a JSON package update restart stays unhealthy", async () => {
    setupNpmUpdatedRootRefresh();
    prepareRestartScript.mockResolvedValue(null);
    serviceLoaded.mockResolvedValue(true);
    restartHealthTestControl.snapshot = {
      runtime: { status: "running", pid: gatewayFixturePid },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: gatewayFixturePid, command: "openclaw-gateway" }],
        hints: [],
      },
      healthy: false,
      staleGatewayPids: [],
      gatewayVersion: "2026.4.24",
      expectedVersion: "2026.4.24",
      probeError: "timeout",
      waitOutcome: "timeout",
      elapsedMs: 60_000,
    };

    await updateCommand({ yes: true, json: true, timeout: "123" });

    const diagnostics = getErrorOutput();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(diagnostics).toContain("Gateway probe failed: timeout");
    expect(diagnostics).toContain("Port 18789 is already in use.");
    expect(diagnostics).not.toContain("Gateway version mismatch");
  });

  it("skips the post-refresh restart script when LaunchAgent already serves the expected package version", async () => {
    const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
    serviceLoaded.mockResolvedValue(true);
    mockGatewayProbe("2026.4.24", "updated-gateway");

    await updateCommand({ yes: true });

    const installCall = gatewayCommandCall(updatedEntrypoint, "install");
    expect(installCall?.[0][0]).toContain("node");
    expect(installCall?.[0].slice(1)).toEqual([updatedEntrypoint, "gateway", "install", "--force"]);
    expect(installCall?.[1].cwd).toBe(updatedRoot);
    expect(installCall?.[1].timeoutMs).toBe(60_000);
    expect(gatewayCommandCall(updatedEntrypoint, "restart")).toBeUndefined();
    expect(runRestartScript).not.toHaveBeenCalled();
    const probeCall = probeGatewayCall() as { includeDetails?: boolean } | undefined;
    expect(probeCall?.includeDetails).toBe(true);
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("writes the control-plane update sentinel after managed package restart health passes", async () => {
    const sentinel = await runControlPlaneUpdate({
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        deliveryContext: { channel: "webchat", to: "webchat:user-123", accountId: "default" },
        note: "Update requested from the agent.",
        continuationMessage: "Check the running version and finish the update report.",
      },
      options: { yes: true, json: true },
      beforeUpdate: () => {
        setupNpmUpdatedRootRefresh();
        serviceLoaded.mockResolvedValue(true);
        mockGatewayProbe("2026.4.24", "updated-gateway");
      },
    });
    expect(sentinel?.payload.status).toBe("ok");
    expect(sentinel?.payload.message).toBe("Update requested from the agent.");
    expect(sentinel?.payload.continuation).toEqual({
      kind: "agentTurn",
      message: "Check the running version and finish the update report.",
    });
    expect(sentinel?.payload.stats?.mode).toBe("npm");
    expect(sentinel?.payload.stats?.after?.version).toBe("2026.4.24");
  });

  it("rejects a managed handoff launched from a different canonical install root", async () => {
    const sentinel = await runControlPlaneUpdate({
      meta: {
        root: path.join(process.cwd(), "other-checkout"),
        handoffId: "wrong-root-handoff",
      },
      options: { yes: true, json: true },
    });

    expect(sentinel).toBeNull();
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(getErrorOutput()).toContain("Managed update handoff root mismatch");
  });

  it("does not write a control-plane sentinel when a dry-run preflight fails", async () => {
    const sentinel = await runControlPlaneUpdate({
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        handoffId: "extended-stable-dry-run",
        note: "Preview requested from the agent.",
      },
      options: { channel: "extended-stable", dryRun: true, yes: true, json: true },
      beforeUpdate: () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
          status: "failed",
          reason: "selector_missing",
        });
      },
    });

    expect(sentinel).toBeNull();
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("writes an extended-stable selector failure to the control-plane sentinel", async () => {
    const sentinel = await runControlPlaneUpdate({
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        handoffId: "extended-stable-handoff",
        note: "Update requested from the agent.",
      },
      options: { channel: "extended-stable", yes: true, json: true },
      beforeUpdate: () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
          status: "failed",
          reason: "selector_missing",
        });
      },
    });
    expect(sentinel?.payload.status).toBe("error");
    expect(sentinel?.payload.stats?.reason).toBe("selector_missing");
    expect(sentinel?.payload.stats?.handoffId).toBe("extended-stable-handoff");
    expect(sentinel?.payload.continuation).toBeUndefined();
  });

  it.each([false, true])(
    "preserves control-plane update sentinel consumption on restart health failure (consumed=%s)",
    async (consumed) => {
      let sentinelConsumed = false;
      const sentinel = await runControlPlaneUpdate({
        meta: {
          sessionKey: "agent:main:webchat:dm:user-123",
          continuationMessage: "This should not report a successful update.",
        },
        options: { yes: true, json: true },
        beforeUpdate: async () => {
          setupNpmUpdatedRootRefresh();
          prepareRestartScript.mockResolvedValue(null);
          serviceLoaded.mockResolvedValue(true);
          mockGatewayProbe("2026.4.23", "old-gateway");
          if (consumed) {
            const probeResult = await probeGateway();
            probeGateway.mockImplementation(async () => {
              sentinelConsumed = (await clearRestartSentinel()) || sentinelConsumed;
              return probeResult;
            });
          }
        },
      });
      if (consumed) {
        expect(sentinelConsumed).toBe(true);
        expect(sentinel).toBeNull();
      } else {
        expect(sentinel?.payload.status).toBe("error");
        expect(sentinel?.payload.stats?.reason).toBe("restart-unhealthy");
        expect(sentinel?.payload.continuation).toBeUndefined();
      }
      expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "restart-unhealthy" });
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("fails a package update when the restarted gateway reports activated plugin load errors", async () => {
    setupNpmUpdatedRootRefresh();
    readPackageVersion.mockResolvedValue("2026.4.24");
    serviceLoaded.mockResolvedValue(true);
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: {
        version: "2026.4.24",
        connId: "updated-gateway",
      },
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      health: {
        ok: true,
        plugins: {
          errors: [
            {
              id: "telegram",
              origin: "bundled",
              activated: true,
              error: "failed to load plugin dependency: ENOSPC",
            },
          ],
        },
      },
      status: null,
      presence: null,
      configSnapshot: null,
      connectLatencyMs: 1,
      error: null,
      url: "ws://127.0.0.1:18789",
    });

    await updateCommand({ yes: true });

    expect(runRestartScript).toHaveBeenCalledTimes(1);
    const probeCall = probeGatewayCall() as { includeDetails?: boolean } | undefined;
    expect(probeCall?.includeDetails).toBe(true);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(getLogOutput()).toContain("- telegram: failed to load plugin dependency: ENOSPC");
  });

  it("merges current auth refs with captured service selectors for updated install refresh", async () => {
    const invocationCwd = process.cwd();
    let setup: ReturnType<typeof setupUpdatedRootRefresh> | undefined;
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_AUTH_TOKEN: undefined,
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: path.relative(invocationCwd, profileStateDir("personal")),
        OPENCLAW_CONFIG_PATH: path.relative(
          invocationCwd,
          path.join(profileStateDir("personal"), "openclaw.json"),
        ),
        PATH: "/caller/bin",
      },
      async () => {
        setup = setupUpdatedRootRefresh({
          gatewayUpdateImpl: async (root) => {
            process.env.OPENCLAW_GATEWAY_AUTH_TOKEN = "runtime-auth-ref";
            return {
              status: "ok",
              mode: "npm",
              root,
              steps: [],
              durationMs: 100,
            };
          },
        });
        primeServiceCommand([process.execPath, setup.entrypoints[0], "gateway", "run"], {
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: path.relative(invocationCwd, profileStateDir("work")),
          OPENCLAW_CONFIG_PATH: path.relative(
            invocationCwd,
            path.join(profileStateDir("work"), "openclaw.json"),
          ),
          PATH: "/service/bin",
        });

        await updateCommand({});
      },
    );

    const entryPath = expectDefined(setup?.entrypoints[0], "updated entrypoint");
    const installEnv = gatewayCommandCall(entryPath, "install")?.[1].env as
      | NodeJS.ProcessEnv
      | undefined;
    expect(installEnv?.OPENCLAW_GATEWAY_AUTH_TOKEN).toBe("runtime-auth-ref");
    expect(installEnv?.OPENCLAW_STATE_DIR).toBe(profileStateDir("work"));
    expect(installEnv?.OPENCLAW_CONFIG_PATH).toBe(
      path.join(profileStateDir("work"), "openclaw.json"),
    );
    expect(installEnv?.PATH).toBe("/service/bin");
  });

  it.each([
    {
      name: "updateCommand refreshes service env from updated install root when available",
      invoke: async () => {
        await updateCommand({});
      },
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
        expect(runRestartScript).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "updateCommand preserves invocation-relative service env overrides during refresh",
      invoke: async () => {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: path.relative(process.cwd(), profileStateDir()),
            OPENCLAW_CONFIG_PATH: path.relative(
              process.cwd(),
              path.join(profileStateDir(), "openclaw.json"),
            ),
          },
          async () => {
            await updateCommand({});
          },
        );
      },
      expectedEnv: () => ({
        OPENCLAW_STATE_DIR: profileStateDir(),
        OPENCLAW_CONFIG_PATH: path.join(profileStateDir(), "openclaw.json"),
      }),
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
    },
    {
      name: "updateCommand reuses the captured invocation cwd when process.cwd later fails",
      invoke: async () => {
        const originalCwd = process.cwd();
        let restoreCwd: (() => void) | undefined;
        const { root } = setupUpdatedRootRefresh({
          gatewayUpdateImpl: async () => {
            const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
              throw new Error("ENOENT: current working directory is gone");
            });
            restoreCwd = () => cwdSpy.mockRestore();
            return {
              status: "ok",
              mode: "npm",
              root,
              steps: [],
              durationMs: 100,
            };
          },
        });
        try {
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: path.relative(originalCwd, profileStateDir()),
            },
            async () => {
              await updateCommand({});
            },
          );
        } finally {
          restoreCwd?.();
        }
        return { originalCwd };
      },
      customSetup: true,
      expectedEnv: () => ({ OPENCLAW_STATE_DIR: profileStateDir() }),
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
    },
  ])("$name", async (testCase) => {
    const setup = testCase.customSetup ? undefined : setupUpdatedRootRefresh();
    await testCase.invoke();
    const runCommandWithTimeoutMock = vi.mocked(runCommandWithTimeout) as unknown as {
      mock: { calls: Array<[unknown, { cwd?: string }?]> };
    };
    const root = setup?.root ?? runCommandWithTimeoutMock.mock.calls[0]?.[1]?.cwd;
    const entryPath = setup?.entrypoints?.[0] ?? path.join(String(root), "dist", "entry.js");

    const installCall = gatewayCommandCall(entryPath, "install");
    expect(installCall?.[0][0]).toContain("node");
    expect(installCall?.[0].slice(1)).toEqual([entryPath, "gateway", "install", "--force"]);
    expect(installCall?.[1].cwd).toBe(String(root));
    expect(installCall?.[1].timeoutMs).toBe(60_000);
    const expectedEnv =
      "expectedEnv" in testCase && testCase.expectedEnv ? testCase.expectedEnv() : {};
    for (const [key, value] of Object.entries(expectedEnv)) {
      expect((installCall?.[1].env as NodeJS.ProcessEnv | undefined)?.[key]).toBe(value);
    }
    testCase.assertExtra();
  });

  it.each([
    { previous: undefined, mutatesCore: true },
    { previous: "1", mutatesCore: true },
    { previous: "1", mutatesCore: false },
  ])(
    "restores update flag $previous after restart (core mutation: $mutatesCore)",
    async ({ previous, mutatesCore }) => {
      await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: previous }, async () => {
        mockRunningManagedGateway([
          "node",
          path.join(process.cwd(), "dist", "index.js"),
          "gateway",
        ]);
        if (mutatesCore) {
          mockGitUpdateAfterMutation();
        }
        prepareRestartScript.mockResolvedValue(null);
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        vi.mocked(defaultRuntime.log).mockClear();

        await updateCommand({});

        expect(doctorCommand).not.toHaveBeenCalled();
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBe(previous);
        const snapshotOrders = createPreUpdateConfigSnapshotMock.mock.invocationCallOrder;
        expect(createPreUpdateConfigSnapshotMock).toHaveBeenCalledTimes(1);
        expect(requireValue(snapshotOrders[0], "restart snapshot call order")).toBeLessThan(
          requireValue(
            vi.mocked(runDaemonRestart).mock.invocationCallOrder[0],
            "daemon restart call order",
          ),
        );

        const successIndex = vi
          .mocked(defaultRuntime.log)
          .mock.calls.findIndex((call) => String(call[0]).includes("Update Result: OK"));
        expect(successIndex).toBeGreaterThanOrEqual(0);
        expect(
          vi.mocked(defaultRuntime.log).mock.invocationCallOrder[successIndex],
        ).toBeGreaterThan(
          requireValue(
            vi.mocked(runDaemonRestart).mock.invocationCallOrder[0],
            "restart call order",
          ),
        );
      });
    },
  );

  it("marks the whole update command as update-in-progress", async () => {
    await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: undefined }, async () => {
      let observedUpdateEnv: string | undefined;
      vi.mocked(runGatewayUpdate).mockImplementationOnce(async () => {
        observedUpdateEnv = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
        return makeOkUpdateResult();
      });

      await updateCommand({ restart: false });

      expect(observedUpdateEnv).toBe("1");
      expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
    });
  });

  it("updateFinalizeCommand defers plugin installation during pre-plugin doctor", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      async () => {
        let doctorEnv: NodeJS.ProcessEnv | undefined;
        vi.mocked(runExec).mockImplementationOnce(async (_file, _args, options) => {
          if (typeof options === "object") {
            doctorEnv = { ...options.baseEnv, ...options.env };
          }
          return { stdout: "", stderr: "" };
        });
        vi.mocked(defaultRuntime.writeJson).mockClear();

        await updateFinalizeCommand({
          json: true,
          yes: true,
          timeout: "9",
          restart: false,
        });

        expect(doctorEnv?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
        expect(doctorEnv?.OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR).toBe("1");
        expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBe("1");
        expect(doctorEnv?.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBe("1");
        expectFreshPostUpdateDoctor({ yes: true, workspaceSuggestions: true });
        expect(syncPluginCall()?.channel).toBe("stable");
        expect(lastNpmPluginUpdateCall()?.timeoutMs).toBe(9_000);
        expect(
          vi
            .mocked(readConfigFileSnapshot)
            .mock.calls.some(([options]) => options?.skipPluginValidation === true),
        ).toBe(true);
        const output = lastWriteJsonCall() as
          | {
              status?: string;
              mode?: string;
              restart?: boolean;
              phaseTimings?: Array<{
                phase?: string;
                startedOffsetMs?: number;
                durationMs?: number;
                outcome?: string;
              }>;
              postUpdate?: { doctor?: { status?: string }; plugins?: { status?: string } };
            }
          | undefined;
        expect(output?.status).toBe("ok");
        expect(output?.mode).toBe("finalize");
        expect(output?.restart).toBe(false);
        expect(output?.postUpdate?.doctor?.status).toBe("ok");
        expect(output?.postUpdate?.plugins?.status).toBe("ok");
        expect(output?.phaseTimings?.map((timing) => timing.phase)).toEqual([
          "targetConfigValidation",
          "configSnapshot",
          "doctor",
          "plugins",
          "targetConfigConvergence",
          "completionCache",
        ]);
        for (const timing of output?.phaseTimings ?? []) {
          expect(timing.startedOffsetMs).toEqual(expect.any(Number));
          expect(timing.durationMs).toEqual(expect.any(Number));
        }
        expect(output?.phaseTimings?.map((timing) => timing.outcome)).toEqual([
          "completed",
          "completed",
          "completed",
          "completed",
          "completed",
          "skipped",
        ]);
      },
    );
  });

  it("updateFinalizeCommand can defer only the best-effort completion cache", async () => {
    pathExists.mockResolvedValue(true);
    vi.mocked(spawnSync).mockClear();
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateFinalizeCommand({
      json: true,
      yes: true,
      restart: false,
      deferCompletionCache: true,
    } as Parameters<typeof updateFinalizeCommand>[0] & { deferCompletionCache: boolean });

    expect(spawnSync).not.toHaveBeenCalled();
    const output = lastWriteJsonCall() as
      | { phaseTimings?: Array<{ phase?: string; outcome?: string }> }
      | undefined;
    expect(output?.phaseTimings?.at(-1)).toEqual(
      expect.objectContaining({ phase: "completionCache", outcome: "deferred" }),
    );
  });

  it("updateFinalizeCommand capability env applies only to the hidden finalizer", async () => {
    pathExists.mockResolvedValue(false);
    await withEnvAsync({ OPENCLAW_UPDATE_POST_CORE: "1" }, async () => {
      const run = async (command: "repair" | "finalize") => {
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
          FRESH_POST_UPDATE_ENTRYPOINT,
        );
        vi.mocked(defaultRuntime.writeJson).mockClear();
        const program = new Command();
        program.name("openclaw");
        program.exitOverride();
        registerUpdateCli(program);
        await program.parseAsync(["node", "openclaw", "update", command, "--json", "--yes"]);
        const output = lastWriteJsonCall() as
          | { phaseTimings?: Array<{ phase?: string; outcome?: string }> }
          | undefined;
        return output?.phaseTimings?.at(-1);
      };

      expect(await run("repair")).toEqual(
        expect.objectContaining({ phase: "completionCache", outcome: "skipped" }),
      );
      expect(await run("finalize")).toEqual(
        expect.objectContaining({ phase: "completionCache", outcome: "deferred" }),
      );
    });
  });

  it.each(
    ["repair", "finalize"].flatMap((leaf) =>
      ["before", "after", "absent"].map((position) => ({ leaf, position })),
    ),
  )(
    "resolves capability consent $position $leaf without deriving it from --yes",
    async ({ leaf, position }) => {
      setTty(false);
      pathExists.mockResolvedValue(false);
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
        FRESH_POST_UPDATE_ENTRYPOINT,
      );
      const program = new Command();
      program.name("openclaw");
      program.exitOverride();
      registerUpdateCli(program);

      await program.parseAsync([
        "node",
        "openclaw",
        "update",
        ...(position === "before" ? ["--accept-capabilities"] : []),
        leaf,
        ...(position === "after" ? ["--accept-capabilities"] : []),
        "--json",
        "--yes",
      ]);

      const handler = syncPluginCall()?.onCapabilityConsent as
        | ((review: { reviewToken: string }) => Promise<{ reviewToken: string }>)
        | undefined;
      expect(syncPluginsForUpdateChannel).toHaveBeenCalledOnce();
      expect(lastWriteJsonCall()).toMatchObject({ status: "ok", mode: "finalize" });
      if (position === "absent") {
        expect(handler).toBeUndefined();
      } else {
        await expect(handler?.({ reviewToken: "repair-reviewed-surface" })).resolves.toEqual({
          reviewToken: "repair-reviewed-surface",
        });
      }
    },
  );

  it("updateFinalizeCommand rejects extended-stable on Git before persistence", async () => {
    await updateFinalizeCommand({
      channel: "extended-stable",
      json: true,
      restart: false,
    });

    expectNoSideEffects(replaceConfigFile, runExec, syncPluginsForUpdateChannel);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      mode: "git",
      reason: "unsupported_git_channel",
    });
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("updateFinalizeCommand repairs doctor by default and refreshes plugin state after doctor", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint)
      .mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT)
      .mockResolvedValueOnce("/tmp/openclaw-entry.mjs");
    const preDoctorConfig = {
      update: { channel: "stable" },
      plugins: { entries: { pre: { enabled: true } } },
    } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "beta" },
      plugins: { entries: { post: { enabled: true } } },
    } as OpenClawConfig;
    const preDoctorSnapshot = configSnapshot(preDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "pre-doctor",
    });
    const postDoctorSnapshot = configSnapshot(postDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "post-doctor",
    });
    const postDoctorRecords = {
      "post-plugin": {
        source: "npm",
        spec: "post-plugin@1.0.0",
      },
    } satisfies Record<string, PluginInstallRecord>;
    let currentSnapshot = preDoctorSnapshot;
    vi.mocked(readConfigFileSnapshot).mockImplementation(async () => currentSnapshot);
    vi.mocked(runExec).mockImplementationOnce(async () => {
      currentSnapshot = postDoctorSnapshot;
      return { stdout: "", stderr: "" };
    });
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(postDoctorRecords);
    syncPluginsForUpdateChannel.mockImplementationOnce(
      async (params: { config?: OpenClawConfig }) =>
        pluginSyncResult(params.config ?? baseConfig, true),
    );

    await updateFinalizeCommand({ json: true, timeout: "9", restart: false });

    expectFreshPostUpdateDoctor({ yes: false, workspaceSuggestions: true });
    const freshDoctorCall = vi
      .mocked(runExec)
      .mock.calls.find(
        ([, args]) => args[0] === "/tmp/openclaw-entry.mjs" && args.includes("doctor"),
      );
    expect(freshDoctorCall?.[1]).toEqual([
      "/tmp/openclaw-entry.mjs",
      "doctor",
      "--repair",
      "--non-interactive",
      "--no-workspace-suggestions",
    ]);
    expect(freshDoctorCall?.[2]).toMatchObject({
      cwd: process.cwd(),
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });
    expect(syncPluginCall()?.channel).toBe("beta");
    expect(syncPluginCall()?.config).toEqual({
      ...postDoctorConfig,
      plugins: {
        ...postDoctorConfig.plugins,
        installs: postDoctorRecords,
      },
    });
    expect(lastReplaceConfigCall()?.baseHash).toBe("post-doctor");
    expect(vi.mocked(runExec).mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      loadInstalledPluginIndexInstallRecords.mock.invocationCallOrder[0] ?? 0,
    );
    expect((lastWriteJsonCall() as { channel?: string } | undefined)?.channel).toBe("beta");
  });

  it("updateFinalizeCommand restores channels from the RPC pre-update config payload", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    const tempDir = createCaseDir("openclaw-rpc-finalize");
    const sourceConfigPath = path.join(tempDir, "source-config.json");
    const preUpdateConfig = {
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "pairing",
        },
      },
    } as OpenClawConfig;
    const postDoctorConfig = {
      meta: { lastTouchedVersion: "2026.6.18" },
    } as OpenClawConfig;
    const postDoctorSnapshot = configSnapshot(postDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "post-doctor",
    });
    await fs.mkdir(tempDir, { recursive: true });
    await writeJsonFixture(sourceConfigPath, {
      sourceConfig: preUpdateConfig,
      authoredConfig: preUpdateConfig,
    });
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(postDoctorSnapshot);

    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: sourceConfigPath,
      },
      async () => {
        await updateFinalizeCommand({ json: true, restart: false });
      },
    );

    expect(syncPluginCall()?.config?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    expect(lastReplaceConfigCall()?.nextConfig?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
  });

  it("updateFinalizeCommand reapplies requested channel against post-doctor config", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    const preDoctorConfig = { update: { channel: "stable" } } as OpenClawConfig;
    const postDoctorConfig = { update: { channel: "beta" } } as OpenClawConfig;
    const preDoctorSnapshot = configSnapshot(preDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "pre-doctor",
    });
    const postDoctorSnapshot = configSnapshot(postDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "post-doctor",
    });
    let currentSnapshot = preDoctorSnapshot;
    vi.mocked(readConfigFileSnapshot).mockImplementation(async () => currentSnapshot);
    vi.mocked(runExec).mockImplementationOnce(async () => {
      currentSnapshot = postDoctorSnapshot;
      return { stdout: "", stderr: "" };
    });

    await updateFinalizeCommand({ channel: "dev", json: true, restart: false });

    expectFreshPostUpdateDoctor({ yes: false, workspaceSuggestions: true });
    expect(replaceConfigCall(0)?.baseHash).toBe("pre-doctor");
    expect(replaceConfigCall(0)?.nextConfig).toEqual({ update: { channel: "dev" } });
    expect(replaceConfigCall(1)?.baseHash).toBe("post-doctor");
    expect(replaceConfigCall(1)?.nextConfig).toEqual({ update: { channel: "dev" } });
    expect(syncPluginCall()?.channel).toBe("dev");
    expect((lastWriteJsonCall() as { channel?: string } | undefined)?.channel).toBe("dev");
  });

  it("updateFinalizeCommand converges on the effective channel from env without persisting update.channel", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT);
    const noChannelConfig = {} as OpenClawConfig;
    const noChannelSnapshot = configSnapshot(noChannelConfig, {
      parsed: baseSnapshot.parsed,
      hash: "no-channel",
    });
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(noChannelSnapshot);
    const priorEffective = process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL;
    // Simulate a no-config git/source update whose effective channel is dev.
    process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL = "dev";
    try {
      await updateFinalizeCommand({ json: true, restart: false });
    } finally {
      if (priorEffective === undefined) {
        delete process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL;
      } else {
        process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL = priorEffective;
      }
    }
    // Convergence runs on the effective (git/dev) channel...
    expect(syncPluginCall()?.channel).toBe("dev");
    // ...but the effective channel is never persisted to update.channel
    // (no requested channel), so a default source update does not mutate config.
    expect(syncPluginCall()?.config?.update?.channel).toBeUndefined();
    const persistedDevChannel = vi
      .mocked(replaceConfigFile)
      .mock.calls.some(([params]) => params?.nextConfig?.update?.channel === "dev");
    expect(persistedDevChannel).toBe(false);
  });

  it.each([
    {
      name: "update command invalid timeout",
      run: async () => await updateCommand({ timeout: "invalid" }),
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update status command invalid timeout",
      run: async () => await updateStatusCommand({ timeout: "invalid" }),
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update wizard invalid timeout",
      run: async () => await updateWizardCommand({ timeout: "invalid" }),
      requireTty: true,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update wizard requires a TTY",
      run: async () => await updateWizardCommand({}),
      requireTty: false,
      expectedError:
        "Update wizard requires a TTY. Use `openclaw update --channel <stable|extended-stable|beta|dev>` instead.",
    },
  ] as const)(
    "validates update command invocation errors: $name",
    async ({ run, requireTty, expectedError, name }) => {
      setTty(requireTty);
      vi.mocked(defaultRuntime.error).mockClear();
      vi.mocked(defaultRuntime.exit).mockClear();

      await run();

      expect(defaultRuntime.error, name).toHaveBeenCalledWith(expectedError);
      expect(defaultRuntime.exit, name).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    {
      name: "requires confirmation without --yes",
      options: {},
      shouldExit: true,
      shouldRunPackageUpdate: false,
    },
    {
      name: "allows downgrade with --yes",
      options: { yes: true },
      shouldExit: false,
      shouldRunPackageUpdate: true,
    },
  ])("$name in non-interactive mode", async ({ options, shouldExit, shouldRunPackageUpdate }) => {
    await setupNonInteractiveDowngrade();
    if (shouldRunPackageUpdate) {
      mockCurrentProcessFreshDoctor({ postCoreResumeAttempt: false });
    }
    await updateCommand(options);

    const downgradeMessageSeen = vi
      .mocked(defaultRuntime.error)
      .mock.calls.some((call) => String(call[0]).includes("Downgrade confirmation required."));
    expect(downgradeMessageSeen).toBe(shouldExit);
    if (shouldExit) {
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    } else {
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    }
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(runCommandWithTimeout)
        .mock.calls.some(
          (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
        ),
    ).toBe(shouldRunPackageUpdate);
  });

  it("opens and cancels the wizard without inspecting update freshness", async () => {
    setTty(true);
    select.mockResolvedValue("cancel");
    vi.mocked(checkUpdateStatus).mockRejectedValue(new Error("Freshness inspection unavailable"));

    await updateWizardCommand();

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Update channel" }));
    expect(defaultRuntime.log).toHaveBeenCalledWith(expect.stringContaining("Update cancelled."));
    expect(runGatewayUpdate).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])(
    "update wizard forwards explicit consent %s the subcommand",
    async (position) => {
      const root = await fs.realpath(tempDirs.make("openclaw-update-wizard-"));
      const tempDir = path.join(root, "openclaw");
      const nodeModules = path.join(root, "prefix", "lib", "node_modules");
      const packageRoot = path.join(nodeModules, "openclaw");
      const sha = "a".repeat(40);
      await writeOpenClawPackageFixture(packageRoot, "2026.4.10", { inventory: true });
      mockPackageInstallStatus(packageRoot);
      mockFileBackedPathExists();
      mockNpmGlobalCommands(
        nodeModules,
        async (argv) => {
          if (argv[0] === "git" && argv[1] === "clone") {
            const stagingDir = requireValue(argv.at(-1), "clone destination");
            await writeOpenClawPackageFixture(stagingDir, "2026.8.1", { git: true });
            return commandResult();
          }
          return undefined;
        },
        tempDir,
      );
      vi.spyOn(updateCliShared, "tryWriteCompletionCache").mockResolvedValueOnce("completed");
      await withEnvAsync({ OPENCLAW_GIT_DIR: tempDir }, async () => {
        setTty(true);
        select.mockResolvedValue("dev");
        confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        vi.mocked(runGatewayUpdate).mockImplementation(async () => {
          await writeOpenClawPackageFixture(tempDir, "2026.8.1", { git: true, builtSha: sha });
          return makeOkUpdateResult({
            root: tempDir,
            after: { sha, version: "2026.8.1" },
          });
        });
        vi.mocked(runExec).mockResolvedValueOnce({
          stdout: new Command("update").option("--accept-capabilities").helpInformation(),
          stderr: "",
        });

        const program = new Command();
        program.exitOverride();
        registerUpdateCli(program);
        await program.parseAsync([
          "node",
          "openclaw",
          "update",
          ...(position === "before" ? ["--accept-capabilities"] : []),
          "wizard",
          ...(position === "after" ? ["--accept-capabilities"] : []),
        ]);

        expect(readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
        const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
        expect(call?.channel).toBe("dev");
        await expect(fs.realpath(packageRoot)).resolves.toBe(tempDir);
        expect(spawnCall()?.[1]).toEqual([
          path.join(tempDir, "dist", "entry.js"),
          "update",
          "--no-restart",
          "--accept-capabilities",
        ]);
        expectNoSideEffects(syncPluginsForUpdateChannel, updateNpmInstalledPlugins);
        expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      });
    },
  );

  it.each([
    {
      name: "ref-only as detached",
      env: { OPENCLAW_UPDATE_DEV_TARGET_REF: "frozen-sha" },
      expected: { mode: "detached", ref: "frozen-sha" },
    },
    {
      name: "versioned tracked target",
      env: applyDevUpdateTargetEnv(
        {},
        { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "frozen-sha" },
      ),
      expected: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "frozen-sha" },
    },
  ])("maps the internal dev target environment $name", async ({ env, expected }) => {
    await withEnvAsync(env, async () => {
      await updateCommand({ channel: "dev", yes: true, restart: false });
    });

    expect(vi.mocked(runGatewayUpdate).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ devTarget: expected }),
    );
  });

  it.each([
    ["malformed", "openclaw-dev-target:v1:not+base64url"],
    ["unknown version", "openclaw-dev-target:v2:hostile-ref"],
    ["unknown namespace", "other-dev-target:v1:hostile-ref"],
  ])("rejects a %s tracked dev target before update side effects", async (_name, value) => {
    await withEnvAsync({ OPENCLAW_UPDATE_DEV_TARGET_REF: value }, async () => {
      await updateCommand({ channel: "dev", yes: true, restart: false });
    });

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      "Invalid internal OPENCLAW_UPDATE_DEV_TARGET_REF contract; expected a plain Git ref or a supported tracked-target encoding.",
    );
    expect(defaultRuntime.error).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expectNoSideEffects(
      cleanupStaleManagedServiceUpdateHandoffs,
      runGatewayUpdate,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
  });

  it("rejects a malformed inferred dev target before running the update", async () => {
    await withEnvAsync(
      { OPENCLAW_UPDATE_DEV_TARGET_REF: "openclaw-dev-target:v1:not+base64url" },
      async () => {
        await updateCommand({ yes: true, restart: false });
      },
    );

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      "Invalid internal OPENCLAW_UPDATE_DEV_TARGET_REF contract; expected a plain Git ref or a supported tracked-target encoding.",
    );
    expect(defaultRuntime.error).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob).not.toHaveBeenCalled();
  });

  it("ignores a malformed dev target for a stable package update", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-stable-update"));
    mockCurrentProcessFreshDoctor();

    await withEnvAsync(
      { OPENCLAW_UPDATE_DEV_TARGET_REF: "openclaw-dev-target:v1:not+base64url" },
      async () => {
        await updateCommand({ channel: "stable", yes: true, restart: false });
      },
    );

    expect(defaultRuntime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("OPENCLAW_UPDATE_DEV_TARGET_REF"),
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(packageInstallCommandCall()).toBeDefined();
    expect(runGatewayUpdate).not.toHaveBeenCalled();
  });

  it("uses ~/openclaw as the default dev checkout directory", async () => {
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/tmp/oc-home");
    try {
      await withEnvAsync(
        {
          HOME: undefined,
          OPENCLAW_GIT_DIR: undefined,
          OPENCLAW_HOME: undefined,
          USERPROFILE: undefined,
        },
        async () => {
          expect(resolveGitInstallDir()).toBe(path.posix.join("/tmp/oc-home", "openclaw"));
        },
      );
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("uses OPENCLAW_HOME for the default dev checkout directory", async () => {
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/tmp/oc-home");
    try {
      await withEnvAsync(
        { OPENCLAW_GIT_DIR: undefined, OPENCLAW_HOME: "/srv/openclaw-home" },
        async () => {
          expect(resolveGitInstallDir()).toBe(path.posix.join("/srv/openclaw-home", "openclaw"));
        },
      );
    } finally {
      homedirSpy.mockRestore();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
