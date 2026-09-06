// Update CLI tests cover update command behavior, runtime calls, and output handling.
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sanitizeTriageUpdateFailure } from "../commands/triage-update.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
} from "../daemon/constants.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { gatewayHealthResponse } from "../gateway/health-response.test-support.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PackageUpdateTransaction } from "../infra/package-update-steps.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import { isBetaTag } from "../infra/update-channels.js";
import { applyDevUpdateTargetEnv } from "../infra/update-dev-target.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub-error-codes.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { getFreePort } from "../test-utils/ports.js";
import { VERSION } from "../version.js";
import { createCliRuntimeCapture, getMockCallOutput } from "./test-runtime-capture.js";

const confirm = vi.fn();
const select = vi.fn();
const text = vi.fn();
const spinner = vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), clear: vi.fn() }));
const isCancel = (value: unknown) => value === "cancel";
const triageCommand = vi.fn<typeof import("../commands/triage.js").triageCommand>();
const updateFailureActionMocks = vi.hoisted(() => ({
  runInteractiveUpdateFailureAction: vi.fn(),
}));

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
const managedUpdateHandoff = vi.hoisted(() => ({
  start: vi.fn(),
  transfer: vi.fn(),
  cancel: vi.fn(),
  activate: vi.fn(async () => false),
}));
const candidateValidation = vi.hoisted(() => vi.fn());
const unattendedRepair = vi.hoisted(() =>
  vi.fn<typeof import("../infra/update-repair-agent.js").prepareUnattendedUpdateRepair>(),
);
const httpReadiness = vi.hoisted(() => vi.fn());
const inferenceVerification = vi.hoisted(() => vi.fn());
const stateSchemaVersions = vi.hoisted(() => vi.fn());
const mockedRunDaemonInstall = vi.fn();
const serviceReadCommand = vi.fn();
const serviceReadRuntime = vi.fn();
let absentServicePort: number;
const mockGetSelfAndAncestorPidsSync = vi.fn(() => new Set<number>([process.pid]));
const terminateStaleGatewayPids = vi.fn();
const inspectPortUsage = vi.fn();
const probePortUsage = vi.fn();
const classifyPortListener = vi.fn();
const formatPortDiagnostics = vi.fn();
const callGateway = vi.fn<(opts: CallGatewayOptions) => Promise<unknown>>();
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
const windowsOfflineProbe = vi.hoisted(() => vi.fn(async () => null));
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
  ...SUPERVISOR_HINT_ENV_VARS,
  "OPENCLAW_COMPATIBILITY_HOST_VERSION",
  "OPENCLAW_UPDATE_RUN_HANDOFF",
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
  note: vi.fn(),
}));

vi.mock("../infra/update-managed-service-handoff.js", () => ({
  startManagedServiceUpdateHandoff: managedUpdateHandoff.start,
  transferManagedServiceUpdateHandoff: managedUpdateHandoff.transfer,
  cancelManagedServiceUpdateHandoff: managedUpdateHandoff.cancel,
  activateManagedServiceUpdateHandoff: managedUpdateHandoff.activate,
  isCurrentManagedServiceUpdateHandoffProcess: async () => false,
}));
vi.mock("../infra/update-repair-agent.js", () => ({
  prepareUnattendedUpdateRepair: unattendedRepair,
}));
vi.mock("../infra/update-candidate-canary.js", () => ({
  validateUpdateCandidateCanary: candidateValidation,
}));
vi.mock("./update-cli/update-command-inference.js", () => ({
  runUpdateInferenceProbe: inferenceVerification,
}));
vi.mock("../infra/update-candidate-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-candidate-state.js")>()),
  readUpdateStateSchemaVersions: stateSchemaVersions,
}));

// Fresh diagnostic processes have owner coverage; interactive cases retain the
// real prepared handoff so they verify operator environment and cleanup ordering.
vi.mock("../infra/update-triage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/update-triage.js")>();
  const runUpdateFailureTriage = vi.fn<typeof actual.runUpdateFailureTriage>(async () => ({
    status: "completed",
    hint: "Triage prepared",
  }));
  return {
    ...actual,
    runUpdateFailureTriage,
    prepareUpdateFailureTriage: async (
      params: Parameters<typeof actual.prepareUpdateFailureTriage>[0],
    ) => {
      if (params.mode === "interactive") {
        return actual.prepareUpdateFailureTriage(params);
      }
      const { mode, runtime } = params;
      return (
        invocation: Parameters<Awaited<ReturnType<typeof actual.prepareUpdateFailureTriage>>>[0],
      ) => runUpdateFailureTriage({ ...invocation, mode, runtime });
    },
  };
});

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
  // The real snapshot worker has separate WAL/source-inode boundary coverage.
  // Retain real rehearsal config projection and drift checks in this CLI fixture.
  runCommandBuffered: async () => ({
    code: 0,
    stdout: Buffer.from("[]"),
    stderr: Buffer.alloc(0),
  }),
  runCommandWithTimeout: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
  runExec: vi.fn(async () => ({
    stdout: new Date(Date.now() - 1000).toString(),
    stderr: "",
  })),
}));

vi.mock("./update-cli/update-command-post-plugin-readiness.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./update-cli/update-command-post-plugin-readiness.js")>();
  return {
    ...actual,
    applyPostPluginUpdateReadiness: vi.fn(
      async (params: Parameters<typeof actual.applyPostPluginUpdateReadiness>[0]) =>
        params.pluginUpdate,
    ),
  };
});

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

vi.mock("../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
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
      env?: NodeJS.ProcessEnv;
      requireEffective?: boolean;
      validateEnvBeforeStatusRead?: (env: NodeJS.ProcessEnv) => void;
    },
  ) => {
    const command = await serviceReadCommand(
      args?.requireEffective ? { requireEffective: true } : undefined,
    );
    const env: NodeJS.ProcessEnv = {
      ...(args?.env ?? process.env),
      ...(process.platform === "win32" ? { PATH: path.dirname(process.execPath) } : undefined),
      ...(command && typeof command === "object" && "environment" in command
        ? (command.environment as NodeJS.ProcessEnv | undefined)
        : undefined),
    };
    // An absent fixture service must probe its own port, not the operator's listener.
    if (command === null) {
      env.OPENCLAW_GATEWAY_PORT ??= String(absentServicePort);
    }
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

vi.mock("../daemon/schtasks-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/schtasks-runtime.js")>()),
  readWindowsStartupFallbackRuntimeForUpdate: windowsOfflineProbe,
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortUsage: (...args: unknown[]) => inspectPortUsage(...args),
}));

vi.mock("../infra/ports-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/ports-probe.js")>()),
  probePortUsage: (...args: unknown[]) => probePortUsage(...args),
}));

vi.mock("../infra/ports-format.js", () => ({
  classifyPortListener: (...args: unknown[]) => classifyPortListener(...args),
  formatPortDiagnostics: (...args: unknown[]) => formatPortDiagnostics(...args),
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: (opts: CallGatewayOptions) => callGateway(opts),
}));

vi.mock("./update-cli/restart-helper.js", () => ({
  prepareRestartScript: (...args: unknown[]) => prepareRestartScript(...args),
  runRestartScript: (...args: unknown[]) => runRestartScript(...args),
}));

vi.mock("./daemon-cli/restart-health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon-cli/restart-health.js")>();
  return {
    ...actual,
    waitForGatewayHttpReadiness: httpReadiness,
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
vi.mock("./daemon-cli/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon-cli/install.js")>()),
  runDaemonInstall: mockedRunDaemonInstall,
}));

// Mock the runtime
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: runtimeCapture,
}));
vi.mock("../commands/triage.js", () => ({ triageCommand }));
vi.mock("./update-cli/update-command-report.js", () => updateFailureActionMocks);

const { runGatewayUpdate } = await import("../infra/update-runner.js");
const { createUpdateRun, getUpdateRun, listUpdateRuns } =
  await import("../infra/update-run-ledger.js");
// Real recovery dependencies need the initialized runtime and child-process mocks.
const { runUpdateFailureTriage } = await import("../infra/update-triage.js");
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
const { runCommandWithTimeout, runExec, runUtf8CommandWithTimeout } =
  await import("../process/exec.js");
const { runDaemonRestart, runDaemonInstall } = await import("./daemon-cli.js");
const { doctorCommand } = await import("../commands/doctor.js");
const { defaultRuntime, ExitError } = await import("../runtime.js");
const postCorePluginConvergence =
  await import("../commands/doctor/shared/post-core-plugin-convergence.js");
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

async function invokeUpdateCli(opts: Parameters<typeof updateCommand>[0]) {
  const program = new Command();
  registerUpdateCli(program);
  const args = ["update"];
  for (const key of ["yes", "json", "dryRun", "acceptCapabilities"] as const) {
    if (opts[key]) {
      args.push(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
    }
  }
  if (opts.restart === false) {
    args.push("--no-restart");
  }
  for (const key of ["channel", "tag", "timeout"] as const) {
    if (opts[key] !== undefined) {
      args.push(`--${key}`, opts[key]);
    }
  }
  await program.parseAsync(args, { from: "user" });
}
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

  const mockPackageInstallAtCaseDir = async (prefix = "openclaw-update") => {
    const { pkgRoot, nodeModules } = await setupInstalledPackageRoot(
      createCaseDir(prefix),
      "1.0.0",
    );
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i") {
        await writeNpmPackageInstall(argv, pkgRoot);
      }
    });
    mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    return pkgRoot;
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
  // Failure assertions must not render the triage target's inherited environment.
  const getTriageFailures = () =>
    vi.mocked(runUpdateFailureTriage).mock.calls.map(([call]) => call.failure);
  const expectNoSideEffects = (...effects: unknown[]) => {
    for (const effect of effects) {
      expect(effect).not.toHaveBeenCalled();
    }
  };

  const gatewayHealthCall = (index = 0) => callGateway.mock.calls[index]?.[0];

  const pluginWarning = (result?: UpdateRunResult) => result?.postUpdate?.plugins?.warnings?.[0];
  const pluginOutcome = (result?: UpdateRunResult) => result?.postUpdate?.plugins?.npm.outcomes[0];

  const expectPackageInstallSpec = (spec: string, staged = true) => {
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
      ? installSpec
      : spec.toLowerCase().startsWith("openclaw@")
        ? "openclaw"
        : spec;
    const call = packageInstallCommandCall();
    expect(call?.[0]).toEqual([
      "npm",
      "i",
      "-g",
      `--allow-scripts=${allowScriptsIdentity}`,
      ...(staged ? ["--prefix", expect.stringContaining(".openclaw.update-stage-")] : []),
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

  const reportCandidateSteps = <T extends { steps: UpdateRunResult["steps"] }>(
    options: { onStep?: (step: UpdateRunResult["steps"][number]) => void },
    result: T,
  ): T => {
    for (const step of result.steps) {
      options.onStep?.(step);
    }
    return result;
  };

  const mockGitUpdateAfterMutation = (
    result = makeOkUpdateResult({ mode: "git" }),
    reinspect = false,
  ) => {
    const preparations: Array<{
      allowGatewayServiceRepair?: boolean;
      allowGatewayActivation?: boolean;
    } | void> = [];
    vi.mocked(runGatewayUpdate).mockImplementationOnce(async (opts) => {
      await opts?.inspectGitTarget?.({});
      if (opts?.prepareGitExposure) {
        await opts.prepareGitExposure(
          requireValue(result.root, "candidate checkout"),
          requireValue(result.after?.sha ?? undefined, "candidate commit"),
          undefined,
        );
      }
      if (result.root) {
        await opts?.validateCandidate?.(result.root);
      }
      preparations.push(await opts?.beforeGitMutation?.({}));
      if (reinspect) {
        await opts?.inspectGitTarget?.({});
      }
      return result;
    });
    return preparations;
  };

  const mockOwnedGitService = (root = process.cwd()) => {
    const serviceEntrypoint = path.join(root, "dist", "index.js");
    primeServiceCommand(["node", serviceEntrypoint, "gateway", "run"]);
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === path.join(root, "package.json") || candidate === serviceEntrypoint,
    );
  };

  const runUpdateCliScenario = async (testCase: UpdateCliScenario) => {
    vi.clearAllMocks();
    await testCase.run();
    testCase.assert();
  };

  const runRestartFallbackScenario = async (params: { daemonInstall: "ok" | "fail" }) => {
    mockOwnedGitService();
    const entrypoint = path.join(process.cwd(), "dist", "index.js");
    mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    if (params.daemonInstall === "fail") {
      mockGatewayInstallFailure(entrypoint);
    }
    prepareRestartScript.mockResolvedValue(null);
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({});

    expect(gatewayCommandCall(entrypoint, "install")).toBeDefined();
    expect(freshRestartCalls()).toHaveLength(1);
  };

  const setupNonInteractiveDowngrade = async () => {
    const tempDir = await mockPackageInstallAtCaseDir();
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
    admitMutation?: boolean;
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
    vi.mocked(runGatewayUpdate).mockImplementation(async (options) => {
      // Finalization-only fixtures do not simulate the earlier native lifecycle.
      // Baseline-capture cases explicitly exercise its real admission callback.
      if (params?.admitMutation) {
        await options?.beforeGitMutation?.({});
      }
      return params?.gatewayUpdateImpl
        ? params.gatewayUpdateImpl(root)
        : makeOkUpdateResult({ mode: "npm", root });
    });
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", entrypoints[0], "gateway", "run"]);
    return { root, entrypoints };
  };

  const FRESH_POST_UPDATE_ENTRYPOINT = "/tmp/openclaw-updated-entry.mjs";

  const mockCurrentProcessFreshDoctor = (
    params: { postCoreResumeAttempt?: boolean; packageRoot?: string } = {},
  ) => {
    // Package Doctor precedes the fresh-process decision; it must have a real entrypoint.
    if (params.packageRoot) {
      vi.mocked(resolveGatewayInstallEntrypoint).mockReset();
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
        path.join(params.packageRoot, "dist", "index.js"),
      );
    }
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

  const writeNpmPackageInstall = async (
    argv: string[],
    packageRoot: string,
    version = argv.find((arg) => /^openclaw@\d/u.test(arg))?.slice("openclaw@".length) ??
      "9999.0.0",
  ) => {
    const stagePrefix = argv.includes("--prefix")
      ? requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix")
      : undefined;
    const installedRoot = stagePrefix
      ? path.join(
          stagePrefix,
          process.platform === "win32" ? "node_modules" : "lib/node_modules",
          "openclaw",
        )
      : packageRoot;
    await writeOpenClawPackageFixture(installedRoot, version, {
      entrySource: "export {};\n",
      inventory: true,
    });
  };

  const mockNpmGlobalCommands = (
    nodeModules: string,
    handle?: (
      ...args: Parameters<typeof runCommandWithTimeout>
    ) =>
      | Awaited<ReturnType<typeof runCommandWithTimeout>>
      | undefined
      | Promise<Awaited<ReturnType<typeof runCommandWithTimeout>> | undefined>,
    sourceCheckout?: string | (() => string),
  ) => {
    const activateGateway = mockPackageGatewayLifecycle();
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      const handled = await handle?.(argv, options);
      if (handled !== undefined) {
        return handled;
      }
      if (sourceCheckout && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        const checkout = typeof sourceCheckout === "function" ? sourceCheckout() : sourceCheckout;
        expect(argv).toContain(checkout);
        const stagePrefix = requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
        const stageRoot = path.join(
          stagePrefix,
          process.platform === "win32" ? "node_modules" : "lib/node_modules",
        );
        await fs.mkdir(stageRoot, { recursive: true });
        await fs.symlink(
          checkout,
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
      if (argv[0] === "npm" && argv[1] === "pack") {
        const destination = requireValue(
          argv[argv.indexOf("--pack-destination") + 1],
          "pack destination",
        );
        await fs.writeFile(path.join(destination, "openclaw-9999.0.0.tgz"), "packed\n", "utf8");
      }
      await activateGateway(argv);
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
    overrides: {
      warnings?: string[];
      errors?: Array<{ pluginId: string; message: string; code?: string }>;
    } = {},
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
    return withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
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
    return withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
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
        "dist/build-info.json": JSON.stringify({
          commit: options.builtSha,
          buildId: "fixture-original-build",
        }),
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
    setupInstalledPackageAtNodeModules(
      path.join(baseDir, process.platform === "win32" ? "node_modules" : "lib/node_modules"),
      version,
    );

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

  const mockPackageGatewayLifecycle = () => {
    serviceStop.mockImplementation(async () => {
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      // macOS stop boots out the job; systemd enablement and task registration remain.
      if (process.platform === "darwin") {
        serviceLoaded.mockResolvedValue(false);
      }
    });
    return async (argv: string[]) => {
      if (argv[2] !== "gateway" || (argv[3] !== "install" && argv[3] !== "restart")) {
        return;
      }
      // Native activation starts the installed package. Changing the probe only
      // here keeps a missing restart or wrong package visible to real health checks.
      const entrypoint = requireValue(argv[1], "gateway activation entrypoint");
      await fs.access(entrypoint);
      const manifest = JSON.parse(
        await fs.readFile(path.join(path.dirname(entrypoint), "..", "package.json"), "utf8"),
      ) as { version: string };
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({
        status: "running",
        pid: gatewayFixturePid,
        state: "running",
      });
      mockGatewayHealth(manifest.version, "updated-gateway");
    };
  };

  const mockServicePackageCommands = (params: {
    nodeModules: string;
    packageRoot: string;
    targetVersion: string;
    npmCommands: string[];
    nodeVersions: Record<string, string>;
  }) => {
    const npmCommands = new Set(params.npmCommands);
    const activateGateway = mockPackageGatewayLifecycle();
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
      await activateGateway(argv);
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
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect([logs, ...vi.mocked(defaultRuntime.error).mock.calls.flat()].join("\n")).toContain(
      message,
    );
    expect(logs).not.toContain("Gateway: restarted and verified.");
    expect(logs).not.toContain("Update Result: OK");
  };

  const mockGatewayHealth = (version: string, connId: string, buildId?: string) => {
    callGateway.mockImplementation(gatewayHealthResponse({ server: { version, connId, buildId } }));
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

  const setupManagedGitRootRefresh = async (reinspect = false) => {
    const { root, entrypoints } = setupUpdatedRootRefresh();
    const updatedEntrypoint = requireValue(entrypoints[0], "updated entrypoint");
    await writeOpenClawPackageFixture(root, "2026.4.27");
    mockOwnedGitService();
    mockGitUpdateAfterMutation(
      makeOkUpdateResult({
        mode: "git",
        root,
        before: { sha: "old-managed-sha", version: "2026.4.26" },
        after: { sha: "new-managed-sha", version: "2026.4.27" },
      }),
      reinspect,
    );
    mockFileBackedPathExists();
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    serviceStop.mockImplementationOnce(async () => {
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    });
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "default command fixture",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      const result = await runFixtureCommand(argv, options);
      if (argv[2] === "gateway" && argv[3] === "install" && result.code === 0) {
        expect(argv[1]).toBe(updatedEntrypoint);
        const env = requireValue(
          typeof options === "number" ? undefined : options.env,
          "gateway install environment",
        );
        primeServiceCommand([argv[0], updatedEntrypoint, "gateway", "run"], env);
      }
      return result;
    });
    runRestartScript.mockImplementationOnce(async () => {
      serviceReadRuntime.mockResolvedValue({
        status: "running",
        pid: gatewayFixturePid,
        state: "running",
      });
      mockGatewayHealth("2026.4.27", "updated-work");
    });
    return updatedEntrypoint;
  };

  const mockNpmGlobalRoot = (nodeModules: string) => {
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        await writeNpmPackageInstall(argv, path.join(nodeModules, "openclaw"));
      }
    });
  };

  const mockPackageReplacementFailure = (message: string, beforeFailure?: () => Promise<void>) => {
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        await beforeFailure?.();
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
        await invokeUpdateCli(options);
      },
    );

  const runControlPlaneUpdate = async (params: {
    meta: Record<string, unknown>;
    options: Parameters<typeof updateCommand>[0];
    beforeUpdate?: () => void | Promise<void>;
    expectedExitCode?: number;
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
        if (params.expectedExitCode === undefined) {
          await invokeUpdateCli(params.options);
        } else {
          await expect(invokeUpdateCli(params.options)).rejects.toEqual(
            new ExitError(params.expectedExitCode),
          );
        }
      },
    );
    return readRestartSentinel({ OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
  };

  beforeEach(async () => {
    absentServicePort = await getFreePort();
    const gatewayEntrypoint = await import("../daemon/gateway-entrypoint.js");
    const actualGatewayEntrypoint = await vi.importActual<
      typeof import("../daemon/gateway-entrypoint.js")
    >("../daemon/gateway-entrypoint.js");
    vi.mocked(gatewayEntrypoint.resolveGatewayInstallEntrypoint).mockImplementation(
      actualGatewayEntrypoint.resolveGatewayInstallEntrypoint,
    );
    delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    delete process.env.OPENCLAW_SERVICE_MARKER;
    delete process.env.OPENCLAW_SERVICE_KIND;
    delete process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV];
    for (const key of [
      ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
      ...SUPERVISOR_HINT_ENV_VARS,
      "OPENCLAW_UPDATE_RUN_HANDOFF",
    ]) {
      delete process.env[key];
    }
    restartHealthTestControl.snapshot = undefined;
    vi.resetAllMocks();
    managedUpdateHandoff.activate.mockResolvedValue(false);
    unattendedRepair.mockResolvedValue({
      status: "unavailable",
      attempts: [],
      finalValidation: { ok: false, score: 0, summary: "No fixture repair route." },
    });
    candidateValidation.mockImplementation(async (options) =>
      reportCandidateSteps(options, {
        status: "ok",
        candidateSchemaVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        steps: [
          {
            name: "candidate gateway canary",
            command: "openclaw gateway",
            cwd: "/candidate",
            durationMs: 1,
            exitCode: 0,
          },
        ],
      }),
    );
    httpReadiness.mockResolvedValue({ healthz: 200, readyz: 200 });
    inferenceVerification.mockResolvedValue(true);
    stateSchemaVersions.mockImplementation(
      async ({ stateDir, env }: { stateDir: string; env?: NodeJS.ProcessEnv }) => [
        { path: resolveOpenClawStateSqlitePath(env), userVersion: OPENCLAW_STATE_SCHEMA_VERSION },
        {
          path: path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
          userVersion: null,
        },
      ],
    );
    probePortUsage.mockResolvedValue("free");
    serviceEnabled.mockResolvedValue(true);
    serviceDefinitionMutationCapability.mockResolvedValue(undefined);
    updateFailureActionMocks.runInteractiveUpdateFailureAction.mockResolvedValue("triage");
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
    mockGatewayHealth("1.0.0", "conn-test");
    const installedEntrypoint = path.join(process.cwd(), "dist", "index.js");
    pathExists.mockImplementation(async (candidate: string) => candidate === installedEntrypoint);
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

  it("refuses to stop a service whose effective launcher changed during inspection", async () => {
    mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
    const original = await serviceReadCommand(process.env);
    serviceReadCommand.mockResolvedValueOnce(original).mockResolvedValue({
      ...original,
      programArguments: ["/foreign/openclaw", "gateway"],
    });
    const { maybeStopManagedServiceBeforeMutableUpdate } =
      await import("./update-cli/update-command-service.js");
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: process.cwd(),
        shouldRestart: true,
        jsonMode: true,
      }),
    ).rejects.toThrow("ownership or manager identity changed");
    expect(serviceStop).not.toHaveBeenCalled();
  });

  it("pins the admitted writable service configuration before native preparation", async () => {
    const argv = ["node", path.join(process.cwd(), "dist", "index.js"), "gateway"];
    mockRunningManagedGateway(argv);
    const { maybeStopManagedServiceBeforeMutableUpdate } =
      await import("./update-cli/update-command-service.js");
    const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: "package",
      root: process.cwd(),
      shouldRestart: true,
      jsonMode: true,
      phase: "inspect",
    });
    expect(inspected.serviceUpdateVerdict).toMatchObject({
      kind: "owned",
      refreshDefinition: true,
    });
    // The service manager/profile stay identical; a config substitution now selects another store.
    primeServiceCommand(argv, { PREFLIGHT_STORE_ROOT: createCaseDir("service-config-drift") });
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: process.cwd(),
        shouldRestart: true,
        jsonMode: true,
        expectedService: inspected,
        phase: "prepare",
      }),
    ).rejects.toThrow("changed");
    expectNoSideEffects(serviceStop, suspendScheduledTaskAutoStartForUpdate);
  });

  it("recovers a stopped sealed service after staged npm installation fails", async () => {
    const {
      root,
      nodeModules,
      entrypoint,
      serviceNode: nodeRunner,
    } = await setupServicePackageAtPrefix({
      prefix: createCaseDir("staging-recovery"),
      version: "1.0.0",
    });
    mockRunningManagedGateway([nodeRunner, entrypoint, "gateway"]);
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    serviceDefinitionMutationCapability.mockResolvedValue({ kind: "sealed", detail: "root owner" });
    const activateGateway = mockPackageGatewayLifecycle();
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      await activateGateway(argv);
      return commandResult();
    });
    const {
      maybeStopManagedServiceBeforeMutableUpdate,
      maybeRestartServiceAfterFailedMutableUpdate,
    } = await import("./update-cli/update-command-service.js");
    const before = await maybeStopManagedServiceBeforeMutableUpdate({
      root,
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
    });
    expect(before?.stopped).toBe(true);
    const { runGlobalPackageUpdateSteps } = await import("../infra/package-update-steps.js");
    const result = await runGlobalPackageUpdateSteps({
      installTarget: {
        manager: "npm",
        command: "npm",
        globalRoot: nodeModules,
        packageRoot: root,
        npmOwner: { version: "12.0.0", lifecyclePolicy: "allow-scripts" },
      },
      installSpec: "openclaw@2.0.0",
      packageName: "openclaw",
      packageRoot: root,
      runCommand: async () => ({ code: 0, stdout: nodeModules, stderr: "" }),
      runStep: async ({ name, argv }) => {
        expect(argv).toContain("--prefix");
        return { name, command: argv.join(" "), cwd: root, durationMs: 0, exitCode: 1 };
      },
      timeoutMs: 1000,
    });
    expect(result.failedStep?.exitCode).toBe(1);
    expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
    await expect(
      maybeRestartServiceAfterFailedMutableUpdate({
        preManagedServiceStop: before,
        recovery: result.recovery,
        jsonMode: true,
        nodeRunner,
        timeoutMs: 17_000,
        invocationCwd: root,
      }),
    ).resolves.toBe("healthy");
    expect(freshRestartCalls()).toEqual([
      [
        [nodeRunner, entrypoint, "gateway", "restart", "--preserve-definition", "--json"],
        expect.objectContaining({
          cwd: root,
          timeoutMs: 17_000,
          baseEnv: {},
          env: expect.objectContaining({ NODE_DISABLE_COMPILE_CACHE: "1" }),
        }),
      ],
    ]);
    expectNoSideEffects(serviceStart, serviceRestart, runDaemonInstall, runDaemonRestart);
  });

  it.each([
    { kind: "git", restart: false, ownership: "unavailable" },
    { kind: "git", restart: true, ownership: "unavailable" },
    { kind: "package", restart: false, ownership: "unavailable" },
    { kind: "package", restart: true, ownership: "unavailable" },
    { kind: "git", restart: false, ownership: "unresolved" },
    { kind: "package", restart: false, ownership: "unresolved" },
  ] as const)(
    "refuses $kind with restart=$restart when service ownership is $ownership",
    async ({ kind, restart, ownership }) => {
      if (kind === "package") {
        await mockPackageInstallAtCaseDir();
        mockCurrentProcessFreshDoctor();
      } else {
        mockGitUpdateAfterMutation();
      }
      if (ownership === "unavailable") {
        serviceReadCommand.mockRejectedValue(new Error("inspection-secret-canary"));
      } else {
        mockRunningManagedGateway(["openclaw-wrapper", "gateway", "run"]);
      }

      await expect(invokeUpdateCli({ yes: true, json: true, restart })).rejects.toEqual(
        new ExitError(1),
      );
      expect(runGatewayUpdate).not.toHaveBeenCalled();
      expect(packageInstallCommandCall()).toBeUndefined();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(getErrorOutput()).toContain("gateway status --deep");
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "managed-service-preflight",
      });
      expectNoSideEffects(
        serviceStop,
        serviceStart,
        serviceRestart,
        runDaemonInstall,
        runDaemonRestart,
        prepareRestartScript,
        runRestartScript,
        cleanupStaleManagedServiceUpdateHandoffs,
        launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(getErrorOutput()).not.toContain("inspection-secret-canary");
    },
  );

  it("refuses a restart-enabled update when service load inspection is unknown", async () => {
    mockRunningManagedGateway();
    mockGitUpdateAfterMutation();
    serviceLoaded.mockRejectedValue(new Error("load-state-secret-canary"));

    await expect(invokeUpdateCli({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getErrorOutput()).toContain(
      "Gateway service inspection is unavailable. Refusing to mutate code",
    );
    expect(getErrorOutput()).not.toContain("load-state-secret-canary");
  });

  it.each(["absent", "stopped"] as const)(
    "keeps compatible no-restart package updates available with a proven %s service",
    async (state) => {
      const root = await mockPackageInstallAtCaseDir(`compatible-${state}`);
      if (state === "stopped") {
        mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
        serviceLoaded.mockResolvedValue(false);
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      }
      await updateCommand({ yes: true, json: true, restart: false });
      expect(packageInstallCommandCall()).toBeDefined();
      expectNoSideEffects(serviceStop, serviceStart, serviceRestart, runRestartScript);
    },
  );

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
        kind === "package"
          ? await mockPackageInstallAtCaseDir("openclaw-sealed-code-update")
          : process.cwd();
      const entrypoint =
        kind === "package"
          ? await writeOpenClawPackageFixture(root, "1.0.0", {
              entrySource: "export {};\n",
              inventory: true,
            })
          : path.join(root, "dist", "index.js");
      if (kind === "package") {
        mockPackageInstallStatus(root);
        mockGatewayHealth("9999.0.0", "updated-service");
      } else {
        mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root }));
      }
      vi.mocked(resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(entrypoint);
      // No managed mode, token, or env-key metadata: this must not become an install-plan veto.
      mockRunningManagedGateway(["node", entrypoint, "gateway", "--port", "18789"]);
      serviceDefinitionMutationCapability.mockResolvedValue({
        kind: capability,
        detail: "definition-owner-secret-canary",
      });

      await updateCommand({ yes: true, json: true, restart }).catch((cause: unknown) => {
        throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, { cause });
      });

      if (kind === "package") {
        expectPackageInstallSpec("openclaw@9999.0.0", true);
      } else {
        expect(runGatewayUpdate).toHaveBeenCalledOnce();
      }
      expect(serviceStop).toHaveBeenCalledTimes(restart ? 1 : 0);
      expect(freshRestartCalls().length).toBe(restart ? 1 : 0);
      expect(serviceStart).not.toHaveBeenCalled();
      expectNoSideEffects(
        managedUpdateHandoff.start,
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
      const entrypoint = path.join(process.cwd(), "dist", "index.js");
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
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
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
        jsonMode: true,
      });

      expectNoSideEffects(serviceStart, serviceRestart);
      if (inspection === "unchanged") {
        expect(freshRestartCalls()).toEqual([
          [
            [process.execPath, entrypoint, "gateway", "restart", "--preserve-definition", "--json"],
            expect.objectContaining({ cwd: process.cwd(), baseEnv: {} }),
          ],
        ]);
      } else {
        expect(freshRestartCalls()).toHaveLength(0);
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
    ).resolves.toBe("failed");

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
      await invokeUpdateCli({ yes: true });
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
    expect(getUpdateRun(call?.[2]?.env?.OPENCLAW_UPDATE_RUN_ID ?? "")?.trigger).toBe("cli");
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
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(unrelatedGatewayFixturePid),
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

        expect(spawn).toHaveBeenCalledOnce();
        const env = spawnCall()?.[2]?.env;
        expect(env?.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        expect(env?.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBeUndefined();
        expect(env?.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH).toBeUndefined();
        expect(env?.OPENCLAW_SERVICE_MARKER).toBeUndefined();
        expect(env?.OPENCLAW_SERVICE_KIND).toBeUndefined();
        expect(env?.[GATEWAY_SERVICE_RUNTIME_PID_ENV]).toBeUndefined();
        expect(env?.OPENCLAW_UNRELATED).toBe("preserved");
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("stale-version");
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBe("beta");
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH).toBe(
          "/tmp/stale-config.json",
        );
      },
    );
  });

  it.each([false, true])(
    "keeps stopped owned-service config and plugin state through fresh post-core handoff (reinspect=%s)",
    async (reinspect) => {
      const updatedEntrypoint = await setupManagedGitRootRefresh(reinspect);
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
      primeServiceCommand(
        ["node", path.join(process.cwd(), "dist", "index.js"), "gateway", "run"],
        {
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: managedState,
          OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
          OPENCLAW_GATEWAY_PORT: "19222",
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(unrelatedGatewayFixturePid),
        },
      );
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
      expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
      expect(runRestartScript).toHaveBeenCalledOnce();
      expect(getLogOutput()).toContain("Gateway: restarted and verified.");
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
      expect(runRestartScript.mock.invocationCallOrder[0]).toBeLessThan(
        requireValue(spawn.mock.invocationCallOrder[0], "post-core handoff"),
      );
    },
  );

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
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(spawnCall()?.[2]?.env).toMatchObject({
      OPENCLAW_PROFILE: "personal",
      OPENCLAW_STATE_DIR: personalState,
      OPENCLAW_GATEWAY_PORT: "19111",
    });
  });

  it("keeps forced post-core fallback and fresh validation in the stopped service profile", async () => {
    const updatedEntrypoint = await setupManagedGitRootRefresh();
    const managedState = profileStateDir("work");
    primeServiceCommand(["node", path.join(process.cwd(), "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: managedState,
      OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
      OPENCLAW_GATEWAY_PORT: "19222",
    });
    // Only the resume attempt misses; Doctor and service refresh resolve the real target.
    let resumeAttempted = false;
    vi.mocked(resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockImplementation(async () => {
        if (runRestartScript.mock.calls.length > 0 && !resumeAttempted) {
          resumeAttempted = true;
          return undefined;
        }
        return updatedEntrypoint;
      });
    const convergenceProfiles: Array<string | undefined> = [];
    syncPluginsForUpdateChannel.mockImplementation(async () => {
      convergenceProfiles.push(process.env.OPENCLAW_PROFILE);
      return pluginSyncResult(baseConfig, true);
    });

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: profileStateDir("personal"),
        OPENCLAW_GATEWAY_PORT: "19111",
      },
      async () => {
        await updateCommand({ yes: true }).catch((error: unknown) => {
          throw new Error(getErrorOutput() + getLogOutput(), { cause: error });
        });
        expect(process.env.OPENCLAW_PROFILE).toBe("personal");
      },
    );

    expect(convergenceProfiles).toEqual(["work"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
    expect(runRestartScript).toHaveBeenCalledOnce();
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
    const freshCalls = vi
      .mocked(runExec)
      .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? ""));
    expect(freshCalls).toHaveLength(2);
    for (const call of freshCalls) {
      expect(call[1][0]).toBe(updatedEntrypoint);
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
    mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
      path.join(process.cwd(), "dist", "index.js"),
    );
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === path.join(process.cwd(), "package.json") ||
        candidate === path.join(process.cwd(), "dist", "index.js") ||
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
    expect(freshRestartCalls()).toHaveLength(1);
    expect(freshRestartCalls()[0]?.[1]).toMatchObject({ env: { OPENCLAW_PROFILE: "work" } });
    expect(runDaemonRestart).not.toHaveBeenCalled();
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

  it("starts the candidate before plugin convergence and only restarts the verified previous version after plugin errors", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
    const root = await mockPackageInstallAtCaseDir();
    const entryPath = path.join(root, "dist", "index.js");
    vi.mocked(resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(entryPath);
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", entryPath, "gateway", "run"]);
    pathExists.mockImplementation(async (candidate: string) => candidate === entryPath);
    const activations: Array<{ version: string; afterPlugin: boolean }> = [];
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "staged package commands",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      if (argv[2] === "gateway" && ["install", "restart"].includes(argv[3] ?? "")) {
        const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
        activations.push({ version: manifest.version, afterPlugin: spawn.mock.calls.length > 0 });
      }
      return runFixtureCommand(argv, options);
    });
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

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));
    platformSpy.mockRestore();

    expect(serviceStop).toHaveBeenCalled();
    expectNoSideEffects(serviceRestart, runDaemonRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getLogOutput()).not.toContain("Update Result: OK");
    expect(spawn).toHaveBeenCalled();
    expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledTimes(2);
    const pluginStartOrder = requireValue(spawn.mock.invocationCallOrder[0], "plugin child start");
    const starts = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.flatMap(([argv], index) =>
        argv[2] === "gateway" && ["install", "restart"].includes(argv[3] ?? "")
          ? [
              requireValue(
                vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[index],
                "gateway activation order",
              ),
            ]
          : [],
      );
    expect(starts.length).toBeGreaterThan(0);
    expect(activations.filter((entry) => !entry.afterPlugin)).toEqual([
      { version: "9999.0.0", afterPlugin: false },
    ]);
    expect(activations.filter((entry) => entry.afterPlugin)).toEqual([
      { version: "1.0.0", afterPlugin: true },
      { version: "1.0.0", afterPlugin: true },
    ]);
    expect(resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      pluginStartOrder,
    );
  });

  it("passes pre-update plugin install records into the post-core update process", async () => {
    setupUpdatedRootRefresh({ admitMutation: true });
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
    const { root } = setupUpdatedRootRefresh({ admitMutation: true });
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

  it.each(["spawn", "phase"])(
    "restores the exact plugin index revision when post-core %s fails",
    async (failureKind) => {
      const { root } = setupUpdatedRootRefresh({
        admitMutation: true,
        gatewayUpdateImpl: async (updatedRoot) =>
          makeOkUpdateResult({
            mode: "npm",
            root: updatedRoot,
            before: { version: "2026.4.23" },
            after: { version: "2026.4.24" },
          }),
      });
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
      spawn.mockImplementationOnce((_node, _argv, options) => {
        if (failureKind === "spawn") {
          throw new Error("post-core spawn failed");
        }
        const child = new EventEmitter();
        fsSync.writeFileSync(
          options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH,
          JSON.stringify({
            status: "failed",
            error: "pre-plugin Doctor failed before convergence",
          }),
        );
        queueMicrotask(() => child.emit("exit", 1, null));
        return child;
      });

      await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
      expect(getTriageFailures()).toContainEqual(
        expect.objectContaining({
          error:
            failureKind === "spawn"
              ? "post-core spawn failed"
              : "pre-plugin Doctor failed before convergence",
          result: expect.objectContaining({
            status: "error",
            mode: "npm",
            root,
            before: { version: "2026.4.23" },
            after: { version: "2026.4.24" },
          }),
        }),
      );
      expect(defaultRuntime.exit).not.toHaveBeenCalled();

      expect(writePersistedInstalledPluginIndexInstallRecordsWithLease).toHaveBeenCalledTimes(1);
      expect(restorePersistedInstalledPluginIndexIfCurrent).toHaveBeenCalledWith(
        previousPersistedIndex,
        17,
        { lease: expect.anything() },
      );
    },
  );

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
    const { root } = setupUpdatedRootRefresh({ admitMutation: true });
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

    await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getErrorOutput()).toContain("post-update process terminated by signal SIGTERM");

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

  it.each([
    { targetVersion: "2026.4.10", fresh: false },
    { targetVersion: "2026.4.29", fresh: true },
    { targetVersion: "2026.9.1", fresh: true },
  ])(
    "finalizes downgrade to $targetVersion with target writer=$fresh",
    async ({ targetVersion, fresh }) => {
      vi.mocked(runUtf8CommandWithTimeout).mockRejectedValue(
        new Error("Older target does not contain the migration-continuation worker"),
      );
      candidateValidation.mockImplementation(async (options) =>
        reportCandidateSteps(options, {
          status: "ok",
          steps: [
            {
              name: "candidate migration continuation",
              command: "--check",
              cwd: options.root,
              durationMs: 0,
              exitCode: null,
              advisory: {
                kind: "candidate-runtime-unavailable",
                message:
                  "candidate predates the migration-continuation contract; finalization runs in the current binary",
              },
            },
          ],
        }),
      );
      const inspectOriginalState = expectDefined(
        stateSchemaVersions.getMockImplementation(),
        "state schema inspection mock is initialized",
      );
      stateSchemaVersions.mockImplementation(async (options) => {
        if (options.root !== undefined) {
          throw new Error("The older target has no state schema worker");
        }
        return inspectOriginalState(options);
      });
      const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(
        createCaseDir("openclaw-downgrade-writer"),
        "2026.9.3-beta.1",
      );
      mockFileBackedPathExists();
      readPackageVersion.mockImplementation(async (root: string) => {
        const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
        return pkg.version;
      });
      mockServicePackageCommands({
        nodeModules,
        packageRoot: pkgRoot,
        targetVersion,
        npmCommands: ["npm"],
        nodeVersions: {},
      });
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entryPath);

      await updateCommand({ channel: "stable", yes: true, tag: targetVersion, restart: false });

      if (fresh) {
        expect(spawn).toHaveBeenCalledOnce();
        expect(spawnCall()?.[1]).toContain(entryPath);
        expect(spawnCall()?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBe("stable");
        expectNoSideEffects(
          replaceConfigFile,
          syncPluginsForUpdateChannel,
          updateNpmInstalledPlugins,
        );
      } else {
        expect(spawn).not.toHaveBeenCalled();
        expect(syncPluginsForUpdateChannel).toHaveBeenCalledOnce();
        expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      }
      expectNoSideEffects(runDaemonInstall, callGateway);
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    },
  );

  it.each([true, false])(
    "checks original Git version before a package downgrade (dry-run=%s)",
    async (dryRun) => {
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(
        createCaseDir("openclaw-git-downgrade"),
      );
      readPackageVersion.mockResolvedValue("2026.9.3-beta.1");
      primeNpmChannelTag("latest", "2026.9.1");

      await updateCommand({ channel: "stable", json: true, dryRun });

      if (dryRun) {
        expect(lastWriteJsonCall()).toMatchObject({
          currentVersion: "2026.9.3-beta.1",
          targetVersion: "2026.9.1",
          downgradeRisk: true,
          switchToPackage: true,
        });
      } else {
        expect(getErrorOutput()).toContain("Downgrade confirmation required.");
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      }
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expectNoSideEffects(runGatewayUpdate, replaceConfigFile, spawn);
    },
  );

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
    mockCurrentProcessFreshDoctor();
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
    vi.mocked(runExec).mockRejectedValueOnce(
      Object.assign(new Error("Command failed: " + "long-argv-prefix ".repeat(100)), {
        stderr: "doctor process failed: config migration refused",
        stdout: "doctor diagnostic output",
      }),
    );
    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-doctor-execution-failed",
    });
    expect(result.pluginUpdate.warnings?.at(-1)?.reason).toContain("doctor process failed");
    expect(result.pluginUpdate.warnings?.at(-1)?.reason).toContain("doctor diagnostic output");
    expect(result.pluginUpdate.warnings?.at(-1)?.reason).not.toContain("long-argv-prefix");
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

  it.each([
    { exitCode: 2, handoff: undefined, expectedExit: 1 },
    { exitCode: 2, handoff: "1", expectedExit: 79 },
    { exitCode: 78, handoff: "1", expectedExit: 79 },
    { exitCode: 79, handoff: "1", expectedExit: 79 },
    { exitCode: 80, handoff: "1", expectedExit: 79 },
  ])(
    "preserves foreground failure $exitCode without granting handoff $handoff authority",
    async ({ exitCode, handoff, expectedExit }) => {
      setupUpdatedRootRefresh();
      spawn.mockImplementationOnce(() => {
        const child = new EventEmitter() as EventEmitter & {
          once: EventEmitter["once"];
        };
        queueMicrotask(() => {
          child.emit("exit", exitCode, null);
        });
        return child;
      });

      await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: handoff }, async () => {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(
          new ExitError(expectedExit),
        );
      });

      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(spawnCall()?.[2]?.env?.OPENCLAW_UPDATE_RUN_HANDOFF).toBe(handoff);
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "post-core-update-failed",
        recovery: { serviceRestartSafe: false },
      });
      expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    },
  );

  it("post-core resume returns package work without running core update or Doctor completion", async () => {
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
    expect(vi.mocked(runExec).mock.calls.filter(([, args]) => args[1] === "doctor")).toEqual([]);
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

  it("returns convergence-only post-core changes for the parent to complete", async () => {
    runPostCorePluginConvergenceSpy.mockResolvedValueOnce(
      postCoreConvergenceResult({
        changes: ["Repaired configured plugin install records."],
      }),
    );

    await runPostCoreCommand({ restart: false, json: true });

    expect(syncPluginCall()?.config).toBeDefined();
    expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(runExec)
        .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? "")),
    ).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "ok",
      postUpdate: { plugins: { changed: true } },
    });
  });

  it.each([false, true].flatMap((json) => [false, true].map((errored) => ({ json, errored }))))(
    "preserves convergence diagnostic output (json=$json, errored=$errored)",
    async ({ json, errored }) => {
      const repairWarning = {
        reason: "Package lookup deferred.",
        message: "Package lookup deferred.",
        guidance: ["Retry plugin repair."],
      };
      const smokeWarning = {
        pluginId: "reporting-fixture",
        reason: "missing-main-entry: entry missing",
        message: 'Plugin "reporting-fixture" failed payload verification.',
        guidance: ["Inspect the plugin entry."],
      };
      const notice = {
        reason: "Retained plugin remains available.",
        message: "Retained plugin remains available.",
        guidance: [],
      };
      const warnings = errored ? [repairWarning, smokeWarning] : [repairWarning];
      runPostCorePluginConvergenceSpy.mockResolvedValueOnce({
        ...postCoreConvergenceResult({ warnings, errored }),
        notices: [notice],
      });
      const { updatePluginsAfterCoreUpdate } =
        await import("./update-cli/update-command-plugins.js");

      const result = await updatePluginsAfterCoreUpdate({
        root: process.cwd(),
        channel: "stable",
        configSnapshot: baseSnapshot,
        timeoutMs: 60_000,
        json,
      });

      expect(result).toEqual({
        status: errored ? "error" : "warning",
        changed: false,
        warnings: [...warnings, notice],
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: {
          changed: false,
          outcomes: errored
            ? [{ pluginId: "reporting-fixture", status: "error", message: smokeWarning.message }]
            : [],
        },
        integrityDrifts: [],
      });
      const logs = vi
        .mocked(defaultRuntime.log)
        .mock.calls.map(([value]) => stripAnsi(String(value)));
      expect(logs).toEqual(
        json
          ? []
          : [
              "",
              "Updating plugins...",
              repairWarning.message,
              "  Retry plugin repair.",
              ...(errored ? [smokeWarning.message, "  Inspect the plugin entry."] : []),
              notice.message,
              errored
                ? "npm plugins: 0 updated, 0 unchanged, 1 failed."
                : "No plugin updates needed.",
              ...(errored ? [smokeWarning.message] : []),
            ],
      );
    },
  );

  it("preserves typed repair outcomes from post-core convergence", async () => {
    const consentOutcome = {
      pluginId: "consent-fixture",
      status: "error" as const,
      code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
      message: "Operator review token changed.",
    };
    runPostCorePluginConvergenceSpy.mockResolvedValueOnce({
      ...postCoreConvergenceResult({ errored: true }),
      outcomes: [consentOutcome],
    });
    const { updatePluginsAfterCoreUpdate } = await import("./update-cli/update-command-plugins.js");

    const result = await updatePluginsAfterCoreUpdate({
      root: process.cwd(),
      channel: "stable",
      configSnapshot: baseSnapshot,
      timeoutMs: 60_000,
      json: true,
    });

    expect(result.status).toBe("error");
    expect(result.npm.outcomes).toContainEqual(consentOutcome);
  });

  it("returns changed package results without Doctor output during JSON post-core resume", async () => {
    mockNpmPluginOutcomes([], true);

    await runPostCoreCommand({ json: true, restart: false });

    expect(
      vi
        .mocked(runExec)
        .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? "")),
    ).toEqual([]);
    expect(JSON.parse(getLogOutput())).toEqual(lastWriteJsonCall());
    expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        postUpdate: expect.objectContaining({
          plugins: expect.objectContaining({ changed: true }),
        }),
      }),
    );
  });

  it.each([false, true])(
    "post-core resume children leave run ownership with the parent (forwarded run=%s)",
    async (forwardedRun) => {
      const resultDir = createCaseDir("openclaw-post-core-result");
      const resultPath = path.join(resultDir, "plugins.json");
      await fs.mkdir(resultDir, { recursive: true });
      const parentRun = forwardedRun
        ? createUpdateRun({
            trigger: "cli",
            before: { version: "2026.9.1" },
            target: { version: "2026.9.2" },
          })
        : undefined;
      const runsBefore = listUpdateRuns();

      await runPostCoreCommand(
        { restart: false },
        {
          OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: resultPath,
          OPENCLAW_UPDATE_RUN_ID: parentRun?.runId,
        },
      );

      const result = JSON.parse(await fs.readFile(resultPath, "utf-8")) as {
        status?: string;
      };
      expect(result.status).toBe("ok");
      expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
      expectNoSideEffects(runGatewayUpdate, spawn);
      expect(listUpdateRuns()).toEqual(runsBefore);
    },
  );

  it("post-core resume mode uses the parent install records snapshot for missing payload warnings", async () => {
    mockNoopPostUpdatePluginConvergence();
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

  it.each(
    [
      { touchedVersion: "9999.1.1", valid: true, writes: true },
      { touchedVersion: VERSION, valid: true, writes: false },
      { touchedVersion: "9999.1.1", valid: false, writes: false },
    ].flatMap(({ touchedVersion, valid, writes }) =>
      ["resume", "finalize"].map((mode) => ({ touchedVersion, valid, writes, mode })),
    ),
  )(
    "$mode commits a validated downgrade without changing channels ($touchedVersion, valid=$valid)",
    async ({ touchedVersion, valid, writes, mode }) => {
      const config = stableConfig({ meta: { lastTouchedVersion: touchedVersion } });
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config, { valid }));

      if (mode === "resume") {
        await runPostCoreCommand({ restart: false, json: true });
        expect(
          vi
            .mocked(runExec)
            .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? "")),
        ).toEqual([]);
      } else {
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
        if (valid) {
          await updateFinalizeCommand({ json: true, yes: true });
        } else {
          await expect(updateFinalizeCommand({ json: true, yes: true })).rejects.toEqual(
            new ExitError(1),
          );
        }
      }

      if (writes) {
        expect(replaceConfigFile).toHaveBeenCalledExactlyOnceWith({ nextConfig: config });
        expect(mutateConfigFileWithRetry).toHaveBeenCalledWith({ mutate: expect.any(Function) });
      } else {
        expect(replaceConfigFile).not.toHaveBeenCalled();
      }
      expect(runGatewayUpdate).not.toHaveBeenCalled();
    },
  );

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

  it.each(
    (["installed", "bridge"] as const).flatMap((source) =>
      (["update", "finalize"] as const).map((mode) => ({ source, mode })),
    ),
  )(
    "fails $mode without another restart when $source awaits capability consent",
    async ({ source, mode }) => {
      const pluginId = "consent-fixture";
      const config = stableConfig({ plugins: { entries: { [pluginId]: { enabled: true } } } });
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
      mockOwnedGitService();
      mockGitUpdateAfterMutation();
      serviceLoaded.mockResolvedValue(true);
      if (source === "bridge") {
        const install = await import("../plugins/install.js");
        vi.spyOn(install, "installPluginFromNpmSpec").mockRejectedValueOnce(
          new ManagedPluginLifecycleError("Operator review token changed.", {
            capabilityConsent: { pluginId, reviewToken: "operator-review" },
          }),
        );
        const actual = await vi.importActual<typeof import("../plugins/update-channel.js")>(
          "../plugins/update-channel.js",
        );
        syncPluginsForUpdateChannel.mockImplementationOnce((params) =>
          actual.syncPluginsForUpdateChannel({
            ...params,
            externalizedBundledPluginBridges: [
              { bundledPluginId: pluginId, npmSpec: "@example/companion" },
            ],
          }),
        );
      } else {
        mockNpmPluginOutcomes([
          {
            pluginId,
            status: "error",
            code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
            message: "Operator review token changed.",
          },
        ]);
      }

      if (mode === "finalize") {
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
          FRESH_POST_UPDATE_ENTRYPOINT,
        );
      }
      const command =
        mode === "finalize"
          ? updateFinalizeCommand({ yes: true, json: true, restart: false })
          : updateCommand({ yes: true, json: true });
      await expect(command).rejects.toEqual(new ExitError(1));

      const { run, ...jsonOutput } = expectDefined(
        lastWriteJsonCall(),
        "JSON update failure",
      ) as UpdateRunResult & {
        run?: UpdateRunRecord;
      };
      expect(jsonOutput?.status).toBe("error");
      if (mode === "update") {
        expect(jsonOutput?.reason).toBe("post-update-plugins");
        expect(run).toMatchObject({
          runId: jsonOutput.runId,
          status: "failed",
          reason: "post-update-plugins",
        });
      }
      expect(jsonOutput?.postUpdate?.plugins?.status).toBe("error");
      expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes).toEqual([
        expect.objectContaining({
          pluginId,
          status: "error",
          code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
        }),
      ]);
      if (source === "bridge") {
        expect(jsonOutput?.postUpdate?.plugins?.sync.errors).toEqual([
          'Failed to update consent-fixture: Operator review token changed.\nBundled relocation did not install the replacement plugin payload; resolve the error above, then run "openclaw update repair".',
        ]);
      }
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expectNoSideEffects(serviceRestart, runDaemonRestart);
      expect(runRestartScript).toHaveBeenCalledTimes(mode === "update" ? 1 : 0);
      if (mode === "update") {
        expect(runRestartScript.mock.invocationCallOrder[0]).toBeLessThan(
          requireValue(
            syncPluginsForUpdateChannel.mock.invocationCallOrder[0],
            "plugin convergence order",
          ),
        );
      }
      expect(runUpdateFailureTriage).toHaveBeenCalledOnce();
      expect(vi.mocked(runUpdateFailureTriage).mock.calls[0]?.[0].mode).toBe("json");
      expect(getTriageFailures()).toContainEqual(
        expect.objectContaining({
          result:
            mode === "update"
              ? jsonOutput
              : expect.objectContaining({
                  status: "error",
                  mode: "unknown",
                  reason: "post-update-plugins",
                  postUpdate: { plugins: jsonOutput?.postUpdate?.plugins },
                }),
        }),
      );
    },
  );

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
        errors: [{ pluginId: "demo", message: clawHubSyncRiskError }],
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
          errors: [{ pluginId: "demo", message: clawHubSyncRiskError }],
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
    mockNoopPostUpdatePluginConvergence();
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
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === installPath || candidate === path.join(process.cwd(), "dist", "index.js"),
    );
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

  it.each([
    ["plugin sync", syncPluginsForUpdateChannel],
    ["npm update", updateNpmInstalledPlugins],
  ] as const)("fails unexpected post-core %s exceptions", async (phase, updatePlugins) => {
    const message = `${phase} invariant broke`;
    updatePlugins.mockRejectedValueOnce(new Error(message));

    await expect(updateCommand({ json: true, restart: false })).rejects.toEqual(new ExitError(1));
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "post-update-failed",
      steps: [expect.objectContaining({ exitCode: 1, stderrTail: message })],
    });
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
        mockOwnedGitService();
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
    const stateDir = tempDirs.make("openclaw-update-run-preview-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await updateCommand({ dryRun: true, json: true, channel: "beta", acceptCapabilities: true });
      const output = lastWriteJsonCall() as { runId: string };
      expect(listUpdateRuns()).toMatchObject([
        {
          runId: output.runId,
          trigger: "cli",
          phase: "finished",
          status: "skipped",
          reason: "dry-run",
        },
      ]);
    });

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

  it.each([false, true])(
    "records ordered update phases across service stop, restart, and verified health (json=%s)",
    async (json) => {
      const ledgerReads = vi.spyOn(await import("../infra/update-run-ledger.js"), "getUpdateRun");
      const inspectSchemas = expectDefined(
        stateSchemaVersions.getMockImplementation(),
        "schema inspection",
      );
      let observedActivation = false;
      stateSchemaVersions.mockImplementation(async (options) => {
        const versions = await inspectSchemas(options);
        if (serviceStop.mock.calls.length > 0 && !observedActivation) {
          // The real onActivation callback has run, but schema inspection has not
          // yet authorized this process to reopen the candidate's ledger.
          const progress = expectDefined(
            vi.mocked(runGatewayUpdate).mock.calls[0]?.[0]?.progress,
            "update progress",
          );
          const readsBefore = ledgerReads.mock.calls.length;
          expectDefined(
            progress.onStepComplete,
            "step completion",
          )({
            name: "core migrations",
            command: "doctor --fix",
            index: 0,
            total: 1,
            durationMs: 1,
            exitCode: 0,
          });
          expect(ledgerReads).toHaveBeenCalledTimes(readsBefore);
          observedActivation = true;
        }
        return versions;
      });
      mockOwnedGitService();
      mockGitUpdateAfterMutation(
        makeOkUpdateResult({
          root: process.cwd(),
          before: { version: "0.9.0" },
          after: { version: "1.0.0" },
        }),
      );
      mockCurrentProcessFreshDoctor();
      serviceLoaded.mockResolvedValue(true);
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
        path.join(process.cwd(), "dist", "index.js"),
      );
      prepareRestartScript.mockResolvedValue(null);
      try {
        await updateCommand({ yes: true, json });
      } catch (error) {
        throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, {
          cause: error,
        });
      }
      expect(observedActivation).toBe(true);
      expect(freshRestartCalls()).toHaveLength(1);
      expect(runDaemonRestart).not.toHaveBeenCalled();
      const run = expectDefined(listUpdateRuns({ limit: 1 })[0], "admitted update run");
      expect(serviceStop, getErrorOutput()).toHaveBeenCalledOnce();
      expect(run, getErrorOutput()).toMatchObject({
        trigger: "cli",
        status: "succeeded",
        phase: "finished",
        verification: { serviceRunning: true, runningVersion: "1.0.0" },
      });
      expect(
        run?.steps
          .filter((step) =>
            [
              "requested",
              "staging",
              "validating",
              "activating",
              "restarting",
              "verifying",
            ].includes(step.step),
          )
          .map((step) => step.step),
      ).toEqual(["requested", "staging", "validating", "activating", "restarting", "verifying"]);
      if (!json) {
        expect(getLogOutput()).toContain("Phase: activating");
        expect(getLogOutput()).toContain("Phase: verifying");
      }
    },
  );

  it("does not clean managed-service handoffs before rejecting an invalid timeout", async () => {
    const runsBefore = listUpdateRuns();
    await invokeUpdateCli({ timeout: "" });

    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(listUpdateRuns()).toEqual(runsBefore);
  });

  it.each([
    { name: "update", run: async () => await invokeUpdateCli({ channel: "" }) },
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

  it.each([
    { kind: "package", callerIncompatible: false },
    { kind: "git", callerIncompatible: false },
    { kind: "package-to-git", callerIncompatible: false },
    { kind: "package-preview", callerIncompatible: false },
    { kind: "package", callerIncompatible: true },
    { kind: "package-stopped", callerIncompatible: false },
  ] as const)(
    "refuses a service-only incompatible $kind target before any mutable preparation, callerIncompatible=$callerIncompatible",
    async ({ kind, callerIncompatible }) => {
      const fixture = createCaseDir(`schema-service-only-${kind}`);
      const { pkgRoot, nodeModules, entryPath } = await setupInstalledPackageRoot(fixture, "1.0.0");
      const root = kind === "git" ? fixture : pkgRoot;
      const destination = path.join(fixture, "checkout");
      let destinationVisibleAtAdmission: boolean | undefined;
      if (kind === "git") {
        await writeOpenClawPackageFixture(root, "1.0.0", { git: true });
        vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
      } else {
        mockFileBackedPathExists();
        mockNpmGlobalRoot(nodeModules);
      }
      const managedState = profileStateDir("work");
      const callerState = profileStateDir("personal");
      mockOwnedGitService(root);
      if (kind === "package-to-git") {
        mockFileBackedPathExists();
        mockNpmGlobalCommands(nodeModules, async (argv) => {
          if (argv[0] === "git" && argv[1] === "clone") {
            await writeOpenClawPackageFixture(argv.at(-1)!, "1.0.0", { git: true });
            return commandResult();
          }
          return undefined;
        });
      }
      primeServiceCommand(
        [
          "node",
          kind === "git" ? path.join(root, "dist", "index.js") : entryPath,
          "gateway",
          "run",
        ],
        {
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: managedState,
          OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
        },
      );
      serviceLoaded.mockResolvedValue(true);
      if (kind === "package-stopped") {
        serviceLoaded.mockResolvedValue(false);
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      }
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
      );
      if (kind === "git" || kind === "package-to-git") {
        vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
          destinationVisibleAtAdmission = fsSync.existsSync(destination);
          await options?.beforeGitMutation?.({ schemaVersions: { state: 3, agent: 11 } });
          throw new Error("incompatible service target must not reach Git mutation");
        });
      }
      const inspectedStates: Array<string | undefined> = [];
      databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(({ env }) => {
        inspectedStates.push(env.OPENCLAW_STATE_DIR);
        return {
          incompatible:
            env.OPENCLAW_STATE_DIR === managedState || callerIncompatible
              ? [
                  {
                    kind: "agent",
                    path: path.join(
                      env.OPENCLAW_STATE_DIR!,
                      "agents",
                      "worker",
                      "agent",
                      "openclaw-agent.sqlite",
                    ),
                    foundVersion: 999,
                    supportedVersion: 11,
                  },
                ]
              : [],
          indeterminate: [],
        };
      });
      await withEnvAsync(
        {
          OPENCLAW_PROFILE: "personal",
          OPENCLAW_STATE_DIR: callerState,
          OPENCLAW_CONFIG_PATH: path.join(callerState, "openclaw.json"),
          OPENCLAW_GIT_DIR: destination,
        },
        async () => {
          if (kind === "package-preview") {
            await updateCommand({ dryRun: true });
            expect(getLogOutput()).toContain("Would refuse update: agent database");
            return;
          }
          await expect(
            updateCommand({
              yes: true,
              json: true,
              ...(kind === "package-to-git" ? { channel: "dev" } : {}),
              ...(kind === "package-stopped" ? { restart: false } : {}),
            }),
          ).rejects.toEqual(new ExitError(1));
        },
      );
      expect(inspectedStates).toContain(callerState);
      expect(inspectedStates).toContain(managedState);
      if (callerIncompatible) {
        expect(getErrorOutput()).toContain(
          path.join(callerState, "agents", "worker", "agent", "openclaw-agent.sqlite"),
        );
        expect(getErrorOutput()).toContain(
          path.join(managedState, "agents", "worker", "agent", "openclaw-agent.sqlite"),
        );
      }
      expectNoSideEffects(
        serviceStop,
        serviceStart,
        serviceRestart,
        managedUpdateHandoff.start,
        cleanupStaleManagedServiceUpdateHandoffs,
        launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(packageInstallCommandCall()).toBeUndefined();
      if (kind === "package-to-git") {
        expect(destinationVisibleAtAdmission).toBe(false);
        expect(fsSync.existsSync(destination)).toBe(false);
      }
    },
  );

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

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).toHaveBeenCalledWith({
      // The inspection snapshot retains the scoped marker after the updater
      // restores process.env on refusal.
      env: { ...process.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      supportedVersions: { state: 3, agent: 9 },
      configuredAgentDatabaseTargets: [],
      configuredAgentDatabaseCandidatePaths: [
        path.join(profileStateDir(), "agents", "main", "agent", "openclaw-agent.sqlite"),
      ],
    });
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(listUpdateRuns({ limit: 1 })[0]?.origin.nextAction).toContain(
      "agent database (agent main)",
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(listUpdateRuns({ limit: 1 })).toMatchObject([
      { trigger: "cli", phase: "finished", status: "failed", reason: "database-schema-preflight" },
    ]);
  });

  it.each(["absent", "foreign"] as const)(
    "refuses a newly owned service after an initially %s Git admission snapshot",
    async (initial) => {
      const root = createCaseDir(`new-service-${initial}`);
      await writeOpenClawPackageFixture(root, "1.0.0", { git: true });
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
      if (initial === "foreign") {
        const foreignRoot = createCaseDir("foreign-service-root");
        const foreignEntry = await writeOpenClawPackageFixture(foreignRoot, "1.0.0");
        mockRunningManagedGateway(["node", foreignEntry, "gateway", "run"]);
      }
      const managedState = profileStateDir("work");
      let admitted = false;
      databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(({ env }) => ({
        incompatible:
          env.OPENCLAW_STATE_DIR === managedState
            ? [
                {
                  kind: "agent",
                  path: path.join(managedState, "worker.sqlite"),
                  foundVersion: 999,
                  supportedVersion: 11,
                },
              ]
            : [],
        indeterminate: [],
      }));
      vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
        primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: managedState,
          OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
        });
        serviceLoaded.mockResolvedValue(true);
        await options?.beforeGitMutation?.({ schemaVersions: { state: 3, agent: 11 } });
        admitted = true;
        return makeOkUpdateResult({ mode: "git", root });
      });
      let failure: unknown;
      try {
        await updateCommand({ yes: true, json: true });
      } catch (error) {
        failure = error;
      }
      expect(admitted).toBe(false);
      expect(failure).toEqual(new ExitError(1));
      expectNoSideEffects(
        serviceStop,
        cleanupStaleManagedServiceUpdateHandoffs,
        launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "managed-service-preflight",
      });
    },
  );

  it("preserves best-effort preview when target metadata is unavailable", async () => {
    await updateCommand({ dryRun: true, json: true });
    expect(lastWriteJsonCall()).toMatchObject({
      dryRun: true,
      notes: expect.arrayContaining([
        expect.stringContaining("Could not preview Git target schema support"),
      ]),
    });
    expectNoSideEffects(
      runGatewayUpdate,
      serviceStop,
      cleanupStaleManagedServiceUpdateHandoffs,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it.each([
    "package metadata",
    "package schema",
    "package runtime",
    "npm policy",
    "clone failure",
    "non-git directory",
    "git metadata",
    "git schema",
  ] as const)("returns verified handoff recovery for a %s refusal", async (failure) => {
    const tempDir = tempDirs.make("openclaw-update-handoff-preflight-");
    const { nodeModules } = await setupInstalledPackageRoot(tempDir);
    const gitRoot = path.join(tempDir, "checkout");
    const packageTarget = failure.startsWith("package ");
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (failure === "npm policy" && argv[0] === "npm" && argv[1] === "--version") {
        return commandResult({ stdout: "unrecognized npm version\n" });
      }
      if (failure === "clone failure" && argv[0] === "git" && argv[1] === "clone") {
        return commandResult({ code: 128, stderr: "clone unavailable" });
      }
      return undefined;
    });
    if (failure === "non-git directory") {
      await fs.mkdir(gitRoot);
      await fs.writeFile(path.join(gitRoot, "keep.txt"), "operator data\n");
    }
    if (failure.startsWith("git ")) {
      await writeOpenClawPackageFixture(gitRoot, "2026.8.18", { git: true });
      vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
        await options?.beforeGitMutation?.(
          failure === "git metadata"
            ? { metadataUnreadable: "missing package metadata" }
            : { schemaVersions: { state: 3, agent: 11 } },
        );
        throw new Error("refused Git target must not mutate");
      });
    }
    if (failure === "package metadata") {
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ version: null, error: "registry timeout" }),
      );
    }
    if (failure.endsWith("schema")) {
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
      );
      databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
        incompatible: [],
        indeterminate: [{ kind: "state", path: "/tmp/openclaw.sqlite", reason: "database busy" }],
      });
    }
    if (failure === "package runtime") {
      nodeVersionSatisfiesEngine.mockReturnValue(false);
    }

    await withEnvAsync(
      { OPENCLAW_UPDATE_RUN_HANDOFF: "1", OPENCLAW_GIT_DIR: gitRoot },
      async () => {
        await expect(
          updateCommand({ channel: packageTarget ? "beta" : "dev", yes: true, json: true }),
        ).rejects.toEqual(new ExitError(1));
      },
    );

    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      recovery: { serviceRestartSafe: true },
    });
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(serviceStop, serviceRestart, replaceConfigFile);
    if (failure === "non-git directory") {
      await expect(fs.readFile(path.join(gitRoot, "keep.txt"), "utf8")).resolves.toBe(
        "operator data\n",
      );
    }
  });

  it("skips package schema preflight when target metadata is missing", async () => {
    await mockPackageInstallAtCaseDir("openclaw-schema-missing");
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

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(databasePreflightMocks.preflightOpenClawDatabaseSchemas, serviceStop);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(getLogOutput()).toContain("could not inspect exact package target openclaw@9999.0.0");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("continues a package update when target schemas are compatible", async () => {
    await mockPackageInstallAtCaseDir("openclaw-schema-compatible");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );

    await updateCommand({ yes: true, restart: false });

    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).toHaveBeenCalled();
    for (const [input] of databasePreflightMocks.preflightOpenClawDatabaseSchemas.mock.calls) {
      expect(input).toMatchObject({ supportedVersions: { state: 3, agent: 11 } });
    }
    expect(packageInstallCommandCall()?.[0]).toContain("openclaw@9999.0.0");
  });

  it.each([true, false])(
    "uses inspected package runtime requirements when a later lookup disagrees (compatible=%s)",
    async (compatible) => {
      await mockPackageInstallAtCaseDir("openclaw-runtime-target");
      const inspectedEngine = compatible ? ">=22.19.0" : ">=999.0.0";
      vi.mocked(fetchNpmPackageTargetStatus)
        .mockResolvedValueOnce(packageTargetStatus({ nodeEngine: inspectedEngine }))
        .mockResolvedValue(
          packageTargetStatus({ nodeEngine: compatible ? ">=999.0.0" : ">=22.19.0" }),
        );
      nodeVersionSatisfiesEngine.mockImplementation(
        (_version: string | null, engine: string | null) => engine !== ">=999.0.0",
      );

      if (compatible) {
        await updateCommand({ yes: true, restart: false });
      } else {
        await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(
          new ExitError(1),
        );
      }

      if (compatible) {
        expect(packageInstallCommandCall()?.[0]).toContain("openclaw@9999.0.0");
      } else {
        expect(packageInstallCommandCall()?.[0]).toBeUndefined();
        expect(getLogOutput()).toContain("The requested package requires >=999.0.0");
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
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it("does not clean handoffs before rejecting an unknown package owner", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-unknown-owner"));
    resolveGlobalManager.mockRejectedValueOnce(
      new Error(
        "Update refused: package manager owner is unknown; no changes were made. Run this OpenClaw install through its active npm, pnpm, or Bun global shim, or reinstall it with that package manager, then retry.",
      ),
    );

    await expect(updateCommand({ yes: true, restart: false })).rejects.toThrow(
      "Update refused: package manager owner is unknown; no changes were made. Run this OpenClaw install through its active npm, pnpm, or Bun global shim, or reinstall it with that package manager, then retry.",
    );

    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
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
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
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

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(serviceStop, serviceRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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

  it("refuses incompatible managed-state schemas before stopping the package service", async () => {
    const { pkgRoot } = await setupInstalledPackageRoot(createCaseDir("schema-package"), "1.0.0");
    const entrypoint = path.join(pkgRoot, "dist", "index.js");
    const nodeRunner = path.join(fixtureRoot, "managed", "node");
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    mockOwnedGitService(pkgRoot);
    primeServiceCommand([nodeRunner, entrypoint, "gateway", "run"], {
      OPENCLAW_STATE_DIR: profileStateDir(),
    });
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(({ env }) =>
      env?.OPENCLAW_STATE_DIR === profileStateDir()
        ? {
            incompatible: [
              {
                kind: "agent",
                path: "/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite",
                foundVersion: 12,
                supportedVersion: 11,
              },
            ],
            indeterminate: [],
          }
        : { incompatible: [], indeterminate: [] },
    );

    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19999" }, async () => {
      await expect(updateCommand({ yes: true, json: true, timeout: "17" })).rejects.toEqual(
        new ExitError(1),
      );
    });

    expect(serviceStop).not.toHaveBeenCalled();
    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas.mock.calls[1]?.[0].env).toEqual(
      expect.objectContaining({ OPENCLAW_STATE_DIR: profileStateDir() }),
    );
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(freshRestartCalls()).toEqual([]);
    expectNoSideEffects(serviceStart, serviceRestart);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "database-schema-preflight",
    });
    expect(getTriageFailures()).toContainEqual(
      expect.objectContaining({
        error: expect.stringContaining("openclaw-agent.sqlite"),
        result: expect.objectContaining({
          reason: "database-schema-preflight",
          steps: [],
        }),
      }),
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("refuses a git target that changes after the service stops", async () => {
    const root = createCaseDir("schema-git");
    const sha = "a".repeat(40);
    await writeOpenClawPackageFixture(root, "1.0.0", {
      git: true,
      builtSha: sha,
      entrySource: "export {};\n",
    });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(runCommandWithTimeout).mockResolvedValue(commandResult({ stdout: sha }));
    mockOwnedGitService(root);
    mockGatewayHealth("1.0.0", "restored", "fixture-original-build");
    const entrypoint = path.join(root, "dist", "index.js");
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);

    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
      await options?.beforeGitMutation?.({ schemaVersions: { state: 3, agent: 11 } });
      return makeOkUpdateResult({ mode: "git" });
    });
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(() =>
      serviceStop.mock.calls.length === 0
        ? { incompatible: [], indeterminate: [] }
        : {
            incompatible: [],
            indeterminate: [
              { kind: "agent", path: "/tmp/openclaw-agent.sqlite", reason: "database busy" },
            ],
          },
    );

    await expect(updateCommand({ yes: true, timeout: "17" })).rejects.toEqual(new ExitError(1));

    expect(serviceStop).toHaveBeenCalledOnce();
    const stoppedAt = serviceStop.mock.invocationCallOrder[0]!;
    const schemaCalls =
      databasePreflightMocks.preflightOpenClawDatabaseSchemas.mock.invocationCallOrder;
    expect(schemaCalls.some((order) => order < stoppedAt)).toBe(true);
    expect(schemaCalls.some((order) => order > stoppedAt)).toBe(true);
    expect(freshRestartCalls()).toEqual([
      [
        [process.execPath, entrypoint, "gateway", "restart", "--preserve-definition", "--json"],
        expect.objectContaining({ cwd: root, timeoutMs: 17_000, baseEnv: {} }),
      ],
    ]);
    expectNoSideEffects(serviceStart, serviceRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(vi.mocked(runCommandWithTimeout).mock.invocationCallOrder.at(-1)).toBeLessThan(
      requireValue(
        vi.mocked(runUpdateFailureTriage).mock.invocationCallOrder.at(-1),
        "triage after service recovery",
      ),
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

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(serviceStop, serviceRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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
      if (installKind === "package" && expectedChannel === undefined) {
        await mockPackageInstallAtCaseDir();
      }
      if (installKind === "git" && expectedChannel === undefined) {
        await mockPackageInstallAtCaseDir();
        vi.mocked(resolveUpdateInstallKind).mockResolvedValue("git");
        vi.mocked(resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "git" });
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
        const prefix = createCaseDir("openclaw-update-git-prefix");
        const { nodeModules } = await setupInstalledPackageAtNodeModules(
          path.join(prefix, "lib", "node_modules"),
          "1.0.0",
        );
        const gitRoot = createCaseDir("openclaw-update-git");
        const sha = "a".repeat(40);
        await writeOpenClawPackageFixture(gitRoot, "2026.8.17", {
          git: true,
          builtSha: sha,
          entrySource: "export {};\n",
        });
        const canonicalGitRoot = await fs.realpath(gitRoot);
        mockFileBackedPathExists();
        mockNpmGlobalCommands(nodeModules, undefined, canonicalGitRoot);
        mockGitUpdateAfterMutation(
          makeOkUpdateResult({
            mode: "git",
            root: canonicalGitRoot,
            after: { sha, version: "2026.8.17" },
          }),
        );
        await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
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
    await mockPackageInstallAtCaseDir();
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      config: { update: { channel: "beta" } } as OpenClawConfig,
    });
    primeNpmChannelTag("latest", "1.2.3-1");
    await updateCommand({});

    expectPackageInstallSpec("openclaw@1.2.3-1");
  });

  it("installs the verified exact package and persists an explicit extended-stable channel", async () => {
    await mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValueOnce("1.0.0").mockResolvedValue("2026.6.33");

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
    await mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValueOnce("1.0.0").mockResolvedValue("2026.6.33");
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
    await mockPackageInstallAtCaseDir();
    vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
      status: "failed",
      reason: "selector_missing",
    });

    await expect(updateCommand({ channel: "extended-stable", yes: true })).rejects.toEqual(
      new ExitError(1),
    );

    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(lastWriteJsonCall()).toBeUndefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("fails a stored extended-stable update before launchd cleanup when resolution fails", async () => {
    await mockPackageInstallAtCaseDir();
    const config = { update: { channel: "extended-stable" } } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
    vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
      status: "failed",
      reason: "selector_query_failed",
    });

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { name: "explicit", explicit: true },
    { name: "stored", explicit: false },
  ])("rejects --tag for an $name extended-stable channel", async ({ explicit }) => {
    await mockPackageInstallAtCaseDir();
    if (!explicit) {
      const config = { update: { channel: "extended-stable" } } as OpenClawConfig;
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
    }

    await expect(
      updateCommand({
        ...(explicit ? { channel: "extended-stable" as const } : {}),
        tag: "latest",
        yes: true,
      }),
    ).rejects.toEqual(new ExitError(1));

    expect(resolveExtendedStablePackage).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("rejects extended-stable Git updates before handoff, conversion, or config mutation", async () => {
    await expect(updateCommand({ channel: "extended-stable", yes: true })).rejects.toEqual(
      new ExitError(1),
    );

    expectNoSideEffects(
      resolveExtendedStablePackage,
      runGatewayUpdate,
      replaceConfigFile,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(commandCalls().every(([argv]) => argv[0] === "git" && argv.includes("rev-parse"))).toBe(
      true,
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { name: "refuses", yes: false, installs: false },
    { name: "allows with --yes", yes: true, installs: true },
  ])("$name an extended-stable downgrade in non-interactive mode", async ({ yes, installs }) => {
    setTty(false);
    await mockPackageInstallAtCaseDir();
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
    await mockPackageInstallAtCaseDir();
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

    await expect(
      updateCommand({ channel: "extended-stable", yes: true, json: true, restart: false }),
    ).rejects.toEqual(new ExitError(1));

    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("extended-stable");
    const output = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(output?.status).toBe("error");
    expect(output?.reason).toBe("post-update-plugins");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "never stops a same-version managed gateway (restart=%s)",
    async (restart) => {
      const root = await mockPackageInstallAtCaseDir();
      readPackageVersion.mockResolvedValue("2026.4.22");
      primeNpmChannelTag("latest", "2026.4.22");
      mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);

      await updateCommand({ yes: true, restart, json: true });

      expectNoSideEffects(
        serviceStop,
        serviceRestart,
        runDaemonRestart,
        candidateValidation,
        updateNpmInstalledPlugins,
      );
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(lastWriteJsonCall()).toMatchObject({ status: "skipped", reason: "already-current" });
      const result = lastWriteJsonCall() as UpdateRunResult;
      expect(getUpdateRun(requireValue(result.runId, "no-op run id"))).toMatchObject({
        status: "skipped",
        reason: "already-current",
        downtimeMs: 0,
      });
    },
  );

  it("runs the package update when latest target lookup is unresolved", async () => {
    setTty(false);
    await mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.4.22");
    primeNpmChannelTag("latest", null);
    mockCurrentProcessFreshDoctor();

    await updateCommand({});

    expect(getErrorOutput()).not.toContain("Downgrade confirmation required.");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expectPackageInstallSpec("openclaw@latest");
    expect(vi.mocked(runExec).mock.calls.filter(([, args]) => args[1] === "doctor")).toEqual([]);
  });

  it("blocks the package update when a non-latest dist-tag lookup is unresolved", async () => {
    setTty(false);
    await mockPackageInstallAtCaseDir();
    readPackageVersion.mockResolvedValue("2026.4.22");
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "next",
      version: null,
      error: "HTTP 404",
    });

    await updateCommand({ tag: "next" });

    expect(getErrorOutput()).toContain("Downgrade confirmation required.");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it("warns but still runs package updates when disk space looks low", async () => {
    await mockPackageInstallAtCaseDir();
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

  const packageUpdateInGatewayMessage = [
    "Package updates cannot run from inside the gateway service process.",
    "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
    "Run `openclaw update` from a terminal outside the gateway service.",
  ].join("\n");

  it("allows package updates from inherited gateway service env when the managed gateway is not running", async () => {
    await mockPackageInstallAtCaseDir();
    serviceReadRuntime.mockResolvedValueOnce({
      status: "stopped",
      state: "stopped",
      missingUnit: true,
    });

    await runWithGatewayServiceEnv({ yes: true });

    expect(defaultRuntime.error).not.toHaveBeenCalledWith(packageUpdateInGatewayMessage);
    expectPackageInstallSpec("openclaw@9999.0.0");
  });

  it("refuses an absent service update while its selected port has a real listener", async () => {
    await mockPackageInstallAtCaseDir();
    const actualPortsProbe =
      await vi.importActual<typeof import("../infra/ports-probe.js")>("../infra/ports-probe.js");
    probePortUsage.mockImplementation(actualPortsProbe.probePortUsage);
    const listener = createServer();
    try {
      listener.listen(absentServicePort, "127.0.0.1");
      await once(listener, "listening");
      await expect(runWithGatewayServiceEnv({ yes: true })).rejects.toEqual(new ExitError(1));
      expect(getLogOutput()).toContain("Gateway service inspection is unavailable");
      expect(packageInstallCommandCall()).toBeUndefined();
      expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    } finally {
      if (listener.listening) {
        const closed = once(listener, "close");
        listener.close();
        await closed;
      }
    }
  });

  it("refuses package updates from inherited gateway service env when --no-restart leaves the gateway running", async () => {
    const root = await mockPackageInstallAtCaseDir();
    primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    });
    serviceLoaded.mockResolvedValue(true);

    await expect(runWithGatewayServiceEnv({ yes: true, restart: false })).rejects.toEqual(
      new ExitError(1),
    );

    expect(defaultRuntime.error).toHaveBeenCalledWith(packageUpdateInGatewayMessage);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expectNoSideEffects(serviceStop, runGatewayUpdate);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
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
      await mockPackageInstallAtCaseDir();
      primeServiceCommand(["openclaw", "gateway", "run"], {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      });
      setupRuntime();

      await expect(runWithGatewayServiceEnv({ yes: true })).rejects.toEqual(new ExitError(1));

      expect(getLogOutput()).toContain("Gateway service inspection is unavailable");
      expect(getTriageFailures()).toContainEqual(
        expect.objectContaining({
          result: expect.objectContaining({ reason: "managed-service-preflight" }),
        }),
      );
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expectNoSideEffects(serviceStop, runGatewayUpdate);
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    },
  );

  it("refuses package updates from inherited gateway service env when the service definition is missing but runtime is live", async () => {
    await mockPackageInstallAtCaseDir();
    serviceReadCommand.mockResolvedValue(null);
    serviceReadRuntime.mockResolvedValueOnce({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });

    await expect(runWithGatewayServiceEnv({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(getLogOutput()).toContain("Gateway service inspection is unavailable");
    expect(getTriageFailures()).toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({ reason: "managed-service-preflight" }),
      }),
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expectNoSideEffects(serviceStop, runGatewayUpdate);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it("refuses package updates from inside the active gateway process tree", async () => {
    const root = await mockPackageInstallAtCaseDir();
    primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    mockGetSelfAndAncestorPidsSync.mockReturnValue(
      new Set<number>([process.pid, gatewayFixturePid]),
    );

    await expect(
      withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: "1" }, () => invokeUpdateCli({ yes: true })),
    ).rejects.toEqual(new ExitError(1));

    const errors = getErrorOutput();
    expect(errors).toContain(
      `This command is running inside the gateway process tree (gateway PID ${gatewayFixturePid}).`,
    );
    expect(errors).not.toContain("Run this command from a shell outside the gateway service.");
    expect(errors).toContain("would kill this command");
    expect(errors).toContain("gateway update action or /update");
    expect(errors).not.toContain("stop the gateway service first");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version: "1.0.0",
    });
    expect(doctorCommandCall()).toBeUndefined();
  });

  it.each<{
    platform: "linux" | "darwin";
    env: NodeJS.ProcessEnv;
    supervisor: "systemd" | "launchd";
    options?: Parameters<typeof updateCommand>[0];
    ancestor?: boolean;
    git?: boolean;
  }>([
    { platform: "linux", env: { INVOCATION_ID: "gateway-invocation" }, supervisor: "systemd" },
    { platform: "linux", env: { JOURNAL_STREAM: "8:123" }, supervisor: "systemd" },
    {
      platform: "linux",
      env: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      supervisor: "systemd",
    },
    { platform: "linux", env: {}, supervisor: "systemd", ancestor: true },
    {
      platform: "linux",
      env: { INVOCATION_ID: "gateway-invocation" },
      supervisor: "systemd",
      options: { tag: "./candidate.tgz" },
    },
    {
      platform: "linux",
      env: { INVOCATION_ID: "gateway-invocation" },
      supervisor: "systemd",
      options: { channel: "extended-stable" },
    },
    {
      platform: "darwin",
      env: { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" },
      supervisor: "launchd",
    },
    { platform: "linux", env: {}, supervisor: "systemd", ancestor: true, git: true },
  ])(
    "hands agent-initiated updates to $supervisor before stopping the gateway ($env, git=$git)",
    async ({ platform, env, supervisor, options = {}, ancestor = false, git = false }) => {
      const phases = vi.spyOn(
        await import("./update-cli/update-command-service.js"),
        "maybeStopManagedServiceBeforeMutableUpdate",
      );
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const caseDir = createCaseDir("openclaw-update-handoff");
      const sha = "a".repeat(40);
      const { pkgRoot: root, entryPath } = git
        ? {
            pkgRoot: caseDir,
            entryPath: await writeOpenClawPackageFixture(caseDir, "1.0.0", {
              git: true,
              builtSha: sha,
              entrySource: "export {};\n",
            }),
          }
        : await setupInstalledPackageRoot(caseDir);
      if (git) {
        vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
        vi.mocked(runCommandWithTimeout).mockResolvedValue(commandResult({ stdout: sha }));
        vi.mocked(runGatewayUpdate).mockImplementationOnce(async (updateOptions) => {
          await updateOptions?.inspectGitTarget?.({});
          await updateOptions?.beforeGitMutation?.({});
          return makeOkUpdateResult();
        });
      }
      mockFileBackedPathExists();
      mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
      if (ancestor) {
        mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set([process.pid, gatewayFixturePid]));
      }
      managedUpdateHandoff.start.mockResolvedValue({
        status: "started",
        handoffId: "test-handoff",
        installRoot: root,
        logPath: "/tmp/update-handoff/handoff.log",
        command: "openclaw update --yes",
        pid: 12345,
      });
      managedUpdateHandoff.transfer.mockResolvedValue(true);

      await withEnvAsync(env, () =>
        invokeUpdateCli({ yes: true, json: true, acceptCapabilities: true, ...options }),
      ).catch((error: unknown) => {
        throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, {
          cause: error,
        });
      });

      expect(managedUpdateHandoff.start, getErrorOutput() || getLogOutput()).toHaveBeenCalledWith(
        expect.objectContaining({
          root,
          supervisor,
          parentPid: gatewayFixturePid,
          invocationCwd: process.cwd(),
          tag:
            git || options.channel === "extended-stable" ? undefined : (options.tag ?? "9999.0.0"),
          acceptCapabilities: true,
        }),
      );
      expect(managedUpdateHandoff.transfer).toHaveBeenCalledWith({
        kind: "managed-update-handoff",
        handoffId: "test-handoff",
        installRoot: root,
      });
      expect(phases.mock.calls.every(([params]) => params.phase === "inspect")).toBe(true);
      expect(phases.mock.calls.length).toBeGreaterThan(1);
      expectNoSideEffects(serviceStop, serviceRestart, runRestartScript);
      expect(runGatewayUpdate).toHaveBeenCalledTimes(git ? 1 : 0);
      expect(packageInstallCommandCall()).toBeUndefined();
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      expect(lastWriteJsonCall()).toMatchObject({
        status: "skipped",
        reason: "managed-service-handoff-started",
        steps: [
          expect.objectContaining({
            stdoutTail: expect.stringContaining("/tmp/update-handoff/handoff.log"),
          }),
        ],
      });
      expect(JSON.stringify(lastWriteJsonCall())).toContain("gateway status --deep");
    },
  );

  it("reports a Git service refusal at the final ancestry recheck without an unsafe recovery verdict", async () => {
    const root = createCaseDir("openclaw-git-ancestry-refusal");
    const sha = "a".repeat(40);
    await writeOpenClawPackageFixture(root, "1.0.0", {
      git: true,
      builtSha: sha,
      entrySource: "export {};\n",
    });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(runCommandWithTimeout).mockResolvedValue(commandResult({ stdout: sha }));
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway"]);
    const preparations = mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root }));
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid]));
    const runningRuntime = { status: "running", pid: gatewayFixturePid, state: "running" };
    // The final reread follows the ancestry check immediately before shutdown.
    // Additional schema inspections must not move this fault into handoff selection.
    let preparing = false;
    let preparationReads = 0;
    const maintenance = await import("./update-cli/update-command-service-maintenance.js");
    vi.spyOn(
      await import("./update-cli/update-command-service.js"),
      "maybeStopManagedServiceBeforeMutableUpdate",
    ).mockImplementation(async (params) => {
      preparing = params.phase === "prepare";
      return maintenance.maybeStopManagedServiceBeforeMutableUpdate(params);
    });
    serviceReadRuntime.mockImplementation(async () => {
      if (preparing && ++preparationReads === 2) {
        mockGetSelfAndAncestorPidsSync.mockReturnValue(
          new Set<number>([process.pid, gatewayFixturePid]),
        );
      }
      return runningRuntime;
    });

    await expect(
      withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: "1" }, () =>
        invokeUpdateCli({ yes: true, json: true }),
      ),
    ).rejects.toEqual(new ExitError(1));

    expect(runUpdateFailureTriage).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "managed-service-preflight",
      recovery: { serviceRestartSafe: true },
      steps: [
        expect.objectContaining({
          stderrTail: expect.stringContaining("would kill this command"),
        }),
      ],
    });
    expect(preparations).toEqual([]);
    expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    expect(freshRestartCalls()).toHaveLength(0);
    expect(getErrorOutput()).not.toContain("Update recovery is unverified");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("refuses package updates from inherited gateway runtime pid when process ancestry is truncated", async () => {
    const root = await mockPackageInstallAtCaseDir();
    primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    mockGetSelfAndAncestorPidsSync.mockReturnValue(new Set<number>([process.pid]));

    await expect(
      runWithGatewayServiceEnv(
        { yes: true },
        {
          [GATEWAY_SERVICE_RUNTIME_PID_ENV]: String(gatewayFixturePid),
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
        },
      ),
    ).rejects.toEqual(new ExitError(1));

    const errors = getErrorOutput();
    expect(errors).toContain(
      `This command is running inside the gateway process tree (gateway PID ${gatewayFixturePid}).`,
    );
    expect(errors).not.toContain("Run this command from a shell outside the gateway service.");
    expect(errors).toContain("would kill this command");
    expect(errors).toContain("gateway update action or /update");
    expect(errors).not.toContain("stop the gateway service first");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it("blocks package updates when the target requires a newer Node runtime", async () => {
    await mockPackageInstallAtCaseDir();
    primeNpmChannelTag("latest", "2026.3.23-2");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ target: "latest", version: "2026.3.23-2" }),
    );
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    const report = getLogOutput();
    expect(report).toContain("Node ");
    expect(report).toContain(
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
      await mockPackageInstallAtCaseDir();
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

    await expect(updateCommand(options)).rejects.toEqual(new ExitError(1));

    const result = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(result).toMatchObject({
      status: "error",
      reason: "unsupported-package-target",
      steps: [],
    });
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(resolveGlobalManager, replaceConfigFile, runGatewayUpdate);
    if ("dryRun" in options && options.dryRun) {
      expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    }
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getErrorOutput()).toContain("openclaw update --channel dev");
  });

  it("fails package updates when the installed correction version does not match the requested target", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const nodeModules = path.join(tempDir, "lib", "node_modules");
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
      if (argv[0] === "npm" && argv[1] === "i") {
        await writeNpmPackageInstall(argv, pkgRoot, "2026.3.23");
      }
      return undefined;
    });

    await expect(updateCommand({ yes: true, tag: "2026.3.23-2" })).rejects.toEqual(
      new ExitError(1),
    );

    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
    const logs = getLogOutput();
    expect(logs).toContain("global install verify");
    expect(logs).toContain("global-install-failed");
    expect(logs).toContain("expected installed version 2026.3.23-2, found 2026.3.23");
  });

  it.each(["verification", "lifecycle", "shim swap"] as const)(
    "gates old Gateway recovery at the swap boundary after staged npm %s failure",
    async (failure) => {
      const tempDir = tempDirs.make("openclaw-update-staged-fail-");
      const prefix = path.join(tempDir, "prefix");
      const nodeModules = path.join(prefix, "lib", "node_modules");
      const { pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
        nodeModules,
        "2026.7.1",
      );
      mockFileBackedPathExists();
      mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entryPath);
      const targetShim = path.join(prefix, "bin", "openclaw");
      if (failure !== "verification") {
        await fs.mkdir(path.dirname(targetShim), { recursive: true });
        await fs.writeFile(targetShim, "old shim\n");
      }
      let stagedShim: string | undefined;
      const copyFile = fs.copyFile.bind(fs);
      const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        if (String(args[0]) === stagedShim) {
          throw new Error("staged shim copy failed");
        }
        return await copyFile(...args);
      });
      readPackageVersion.mockResolvedValue("2026.7.1");
      primeNpmChannelTag("latest", "2026.8.1");
      mockNpmGlobalCommands(nodeModules, async (argv) => {
        if (
          failure === "lifecycle" &&
          argv[1]?.endsWith("preinstall-package-manager-warning.mjs")
        ) {
          return commandResult({ code: 1, stderr: "staged lifecycle failed" });
        }
        if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
          expect(serviceStop).not.toHaveBeenCalled();
          expect(freshRestartCalls()).toEqual([]);
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
          if (typeof stagePrefix !== "string") {
            throw new Error("missing stage prefix");
          }
          const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
          await writeOpenClawPackageFixture(stageRoot, "2026.8.1", {
            entrySource: "export {};\n",
            inventory: true,
          });
          if (failure !== "shim swap") {
            await fs.writeFile(
              path.join(stageRoot, LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH),
              "pending\n",
            );
          }
          if (failure === "verification") {
            await fs.writeFile(
              path.join(stageRoot, "dist", "stale-runtime.js"),
              "export {};\n",
              "utf8",
            );
          } else if (failure === "shim swap") {
            stagedShim = path.join(stagePrefix, "bin", "openclaw");
            await fs.mkdir(path.dirname(stagedShim), { recursive: true });
            await fs.writeFile(stagedShim, "new shim\n");
          }
        }
        return undefined;
      });

      try {
        await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));
      } finally {
        copyFileSpy.mockRestore();
      }

      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(doctorCommandCall()).toBeUndefined();
      expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expect(
        commandCalls()
          .filter(([argv]) => argv[0] === process.execPath && argv[1]?.includes("/scripts/"))
          .map(([argv]) => path.basename(requireValue(argv[1], "lifecycle script"))),
      ).toEqual(failure === "lifecycle" ? ["preinstall-package-manager-warning.mjs"] : []);
      await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf-8")).resolves.toContain(
        '"version":"2026.7.1"',
      );
      const logs = getLogOutput();
      if (failure === "verification") {
        expect(logs).toContain("global install verify");
        expect(logs).toContain("unexpected packaged dist file dist/stale-runtime.js");
      } else if (failure === "lifecycle") {
        expect(logs).toContain("npm package preinstall");
        expect(logs).toContain("staged lifecycle failed");
      } else {
        expect(logs).toContain("global install swap");
        expect(logs).toContain("staged shim copy failed");
      }
      if (failure !== "verification") {
        await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old shim\n");
      }
      expect(freshRestartCalls()).toEqual([]);
      expect(serviceStop).toHaveBeenCalledTimes(failure === "shim swap" ? 1 : 0);
      expect(logs).not.toContain(
        "Recovered managed gateway service and verified readiness after failed update.",
      );
      expectNoSideEffects(serviceStart, serviceRestart);
    },
  );

  it("completes a suppressed npm lifecycle before activating the staged package", async () => {
    const tempDir = tempDirs.make("openclaw-update-staged-lifecycle-");
    const prefix = path.join(tempDir, "prefix");
    const nodeModules = path.join(prefix, "lib", "node_modules");
    const { pkgRoot } = await setupInstalledPackageAtNodeModules(nodeModules, "2026.7.1");
    readPackageVersion.mockImplementation(async (packageRoot: string) =>
      (await fs.readFile(path.join(packageRoot, "package.json"), "utf-8")).includes("2026.8.1")
        ? "2026.8.1"
        : "2026.7.1",
    );
    primeNpmChannelTag("latest", "2026.8.1");
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
      path.join(pkgRoot, "dist", "index.js"),
    );
    runPostCorePluginConvergenceSpy.mockResolvedValueOnce(postCoreConvergenceResult());
    vi.mocked(runExec).mockResolvedValue({ stdout: "", stderr: "" });
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
        const stagePrefix = requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
        const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
        await writeOpenClawPackageFixture(stageRoot, "2026.8.1", {
          entrySource: "export {};\n",
          inventory: true,
        });
        await fs.writeFile(
          path.join(stageRoot, LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH),
          "pending\n",
        );
      }
      if (
        argv[0] === process.execPath &&
        argv[1]?.endsWith("preinstall-package-manager-warning.mjs")
      ) {
        await fs.rm(
          path.join(path.dirname(path.dirname(argv[1])), "dist", "openclaw-install-guard"),
        );
      }
      return undefined;
    });

    await updateCommand({ yes: true, restart: false, json: true });

    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(lastWriteJsonCall()).toMatchObject({ status: "ok", after: { version: "2026.8.1" } });
    expect(
      commandCalls()
        .filter(([argv]) => argv[0] === process.execPath && argv[1]?.includes("/scripts/"))
        .map(([argv]) => path.basename(requireValue(argv[1], "lifecycle script"))),
    ).toEqual(["preinstall-package-manager-warning.mjs", "postinstall-bundled-plugins.mjs"]);
    await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf-8")).resolves.toContain(
      '"version":"2026.8.1"',
    );
    await expect(
      fs.access(path.join(pkgRoot, LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs old package doctors without fix mode when the service belongs to another install", async () => {
    const tempDir = tempDirs.make("openclaw-update-package-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir, "2026.4.20");
    const foreignRoot = createCaseDir("old-doctor-foreign");
    const foreignEntry = await writeOpenClawPackageFixture(foreignRoot, "1.0.0", {
      entrySource: "export {};\n",
      git: true,
    });
    await fs.mkdir(path.join(foreignRoot, "src"));
    await fs.mkdir(path.join(foreignRoot, "extensions"));
    primeServiceCommand(["node", foreignEntry, "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    readPackageVersion.mockImplementation(
      async (packageRoot: string) =>
        (
          JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
            version: string;
          }
        ).version,
    );
    primeNpmChannelTag("latest", "2026.4.21");
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      await updateCommand({ yes: true });
    });

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

  it("retains the exact package and launchers for explicit rollback after managed Doctor fails", async () => {
    const tempDir = tempDirs.make("openclaw-update-managed-backup-");
    const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
      path.join(tempDir, "lib", "node_modules"),
    );
    const candidateVersion = "2026.5.14";
    const packageEntry = path.join(pkgRoot, "dist", "index.js");
    const launcherDir = path.join(tempDir, "bin");
    const launcherNames = ["openclaw", "openclaw.cmd", "openclaw.ps1"];
    await fs.writeFile(packageEntry, "old package entry\n", "utf8");
    await fs.mkdir(launcherDir, { recursive: true });
    await Promise.all(
      launcherNames.map((name) =>
        fs.writeFile(path.join(launcherDir, name), `old ${name}\n`, "utf8"),
      ),
    );
    const originalPackageIdentity = await fs.stat(pkgRoot);
    const callerConfig = path.join(tempDir, "caller.json");
    const managedConfig = path.join(tempDir, "managed.json");
    const callerBytes = '{"gateway":{"mode":"local"},"env":{"vars":{"CANARY":"caller"}}}\n';
    const managedBytes = '{"gateway":{"mode":"local"},"env":{"vars":{"CANARY":"managed"}}}\n';
    const existingCallerBackup = "synthetic-previous-caller-backup\n";
    await fs.writeFile(callerConfig, callerBytes);
    await fs.writeFile(`${callerConfig}.pre-update`, existingCallerBackup);
    await fs.writeFile(managedConfig, managedBytes);
    const { createPreUpdateConfigSnapshot } = await vi.importActual<
      typeof import("../config/backup-rotation.js")
    >("../config/backup-rotation.js");
    createPreUpdateConfigSnapshotMock.mockImplementation(createPreUpdateConfigSnapshot);
    mockFileBackedPathExists();
    readPackageVersion.mockImplementation(async (packageRoot: string) => {
      const manifest = JSON.parse(
        await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
      ) as { version?: string };
      return manifest.version ?? null;
    });
    let backupAtDoctorEntry: string | undefined;
    let doctorStarted = false;
    mockNpmGlobalCommands(nodeModules, async (argv, options) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
        const stagePrefix = requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
        const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
        await writeOpenClawPackageFixture(stageRoot, candidateVersion, {
          entrySource: "candidate package entry\n",
          inventory: true,
        });
        const stagedLauncherDir = path.join(stagePrefix, "bin");
        await fs.mkdir(stagedLauncherDir, { recursive: true });
        await Promise.all(
          launcherNames.map((name) =>
            fs.writeFile(path.join(stagedLauncherDir, name), `candidate ${name}\n`, "utf8"),
          ),
        );
      }
      if (argv[1] !== entryPath || argv[2] !== "doctor") {
        return undefined;
      }
      doctorStarted = true;
      await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf8")).resolves.toContain(
        `"version":"${candidateVersion}"`,
      );
      await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("candidate package entry\n");
      for (const name of launcherNames) {
        await expect(fs.readFile(path.join(launcherDir, name), "utf8")).resolves.toBe(
          `candidate ${name}\n`,
        );
      }
      const doctorEnv = typeof options === "number" ? undefined : options.env;
      expect(doctorEnv?.OPENCLAW_CONFIG_PATH).toBe(managedConfig);
      backupAtDoctorEntry = await fs
        .readFile(`${managedConfig}.pre-update`, "utf8")
        .catch(() => undefined);
      await fs.writeFile(managedConfig, '{"gateway":{"mode":"local"}}\n');
      return commandResult({ code: 1, stderr: "Doctor failed after rewriting the managed config" });
    });
    const { runPackageInstallUpdate } = await import("./update-cli/update-command-package.js");
    let transaction: PackageUpdateTransaction | undefined;
    const result = await withEnvAsync({ OPENCLAW_CONFIG_PATH: callerConfig }, async () => {
      const packageResult = await runPackageInstallUpdate({
        root: pkgRoot,
        installKind: "package",
        tag: candidateVersion,
        timeoutMs: 30_000,
        startedAt: Date.now(),
        progress: {},
        jsonMode: true,
        managedServiceEnv: { OPENCLAW_CONFIG_PATH: managedConfig },
        validateCandidate: async () => [],
        beforeActivate: async () => {},
        onTransaction: (retained) => {
          transaction = retained;
        },
      });
      expect(process.env.OPENCLAW_CONFIG_PATH).toBe(callerConfig);
      return packageResult;
    });

    expect(doctorStarted).toBe(true);
    expect(backupAtDoctorEntry).toBe(managedBytes);
    await expect(fs.readFile(`${managedConfig}.pre-update`, "utf8")).resolves.toBe(managedBytes);
    await expect(fs.readFile(callerConfig, "utf8")).resolves.toBe(callerBytes);
    await expect(fs.readFile(`${callerConfig}.pre-update`, "utf8")).resolves.toBe(
      existingCallerBackup,
    );
    expect(result.status).toBe("error");
    expect(result.after?.version).toBe(candidateVersion);
    expect(result.recovery).toMatchObject({
      serviceRestartSafe: false,
      reason: "runtime-verification-failed",
    });
    const retained = requireValue(transaction, "retained package transaction");
    expect(
      JSON.parse(await fs.readFile(path.join(retained.backupRoot, "package.json"), "utf8")),
    ).toMatchObject({ version: "2026.4.21" });
    await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("candidate package entry\n");
    const rollback = await retained.rollback();
    expect(rollback.exitCode).toBe(0);
    await retained.complete({ activationVerified: false });
    const doctorStep = result.steps.find((step) => step.name === "openclaw doctor");
    expect(doctorStep?.exitCode).toBe(1);
    expect(doctorStep?.advisory).toBeUndefined();
    await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"2026.4.21"',
    );
    await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("old package entry\n");
    const restoredPackageIdentity = await fs.stat(pkgRoot);
    expect({ dev: restoredPackageIdentity.dev, ino: restoredPackageIdentity.ino }).toEqual({
      dev: originalPackageIdentity.dev,
      ino: originalPackageIdentity.ino,
    });
    for (const name of launcherNames) {
      await expect(fs.readFile(path.join(launcherDir, name), "utf8")).resolves.toBe(
        `old ${name}\n`,
      );
    }
    expect(
      (await fs.readdir(nodeModules)).filter((entry) =>
        [
          ".openclaw.update-stage-",
          ".openclaw.package-backup-",
          ".openclaw-package-backup-",
          ".openclaw.shim-backup-",
          ".openclaw-shim-backup-",
        ].some((prefix) => entry.startsWith(prefix)),
      ),
    ).toEqual([]);
    expectNoSideEffects(serviceStart, serviceRestart);
  });

  it("continues package post-core work for explicit post-update doctor advisories", async () => {
    const tempDir = tempDirs.make("openclaw-update-package-doctor-warning-");
    const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(
      tempDir,
      "2026.4.20",
    );
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
      if (argv[0] === "npm" && argv[1] === "i") {
        await writeNpmPackageInstall(argv, pkgRoot, "2026.4.21");
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
    const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(
      tempDir,
      "2026.4.20",
    );
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
      if (argv[0] === "npm" && argv[1] === "i") {
        await writeNpmPackageInstall(argv, pkgRoot, "2026.4.21");
      }
      return undefined;
    });

    await expect(updateCommand({ yes: true, restart: false, json: true })).rejects.toEqual(
      new ExitError(1),
    );

    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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

  it.each([
    { json: true, handoff: "1", expectedExitCode: 79 },
    { json: false, handoff: undefined, expectedExitCode: 1 },
  ])(
    "retains the Windows autostart failure outcome through outer cleanup (json=$json)",
    async ({ json, handoff, expectedExitCode }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
      resumeScheduledTaskAutoStartAfterUpdate.mockRejectedValue(new Error("task restore denied"));
      const root = await mockPackageInstallAtCaseDir("openclaw-update-autostart-restore-failure");
      mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
      mockFileBackedPathExists();
      setTty(true);
      setStdoutTty(true);
      try {
        await expect(
          withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: handoff }, () => updateCommand({ json })),
        ).rejects.toEqual(new ExitError(expectedExitCode));
        expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
        expect(triageCommand).toHaveBeenCalledTimes(json ? 0 : 1);
        const reportedFailure = json
          ? { result: lastWriteJsonCall() }
          : triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure;
        expect(reportedFailure).toMatchObject({
          result: {
            status: "error",
            reason: "windows-task-autostart-restore-failed",
            recovery: { serviceRestartSafe: false },
          },
        });
        expect(listUpdateRuns({ limit: 1 })).toMatchObject([
          { phase: "finished", status: "failed", reason: "windows-task-autostart-restore-failed" },
        ]);
      } finally {
        platformSpy.mockRestore();
      }
    },
  );

  it.each([
    "valid",
    "repaired",
    "config-change",
    "state-only",
    "live-config-change",
    "unrepaired",
    "improved",
    "unavailable",
    "aborted",
  ] as const)(
    "validates and repairs the staged candidate while the previous gateway serves (%s)",
    async (outcome) => {
      const valid = outcome === "valid";
      const succeeds = valid || outcome === "repaired";
      const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
        path.join(tempDirs.make("openclaw-update-candidate-order-"), "lib", "node_modules"),
        "1.0.0",
      );
      mockNpmGlobalRoot(nodeModules);
      mockFileBackedPathExists();
      mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
      let liveConfigPath: string | undefined;
      if (outcome === "live-config-change") {
        liveConfigPath = path.join(tempDirs.make("openclaw-update-live-config-"), "openclaw.json");
        await fs.writeFile(liveConfigPath, "{}\n");
        vi.mocked(readConfigFileSnapshot).mockImplementation(async () => {
          const configPath = requireValue(liveConfigPath, "live config path");
          const raw = await fs.readFile(configPath, "utf8");
          return configSnapshot(JSON.parse(raw) as OpenClawConfig, {
            path: configPath,
            raw,
            hash: createHash("sha256").update(raw).digest("hex"),
          });
        });
      }
      const events: string[] = [];
      spawn.mockImplementationOnce((_node, _argv, options: { env: NodeJS.ProcessEnv }) => {
        const resultPath = options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
        if (!resultPath) {
          throw new Error("post-core result path missing");
        }
        const childResultPath = `${resultPath}.child`;
        const child = new EventEmitter();
        queueMicrotask(() => {
          void withEnvAsync(
            {
              OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
              ...options.env,
              OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: childResultPath,
            },
            async () => {
              const { resumePostCoreUpdate } =
                await import("./update-cli/update-command-resume.js");
              await resumePostCoreUpdate({
                root: pkgRoot,
                channel: "stable",
                opts: { yes: true, json: true },
                timeoutMs: 30_000,
              });
            },
          )
            .then(async () => {
              // Real child environments cannot overlap the parent. Restore this
              // emulated child before its result lets the parent resume.
              await fs.rename(childResultPath, resultPath);
              child.emit("exit", 0, null);
            })
            .catch((error: unknown) => child.emit("error", error));
        });
        return child;
      });
      let repairApplied = false;
      let candidateRoot: string | undefined;
      let rehearsalStateDir: string | undefined;
      unattendedRepair.mockImplementationOnce(async (repair) => {
        events.push("repair");
        expectNoSideEffects(serviceStop, serviceStart, serviceRestart, runRestartScript);
        expect(repair.target.installRoot).toBe(pkgRoot);
        expect(repair.target.candidateRoot).toBe(candidateRoot);
        expect(repair.target.stateDir).not.toBe(resolveStateDir());
        rehearsalStateDir = repair.target.stateDir;
        expect(repair.target.environment).toMatchObject({
          OPENCLAW_STATE_DIR: repair.target.stateDir,
          OPENCLAW_CONFIG_PATH: repair.target.configPath,
          OPENCLAW_WORKSPACE_DIR: repair.target.workspaceDir,
        });
        expect(repair.context.phase).toBe("validating");
        expect(repair.context).toMatchObject({ result: { reason: "runtime-verification-failed" } });
        repair.onEvent?.({
          type: "turn-started",
          turn: 1,
          provider: "openai",
          model: "gpt-5.6-luna",
        });
        repairApplied =
          outcome === "repaired" ||
          outcome === "config-change" ||
          outcome === "state-only" ||
          outcome === "live-config-change";
        if (outcome === "config-change") {
          const config = JSON.parse(
            await fs.readFile(repair.target.configPath, "utf8"),
          ) as OpenClawConfig;
          config.logging = { ...config.logging, level: "debug" };
          await fs.writeFile(repair.target.configPath, JSON.stringify(config));
        }
        if (outcome === "live-config-change") {
          await fs.writeFile(
            requireValue(liveConfigPath, "live config path"),
            JSON.stringify({ logging: { level: "debug" } }),
          );
        }
        const validation = await repair.validate(new AbortController().signal);
        repair.onEvent?.({ type: "validation", turn: 1, validation });
        if (outcome === "live-config-change") {
          expect(validation).toMatchObject({ ok: true });
          expect(validation.stopReason).toBeUndefined();
        }
        const attempt = {
          turn: 1,
          provider: "openai",
          model: "gpt-5.6-luna",
          durationMs: 1,
          toolCalls: 1,
          summary: "Checked the candidate.",
          validation,
        };
        repair.onEvent?.({ type: "turn-finished", ...attempt });
        const repairStatus =
          outcome === "valid" || outcome === "state-only" || outcome === "live-config-change"
            ? "repaired"
            : outcome === "config-change"
              ? "unrepaired"
              : outcome;
        const reason = validation.stopReason;
        repair.onEvent?.({ type: "stopped", status: repairStatus, reason });
        return { status: repairStatus, attempts: [attempt], finalValidation: validation, reason };
      });
      candidateValidation.mockImplementation(async (options) => {
        const { root } = options;
        if (options.rehearsal) {
          expect(options.rehearsal.stateDir).toBe(rehearsalStateDir);
        }
        const candidateReady =
          valid || (repairApplied && (outcome !== "state-only" || Boolean(options.rehearsal)));
        candidateRoot = root;
        events.push("validate");
        expect(serviceStop).not.toHaveBeenCalled();
        expect(await serviceReadRuntime()).toMatchObject({ status: "running" });
        expect(root).not.toBe(pkgRoot);
        expect(
          JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
        ).toMatchObject({
          version: "9999.0.0",
        });
        expect(
          JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
        ).toMatchObject({
          version: "1.0.0",
        });
        return reportCandidateSteps(options, {
          status: candidateReady ? "ok" : "error",
          durationMs: 1,
          logTail: ["candidate readiness failed"],
          reason: "runtime-verification-failed",
          candidateSchemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
          steps: [
            {
              name: "candidate gateway canary",
              command: "openclaw gateway",
              cwd: root,
              durationMs: 1,
              exitCode: candidateReady ? 0 : 1,
              ...(!valid ? { stderrTail: "candidate readiness failed" } : {}),
            },
          ],
        });
      });
      serviceStop.mockImplementationOnce(async () => {
        events.push("stop");
        expect(
          JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
        ).toMatchObject({
          version: "1.0.0",
        });
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      });
      syncPluginsForUpdateChannel.mockImplementationOnce(async ({ config }) => {
        events.push("plugins");
        expect(await serviceReadRuntime()).toMatchObject({ status: "running" });
        return pluginSyncResult(config);
      });

      if (succeeds) {
        await updateCommand({ yes: true, json: true }).catch((cause: unknown) => {
          throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, { cause });
        });
        expect(events).toEqual(
          valid
            ? ["validate", "stop", "plugins"]
            : ["validate", "repair", "validate", "validate", "stop", "plugins"],
        );
        expect(spawn).toHaveBeenCalledOnce();
        expect(runExec).toHaveBeenCalledWith(
          expect.any(String),
          [entryPath, "config", "validate", "--json"],
          expect.objectContaining({ env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" } }),
        );
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        const result = lastWriteJsonCall() as UpdateRunResult;
        expect(result.status).toBe("ok");
        expect(getUpdateRun(requireValue(result.runId, "updated run id"))).toMatchObject({
          status: "succeeded",
          downtimeMs: expect.any(Number),
          verification: { readyz: true, serviceRunning: true, inferenceProbe: "passed" },
        });
      } else {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
        expect(events).toEqual(
          outcome === "state-only" || outcome === "live-config-change"
            ? ["validate", "repair", "validate", "validate"]
            : ["validate", "repair", "validate"],
        );
        expectNoSideEffects(serviceStop, serviceStart, serviceRestart, runRestartScript);
        expect(
          JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
        ).toMatchObject({
          version: "1.0.0",
        });
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason:
            outcome === "config-change"
              ? "repair-requires-config-change"
              : outcome === "live-config-change"
                ? "invalid-config"
                : "runtime-verification-failed",
        });
        await expect(
          fs.access(requireValue(candidateRoot, "candidate root")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      const result = lastWriteJsonCall() as UpdateRunResult;
      const record = getUpdateRun(requireValue(result.runId, "run id"));
      if (!valid) {
        expect(unattendedRepair).toHaveBeenCalledOnce();
        expect(record?.steps).toContainEqual(
          expect.objectContaining({ step: "repairing", status: succeeds ? "completed" : "failed" }),
        );
        expect(record?.repair).toContainEqual(
          expect.objectContaining({
            attempt: 1,
            summary: expect.stringContaining("openai/gpt-5.6-luna"),
          }),
        );
        if (outcome === "config-change") {
          expect(record?.repair[0]).toMatchObject({ reason: "repair-requires-config-change" });
          expect(record?.steps).toContainEqual(
            expect.objectContaining({
              step: "repairing",
              detail: expect.stringContaining("logging"),
            }),
          );
        }
        if (outcome === "live-config-change") {
          expect(record?.repair[0]).toMatchObject({ status: "succeeded" });
          expect(record?.reason).toBe("invalid-config");
          expect(spawn).not.toHaveBeenCalled();
          expect(
            JSON.parse(await fs.readFile(requireValue(liveConfigPath, "live config path"), "utf8")),
          ).toEqual({
            logging: { level: "debug" },
          });
        }
      } else {
        expect(unattendedRepair).not.toHaveBeenCalled();
      }
    },
  );

  it("refuses activation when successful Doctor leaves the validated candidate schema unapplied", async () => {
    const root = await mockPackageInstallAtCaseDir("openclaw-update-incomplete-migration");
    mockFileBackedPathExists();
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
      path.join(root, "dist", "index.js"),
    );
    candidateValidation.mockImplementationOnce(async (options) =>
      reportCandidateSteps(options, {
        status: "ok",
        candidateSchemaVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION + 1,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        steps: [
          {
            name: "candidate gateway canary",
            command: "openclaw gateway",
            cwd: root,
            durationMs: 1,
            exitCode: 0,
          },
        ],
      }),
    );

    await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

    expect(doctorCommandCall()).toBeDefined();
    expectNoSideEffects(serviceStart, serviceRestart, runRestartScript, runDaemonRestart);
    expect(freshRestartCalls()).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "openclaw doctor",
      steps: expect.arrayContaining([
        expect.objectContaining({
          exitCode: 1,
          stderrTail: expect.stringContaining(String(OPENCLAW_STATE_SCHEMA_VERSION + 1)),
        }),
      ]),
    });
  });

  it("stages and validates before suspending and stopping a running managed gateway", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const processOnSpy = vi.spyOn(process, "on");
    const processOffSpy = vi.spyOn(process, "off");
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
    const root = await mockPackageInstallAtCaseDir("openclaw-update-stop-service");
    vi.mocked(resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockResolvedValue(path.join(root, "dist", "index.js"));
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    serviceDefinitionMutationCapability.mockResolvedValue({ kind: "sealed", detail: "fixture" });
    mockFileBackedPathExists();

    await updateCommand({ yes: true }).catch((cause: unknown) => {
      throw new Error(`${getErrorOutput()}\n${getLogOutput()}`, { cause });
    });
    platformSpy.mockRestore();

    const doctorCall = doctorCommandCall();
    expect(doctorCall).toBeDefined();
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION,
    ).toBe("0");
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
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
      expect.objectContaining({ beforeMutation: expect.any(Function) }),
    );
    expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      }),
      expect.objectContaining({ beforeMutation: expect.any(Function) }),
    );
    expect(sigintListenerOrder).toBeLessThan(suspendOrder);
    expect(suspendOrder).toBeLessThan(requiredServiceStopCallOrder);
    const validationOrder = requireValue(
      candidateValidation.mock.invocationCallOrder[0],
      "candidate validation order",
    );
    expect(requiredNpmInstallCallOrder).toBeLessThan(validationOrder);
    expect(validationOrder).toBeLessThan(suspendOrder);
    expect(requiredServiceStopCallOrder).toBeLessThan(resumeOrder);
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
          expect(packageInstallCommandCall()).toBeDefined();
          expect(candidateValidation).toHaveBeenCalledOnce();
          expect(
            JSON.parse(
              await fs.readFile(path.join(nodeModules, "openclaw", "package.json"), "utf8"),
            ),
          ).toMatchObject({
            version: "2026.4.21",
          });
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

  it("leaves an enabled LaunchAgent untouched when staged installation fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const tempDir = tempDirs.make("openclaw-update-stopped-launchagent-failure-");
    const { nodeModules, entryPath } = await setupInstalledPackageAtNodeModules(
      path.join(tempDir, "lib", "node_modules"),
    );
    const nodeRunner = path.join(tempDir, "bin", "node");
    primeServiceCommand([nodeRunner, entryPath, "gateway", "run"], {
      OPENCLAW_STATE_DIR: profileStateDir(),
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        throw new Error("package replacement failed");
      }
    });

    try {
      await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19999" }, async () => {
        await expect(updateCommand({ yes: true, timeout: "17" })).rejects.toEqual(new ExitError(1));
      });
    } finally {
      platformSpy.mockRestore();
    }

    expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toEqual([]);

    const packageInstallCallIndex = commandCalls().findIndex(
      ([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g",
    );
    expect(commandCalls()[packageInstallCallIndex]?.[0]).toContain("--prefix");
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
      await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));
    } finally {
      platformSpy.mockRestore();
    }

    expectNoSideEffects(
      serviceStart,
      serviceStop,
      serviceRestart,
      runDaemonInstall,
      runDaemonRestart,
    );
    expect(freshRestartCalls()).toHaveLength(0);
  });

  it.each([
    { json: true, handoff: "1", expectedExitCode: 79 },
    { json: false, handoff: undefined, expectedExitCode: 1 },
  ])(
    "leaves the stopped Gateway down when Git mutation throws without a recovery verdict (json=$json)",
    async ({ json, handoff, expectedExitCode }) => {
      mockRunningManagedGateway([
        "node",
        path.join(process.cwd(), "dist", "index.js"),
        "gateway",
        "run",
      ]);
      setTty(true);
      setStdoutTty(true);
      const cause = new Error("ENOSPC while replacing runtime files");
      const failure = new Error(
        `updater interrupted after mutation: ${"replacement verification detail; ".repeat(12)}`,
        { cause },
      );
      vi.mocked(runGatewayUpdate).mockImplementationOnce(async (opts) => {
        await opts?.beforeGitMutation?.({});
        throw failure;
      });

      await expect(
        withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: handoff }, () => updateCommand({ json })),
      ).rejects.toEqual(new ExitError(expectedExitCode));
      expect(serviceStop).toHaveBeenCalledOnce();
      expect(freshRestartCalls()).toHaveLength(0);
      expectNoSideEffects(serviceStart, serviceRestart);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(triageCommand).toHaveBeenCalledTimes(json ? 0 : 1);
      const reportedFailure = json
        ? { result: lastWriteJsonCall() }
        : triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure;
      expect(reportedFailure).toMatchObject({
        result: {
          status: "error",
          mode: "git",
          reason: "update-failed",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          steps: [
            expect.objectContaining({ exitCode: 1, stderrTail: formatErrorMessage(failure) }),
          ],
        },
      });
      if (!json) {
        const recovery = expectDefined(
          triageCommand.mock.calls[0]?.[1]?.recovery,
          "captured failed-update recovery",
        );
        const diagnostic = sanitizeTriageUpdateFailure(recovery.updateFailure, {
          env: {},
          stateDir: profileStateDir(),
        });
        expect(diagnostic).toMatchObject({
          error: expect.stringContaining("updater interrupted after mutation"),
        });
        expect(diagnostic.error).toContain(cause.message);
      }
    },
  );

  it.each([
    { name: "update", run: updateCommand },
    { name: "repair", run: updateFinalizeCommand },
  ])("$name pins relative installation selectors before failed-update triage", async ({ run }) => {
    const failure = new Error("Config snapshot failed");
    vi.mocked(readConfigFileSnapshot).mockRejectedValueOnce(failure);
    const cwd = process.cwd();
    const selectors = {
      OPENCLAW_STATE_DIR: path.relative(cwd, profileStateDir()),
      OPENCLAW_CONFIG_PATH: path.relative(cwd, path.join(profileStateDir(), "custom.json")),
      OPENCLAW_WORKSPACE_DIR: "relative-workspace",
    };
    await withEnvAsync(selectors, async () => {
      await expect(run({ yes: true, json: true, restart: false })).rejects.toBe(failure);
      expect(runUpdateFailureTriage).toHaveBeenCalledOnce();
      const triageCall = vi.mocked(runUpdateFailureTriage).mock.calls[0]?.[0];
      expect(triageCall?.failure).toEqual({ error: failure.message });
      for (const [key, value] of Object.entries(selectors)) {
        expect(triageCall?.target.env[key], key).toBe(path.resolve(cwd, value));
        expect(process.env[key]).toBe(value);
      }
      expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
    });
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
            await expect(invokeUpdateCli({ yes: true })).rejects.toEqual(new ExitError(1));
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
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(getLogOutput()).toContain(envKey);
    },
  );

  it("restores Windows Scheduled Task autostart when service stop fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const root = await mockPackageInstallAtCaseDir("openclaw-update-stop-failure");
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    serviceStop.mockRejectedValueOnce(new Error("stop failed"));
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);

    await expect(invokeUpdateCli({ yes: true })).rejects.toEqual(new ExitError(1));
    platformSpy.mockRestore();

    expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledTimes(1);
    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledTimes(1);
    expect(packageInstallCommandCall()).toBeDefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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

  it.each([
    { command: "update", fault: "stop" },
    { command: "doctor", fault: "stop" },
    { command: "update", fault: "stop-enable-committed" },
    { command: "doctor", fault: "stop-enable-committed" },
    { command: "update", fault: "suspension" },
    { command: "doctor", fault: "suspension" },
    { command: "update", fault: "suspension-spawn" },
    { command: "doctor", fault: "suspension-spawn" },
  ] as const)(
    "starts $command triage when native $fault preparation cannot restore task autostart",
    async ({ command, fault }) => {
      const stopFailure = fault === "stop" || fault === "stop-enable-committed";
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      setTty(true);
      setStdoutTty(true);
      const root = await mockPackageInstallAtCaseDir("openclaw-update-native-preparation");
      mockRunningManagedGateway([
        process.execPath,
        path.join(root, "dist", "entry.js"),
        "gateway",
        "run",
      ]);
      mockFileBackedPathExists();
      const target = {
        stateDir: profileStateDir("native-preparation"),
        configPath: path.join(profileStateDir("native-preparation"), "openclaw.json"),
        defaultWorkspaceDir: path.join(profileStateDir("native-preparation"), "workspace"),
      };
      tempDirsToCleanup.add(target.stateDir);
      await fs.mkdir(target.stateDir, { recursive: true });
      await writeJsonFixture(target.configPath, baseSnapshot.config);
      primeServiceCommand(
        [process.execPath, path.join(root, "dist", "entry.js"), "gateway", "run"],
        {
          OPENCLAW_PROFILE: "native-preparation",
          OPENCLAW_STATE_DIR: target.stateDir,
          OPENCLAW_CONFIG_PATH: target.configPath,
          OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
        },
      );
      const nativeTaskControl = await vi.importActual<
        typeof import("../daemon/schtasks-control.js")
      >("../daemon/schtasks-control.js");
      suspendScheduledTaskAutoStartForUpdate.mockImplementation(
        nativeTaskControl.suspendScheduledTaskAutoStartForUpdate,
      );
      resumeScheduledTaskAutoStartAfterUpdate.mockImplementation(
        nativeTaskControl.resumeScheduledTaskAutoStartAfterUpdate,
      );
      const configuredRunCommand = vi.mocked(runCommandWithTimeout).getMockImplementation();
      if (!configuredRunCommand) {
        throw new Error("Expected installed package command fixture");
      }
      let taskEnabled = true;
      const nativeCommands: string[][] = [];
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[0] === "git" && argv[3] === "rev-parse") {
          return commandResult({ stdout: `${root}\n` });
        }
        if (argv[0] !== "schtasks") {
          return await configuredRunCommand(argv, options);
        }
        nativeCommands.push([...argv]);
        if (argv[1] === "/Query") {
          return commandResult({
            stdout: `<Task><Settings><Enabled>${taskEnabled}</Enabled></Settings></Task>`,
          });
        }
        if (argv.at(-1) === "/DISABLE") {
          taskEnabled = false;
          return !stopFailure
            ? commandResult({ code: 1, stderr: "disable timed out after commit" })
            : commandResult();
        }
        if (fault === "suspension-spawn") {
          throw new Error("spawn schtasks EACCES: enable denied");
        }
        if (fault === "stop-enable-committed") {
          taskEnabled = true;
        }
        return commandResult({ code: 1, stderr: "enable denied" });
      });
      serviceStop.mockRejectedValueOnce(new Error("listener cleanup failed after task stop"));
      mockGitUpdateAfterMutation();
      const originalSignalListeners = process.listenerCount("SIGINT");
      triageCommand.mockImplementationOnce(async () => {
        expect(taskEnabled).toBe(false);
        expect(process.listenerCount("SIGINT")).toBe(originalSignalListeners);
      });
      let reportedError: unknown;
      // The native fixture uses its account HOME; the suite's relocated-home
      // marker deliberately opts Doctor out of host service management.
      await withEnvAsync({ OPENCLAW_HOME: undefined }, async () => {
        try {
          if (command === "doctor") {
            const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
            await maybeOfferUpdateBeforeDoctor({
              runtime: defaultRuntime,
              options: {},
              root,
              confirm: async () => true,
              outro: vi.fn(),
            });
          } else {
            await updateCommand({});
          }
        } catch (error) {
          reportedError = error;
        }
      });

      expect(
        nativeCommands.map((argv) => argv.at(-1)),
        `${String(reportedError)}\n${getErrorOutput()}`,
      ).toEqual([
        "/XML",
        "/DISABLE",
        "/ENABLE",
        ...(stopFailure ? ["/XML"] : []),
        ...(fault === "stop-enable-committed" ? ["/DISABLE"] : []),
      ]);
      expect(serviceStop).toHaveBeenCalledTimes(stopFailure ? 1 : 0);
      expect(packageInstallCommandCall() !== undefined).toBe(command === "update");
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "1.0.0",
      });
      expect(serviceRestart).not.toHaveBeenCalled();
      expect(triageCommand).toHaveBeenCalledOnce();
      expect(reportedError).toEqual(new ExitError(1));
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(triageCommand.mock.calls[0]?.[1]?.recovery).toMatchObject({
        target,
        updateFailure: {
          result: {
            status: "error",
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
            steps: [
              expect.objectContaining({ stderrTail: expect.stringContaining("enable denied") }),
            ],
          },
        },
      });
    },
  );

  it.each([
    "verification",
    "enable-committed",
    "disable-committed",
    "disable-denied",
    "none",
  ] as const)(
    "settles native Windows task enabled state after update finalization (%s)",
    async (fault) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const root = process.cwd();
      mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway"]);
      prepareRestartScript.mockResolvedValue(null);
      mockGitUpdateAfterMutation(
        makeOkUpdateResult({
          mode: "git",
          root,
          after: { version: "1.0.0", buildId: "candidate-build" },
        }),
      );
      restartHealthTestControl.snapshot = {
        runtime: { status: "running", pid: gatewayFixturePid },
        portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
        healthy: fault === "none",
        staleGatewayPids: [],
        gatewayVersion: "1.0.0",
        gatewayBuildId: "candidate-build",
        expectedVersion: "1.0.0",
        probeError: fault === "none" ? undefined : "candidate readiness failed",
      };
      const nativeTaskControl = await vi.importActual<
        typeof import("../daemon/schtasks-control.js")
      >("../daemon/schtasks-control.js");
      suspendScheduledTaskAutoStartForUpdate.mockImplementation(
        nativeTaskControl.suspendScheduledTaskAutoStartForUpdate,
      );
      resumeScheduledTaskAutoStartAfterUpdate.mockImplementation(
        nativeTaskControl.resumeScheduledTaskAutoStartAfterUpdate,
      );
      const configuredRunCommand = requireValue(
        vi.mocked(runCommandWithTimeout).getMockImplementation(),
        "native update command fixture",
      );
      let taskEnabled = true;
      let disables = 0;
      const nativeActions: string[] = [];
      const activateTask = () => {
        nativeActions.push("/Run");
        if (!taskEnabled) {
          throw new Error("Scheduled Task is disabled");
        }
      };
      serviceRestart.mockImplementation(async () => {
        activateTask();
        return { outcome: "completed" };
      });
      vi.mocked(runDaemonRestart).mockImplementation(async () => {
        activateTask();
        return true;
      });
      vi.mocked(runDaemonInstall).mockImplementation(async () => {
        activateTask();
      });
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[0] !== "schtasks") {
          if (argv[2] === "gateway" && ["install", "start", "restart"].includes(argv[3] ?? "")) {
            activateTask();
          }
          return configuredRunCommand(argv, options);
        }
        const action = argv.at(-1);
        if (argv[1] === "/Query") {
          return commandResult({
            stdout: `<Task><Settings><Enabled>${taskEnabled}</Enabled></Settings></Task>`,
          });
        }
        nativeActions.push(action ?? "");
        if (action === "/DISABLE") {
          disables += 1;
          if (disables > 1 && fault === "disable-denied") {
            return commandResult({ code: 1, stderr: "suspension denied" });
          }
          taskEnabled = false;
          return disables > 1 && fault === "disable-committed"
            ? commandResult({ code: 124, stderr: "disable timed out after commit" })
            : commandResult();
        }
        taskEnabled = true;
        return fault === "enable-committed"
          ? commandResult({ code: 124, stderr: "enable timed out after commit" })
          : commandResult();
      });

      if (fault === "none") {
        await updateCommand({ yes: true, json: true });
        expect(nativeActions).toEqual(["/DISABLE", "/ENABLE", "/Run"]);
      } else {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
        expect(disables).toBe(2);
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason:
            fault === "enable-committed"
              ? "windows-task-autostart-restore-failed"
              : "restart-unhealthy",
        });
        if (fault === "disable-committed" || fault === "disable-denied") {
          expect(lastWriteJsonCall()).toMatchObject({
            steps: expect.arrayContaining([
              expect.objectContaining({
                stderrTail: expect.stringContaining(
                  fault === "disable-committed"
                    ? "disable timed out after commit"
                    : "suspension denied",
                ),
              }),
            ]),
          });
        }
      }
      expect(taskEnabled).toBe(fault === "none" || fault === "disable-denied");
      expect(nativeActions.slice(0, 2)).toEqual(["/DISABLE", "/ENABLE"]);
      if (fault === "enable-committed") {
        expect(nativeActions).not.toContain("/Run");
      }
    },
  );

  it("keeps Windows Scheduled Task autostart disabled after unverified lifecycle failure", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const root = await mockPackageInstallAtCaseDir("openclaw-update-recovery-failure");
    primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    });
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "staged package commands",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      if (argv[2] === "doctor") {
        await fs.unlink(path.join(root, "dist", "index.js"));
        throw new Error("update invariant broke");
      }
      return runFixtureCommand(argv, options);
    });

    try {
      await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledOnce();
      expect(packageInstallCommandCall()).toBeDefined();
      expect(resumeScheduledTaskAutoStartAfterUpdate.mock.calls.length).toBe(0);
      await expect(fs.access(path.join(root, "dist", "index.js"))).resolves.toBeUndefined();
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "1.0.0",
      });
      expect(serviceRestart).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not re-enable Windows task autostart on interruption during package lifecycle", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const processOnSpy = vi.spyOn(process, "on");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const root = await mockPackageInstallAtCaseDir("openclaw-update-lifecycle-signal");
    primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    });
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "staged package commands",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      if (argv[2] === "doctor") {
        const listener = processOnSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
        if (typeof listener !== "function") {
          throw new Error("missing signal handler");
        }
        listener();
        throw new Error("interrupted lifecycle");
      }
      return runFixtureCommand(argv, options);
    });
    try {
      await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
      await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledWith(130));
      expect(resumeScheduledTaskAutoStartAfterUpdate.mock.calls.length).toBe(0);
      await expect(fs.access(path.join(root, "dist", "index.js"))).resolves.toBeUndefined();
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "1.0.0",
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(listUpdateRuns({ limit: 1 })).toMatchObject([
        {
          phase: "finished",
          status: "failed",
          reason: "runtime-verification-failed",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "post-install verification",
              status: "failed",
              detail: expect.stringContaining("interrupted lifecycle"),
            }),
          ]),
        },
      ]);
    } finally {
      platformSpy.mockRestore();
      processOnSpy.mockRestore();
      processExitSpy.mockRestore();
    }
  });

  it.each(["interrupted", "settling", "completed"] as const)(
    "refuses mutation through a %s Windows task recovery owner",
    async (outcome) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const processOnSpy = vi.spyOn(process, "on");
      const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const { maybeStopManagedServiceBeforeMutableUpdate, UpdateCommandAbort } =
        await import("./update-cli/update-command-service.js");
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
      suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
      resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
      const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
      });
      const recovery = requireValue(stopped.windowsTaskAutoStartRecovery, "task recovery owner");
      try {
        if (outcome === "interrupted") {
          const listener = processOnSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
          if (typeof listener !== "function") {
            throw new Error("missing task recovery signal handler");
          }
          listener();
        } else {
          await recovery.restore();
          const completion = recovery.complete();
          if (outcome === "completed") {
            await completion;
          }
        }
        expect(() => recovery.beginMutation()).toThrow(UpdateCommandAbort);
      } finally {
        await recovery.restore();
        await recovery.complete();
        if (outcome === "interrupted") {
          await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledWith(130));
        }
        platformSpy.mockRestore();
        processOnSpy.mockRestore();
        processExitSpy.mockRestore();
      }
      expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it.each([
    { verified: true, compensationFails: false },
    { verified: false, compensationFails: false },
    { verified: false, compensationFails: true },
  ])(
    "settles restored Windows autostart after verification=$verified (compensation failure=$compensationFails)",
    async ({ verified, compensationFails }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
      const nativeTaskControl = await vi.importActual<
        typeof import("../daemon/schtasks-control.js")
      >("../daemon/schtasks-control.js");
      suspendScheduledTaskAutoStartForUpdate.mockImplementation(
        nativeTaskControl.suspendScheduledTaskAutoStartForUpdate,
      );
      resumeScheduledTaskAutoStartAfterUpdate.mockImplementation(
        nativeTaskControl.resumeScheduledTaskAutoStartAfterUpdate,
      );
      const runFixture = requireValue(
        vi.mocked(runCommandWithTimeout).getMockImplementation(),
        "managed task command fixture",
      );
      let enabled = true;
      const mutations: string[] = [];
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[0] !== "schtasks") {
          return await runFixture(argv, options);
        }
        if (argv[1] === "/Query") {
          return commandResult({
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
          });
        }
        const action = argv.at(-1)!;
        mutations.push(action);
        enabled = action === "/ENABLE";
        return compensationFails && mutations.length === 3
          ? commandResult({ code: 124, stderr: "disable timed out after commit" })
          : commandResult();
      });
      const {
        maybeStopManagedServiceBeforeMutableUpdate,
        maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
      } = await import("./update-cli/update-command-service.js");
      const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
      });
      const recovery = requireValue(stopped.windowsTaskAutoStartRecovery, "task suspension");
      try {
        recovery.beginMutation();
        await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(stopped, true);
        expect(enabled).toBe(true);
        expect(stopped.windowsTaskAutoStartRecovery).toBe(recovery);
        if (compensationFails) {
          await expect(recovery.complete(verified)).rejects.toThrow(
            "disable timed out after commit",
          );
        } else {
          await recovery.complete(verified);
        }
        expect(enabled).toBe(verified);
        await recovery.complete();
        await recovery.restore(true);
        expect(mutations).toEqual(
          verified ? ["/DISABLE", "/ENABLE"] : ["/DISABLE", "/ENABLE", "/DISABLE"],
        );
      } finally {
        await recovery.complete(false);
      }
    },
  );

  it("does not restore autostart on a pinned Windows task replaced during service stop", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
    const { maybeStopManagedServiceBeforeMutableUpdate } =
      await import("./update-cli/update-command-service.js");
    const params = {
      root: process.cwd(),
      updateInstallKind: "package" as const,
      shouldRestart: true,
      jsonMode: true,
    };
    const expectedService = await maybeStopManagedServiceBeforeMutableUpdate({
      ...params,
      phase: "inspect",
    });
    if (expectedService.serviceUpdateVerdict?.kind !== "owned") {
      throw new Error("expected owned fixture launcher");
    }
    expectedService.serviceUpdateVerdict.refreshDefinition = false;
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    const nativeTaskControl = await vi.importActual<typeof import("../daemon/schtasks-control.js")>(
      "../daemon/schtasks-control.js",
    );
    resumeScheduledTaskAutoStartAfterUpdate.mockImplementation(
      nativeTaskControl.resumeScheduledTaskAutoStartAfterUpdate,
    );
    serviceStop.mockImplementationOnce(async () => {
      primeServiceCommand(["node", "/another-install/openclaw.mjs", "gateway", "run"]);
      throw new Error("stop failed after task replacement");
    });
    try {
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({ ...params, expectedService }),
      ).rejects.toThrow("restore Windows Scheduled Task autostart");
    } finally {
      platformSpy.mockRestore();
    }
    expect(serviceStop).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(runCommandWithTimeout)
        .mock.calls.some(([argv]) => argv[0] === "schtasks" && argv.includes("/ENABLE")),
    ).toBe(false);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it.each(
    (["SIGINT", "SIGBREAK"] as const).flatMap((signal) =>
      (["package suspension", "Git schema preflight"] as const).map((phase) => ({ signal, phase })),
    ),
  )(
    "restores Windows Scheduled Task autostart on $signal during $phase",
    async ({ signal, phase }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const processOnSpy = vi.spyOn(process, "on");
      const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const gate = createDeferred();
      const entered = createDeferred();
      const gitMutation = vi.fn();
      let taskSuspended = false;
      const waitForSignal = async () => {
        entered.resolve();
        await gate.promise;
      };
      suspendScheduledTaskAutoStartForUpdate.mockImplementationOnce(async () => {
        if (phase === "package suspension") {
          await waitForSignal();
        }
        taskSuspended = true;
        return true;
      });
      if (phase === "Git schema preflight") {
        mockOwnedGitService();
        serviceLoaded.mockResolvedValue(true);
        vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
          await options?.beforeGitMutation?.({ schemaVersions: { state: 3, agent: 11 } });
          gitMutation();
          return makeOkUpdateResult({ mode: "git" });
        });
        databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(async () => {
          if (taskSuspended) {
            await waitForSignal();
          }
          return { incompatible: [], indeterminate: [] };
        });
      } else {
        const root = await mockPackageInstallAtCaseDir("openclaw-update-suspension-signal");
        primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        });
      }
      resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });

      const updatePromise = updateCommand({ yes: true, restart: false });
      try {
        await Promise.race([
          entered.promise,
          updatePromise.then(() => {
            throw new Error(`update completed before ${phase}`);
          }),
        ]);
        const signalListener = processOnSpy.mock.calls.find(([event]) => event === signal)?.[1];
        if (typeof signalListener !== "function") {
          throw new Error(`expected armed ${signal} recovery during ${phase}`);
        }
        signalListener();
        signalListener();
        expect(resumeScheduledTaskAutoStartAfterUpdate).not.toHaveBeenCalled();
        expect(gitMutation).not.toHaveBeenCalled();
        gate.resolve();

        await updatePromise;
        expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
        expect(serviceStop).not.toHaveBeenCalled();
        expect(Boolean(packageInstallCommandCall())).toBe(phase === "package suspension");
        expect(gitMutation).not.toHaveBeenCalled();
        expect(freshRestartCalls()).toEqual([]);
        expect(listUpdateRuns({ limit: 1 })).toMatchObject([
          { phase: "finished", status: "skipped", reason: "cancelled" },
        ]);
        expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
        await vi.waitFor(() => {
          expect(processExitSpy).toHaveBeenCalledTimes(2);
          expect(processExitSpy).toHaveBeenCalledWith(130);
        });
      } finally {
        gate.resolve();
        await updatePromise;
        platformSpy.mockRestore();
        processOnSpy.mockRestore();
        processExitSpy.mockRestore();
      }
    },
  );

  it.each(["running", "stopped"] as const)(
    "guards a %s Windows Scheduled Task during a no-restart package update",
    async (runtimeStatus) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(fixtureRoot);
      const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(
        createCaseDir("openclaw-update-stopped-task"),
      );
      primeNpmChannelTag("latest", "2026.4.22");
      mockFileBackedPathExists();
      readPackageVersion.mockResolvedValue("2026.4.21");
      mockNpmGlobalCommands(nodeModules, async (argv) => {
        if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
          await writeNpmPackageInstall(argv, pkgRoot, "2026.4.22");
        }
      });
      primeServiceCommand(["node", entryPath, "gateway", "run"], {
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
      expect(
        resumeScheduledTaskAutoStartAfterUpdate,
        `${getLogOutput()}\n${getErrorOutput()}`,
      ).toHaveBeenCalledOnce();
      const suspendOrder = suspendScheduledTaskAutoStartForUpdate.mock.invocationCallOrder[0];
      const installCallIndex = vi
        .mocked(runCommandWithTimeout)
        .mock.calls.findIndex(
          (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
        );
      const installOrder =
        vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[installCallIndex];
      const resumeOrder = resumeScheduledTaskAutoStartAfterUpdate.mock.invocationCallOrder[0];
      expect(requireValue(installOrder, "package staging order")).toBeLessThan(
        requireValue(suspendOrder, "Scheduled Task suspend order"),
      );
      expect(requireValue(installOrder, "package install order")).toBeLessThan(
        requireValue(resumeOrder, "Scheduled Task resume order"),
      );
    },
  );

  it.each(["running", "stopped"])(
    "does not suspend a %s foreign Windows task when offline inspection is unavailable",
    async (runtimeStatus) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const updateRoot = tempDirs.make("openclaw-update-foreign-task-");
      const foreignRoot = tempDirs.make("openclaw-update-foreign-task-owner-");
      const foreignEntrypoint = await writeOpenClawPackageFixture(foreignRoot, "2026.4.21", {
        entrySource: "export {};\n",
      });
      primeServiceCommand(["node", foreignEntrypoint, "gateway", "run"]);
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({
        status: runtimeStatus,
        state: runtimeStatus,
        ...(runtimeStatus === "running" ? { pid: gatewayFixturePid } : {}),
      });
      windowsOfflineProbe.mockRejectedValue(new Error("synthetic task inspection unavailable"));
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
          running: runtimeStatus === "running",
          offline: false,
          serviceUpdateVerdict: { kind: "foreign" },
        });
      } finally {
        windowsOfflineProbe.mockReset().mockResolvedValue(null);
        platformSpy.mockRestore();
      }

      expect(suspendScheduledTaskAutoStartForUpdate).not.toHaveBeenCalled();
      expect(resumeScheduledTaskAutoStartAfterUpdate).not.toHaveBeenCalled();
      expect(serviceStop).not.toHaveBeenCalled();
    },
  );

  it.each(["doctor failure", "post-core exception"] as const)(
    "keeps Windows Git task autostart disabled after %s",
    async (failureKind) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
      suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
      const failure = new Error("post-core configuration could not be read");
      vi.mocked(runGatewayUpdate).mockImplementationOnce(async (opts) => {
        await opts?.beforeGitMutation?.({});
        if (failureKind === "post-core exception") {
          vi.mocked(readConfigFileSnapshot).mockRejectedValue(failure);
          return makeOkUpdateResult({ mode: "git", root: process.cwd() });
        }
        return {
          status: "error",
          mode: "git",
          root: process.cwd(),
          reason: "doctor-failed",
          recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
          steps: [],
          durationMs: 100,
        };
      });

      try {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
        if (failureKind === "post-core exception") {
          expect(getTriageFailures()).toContainEqual(
            expect.objectContaining({ error: failure.message }),
          );
        }
        expect(suspendScheduledTaskAutoStartForUpdate).toHaveBeenCalledOnce();
        expect(serviceStop).toHaveBeenCalledOnce();
        expect(suspendScheduledTaskAutoStartForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
          requireValue(serviceStop.mock.invocationCallOrder[0], "Git service stop order"),
        );
        expect(resumeScheduledTaskAutoStartAfterUpdate).not.toHaveBeenCalled();
        expect(freshRestartCalls()).toHaveLength(0);
        expectNoSideEffects(serviceStart, serviceRestart);
      } finally {
        platformSpy.mockRestore();
      }
    },
  );

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
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root: process.cwd() }));

    await updateCommand({ yes: true });

    expect(serviceReadCommand).toHaveBeenCalledWith({ requireEffective: true });
  });

  it.each(["owned", "unresolved"] as const)(
    "inspects an %s service wrapper when openclaw is absent from PATH",
    async (ownership) => {
      const root = createCaseDir("openclaw-update-wrapper-install");
      const entrypoint = await writeOpenClawPackageFixture(root, "1.0.0", {
        git: true,
        entrySource: "export {};\n",
      });
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
      mockFileBackedPathExists();
      const wrapperDir =
        ownership === "owned"
          ? path.join(root, "bin")
          : createCaseDir("openclaw-update-wrapper-service");
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
      expect(
        resolveExecutablePath("openclaw", { env: serviceCommand.environment }),
      ).toBeUndefined();
      const envSnapshot = captureEnv(Object.keys(serviceCommand.environment));
      mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root }));
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);

      try {
        if (ownership === "unresolved") {
          await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));
        } else {
          await updateCommand({ yes: true });
        }
      } finally {
        envSnapshot.restore();
        const { clearConfigCache } = await import("../config/io.js");
        const { clearRuntimeConfigSnapshot } = await import("../config/runtime-snapshot.js");
        clearConfigCache();
        clearRuntimeConfigSnapshot();
      }

      if (ownership === "unresolved") {
        expect(getErrorOutput()).toContain("Gateway service installation ownership is unresolved");
        expectNoSideEffects(
          serviceStop,
          runGatewayUpdate,
          serviceStart,
          serviceRestart,
          prepareRestartScript,
          runRestartScript,
          runDaemonInstall,
          runDaemonRestart,
        );
        return;
      }
      expect(getErrorOutput()).toContain("service definition left unchanged");
      expect(serviceStop).toHaveBeenCalledTimes(1);
      expect(runGatewayUpdate).toHaveBeenCalledTimes(1);
      const restartOptions = freshRestartCalls()[0]?.[1];
      expect(typeof restartOptions === "object" && restartOptions.env?.OPENCLAW_WRAPPER).toBe(
        wrapperPath,
      );
      expect(serviceStart).not.toHaveBeenCalled();
      expectNoSideEffects(
        prepareRestartScript,
        runRestartScript,
        runDaemonInstall,
        runDaemonRestart,
      );
    },
  );

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

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectFailedManagedGitRestart(
      "Gateway responded, but the managed service did not report running after restart.",
    );
  });

  it("fails managed git restart when the stopped service cannot be restarted", async () => {
    mockStoppedManagedGitGateway();
    runRestartScript.mockRejectedValueOnce(new Error("restart unavailable"));
    mockGitUpdateAfterMutation();

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectFailedManagedGitRestart("Gateway: restart failed: Error: restart unavailable");
  });

  it("reports a refused installed restart for an already-stopped Git service", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await setupManagedGitRootRefresh();
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    prepareRestartScript.mockResolvedValue(null);
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "default command fixture",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) =>
      argv[2] === "gateway" && argv[3] === "restart"
        ? commandResult({ code: 1, stderr: "native owner refused" })
        : runFixtureCommand(argv, options),
    );

    await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

    expect(serviceStop).not.toHaveBeenCalled();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toHaveLength(1);
    expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "restart-unhealthy" });
    expect(getErrorOutput()).toContain("native owner refused");
  });

  it("stops a managed gateway rooted at the git checkout when switching package installs to dev", async () => {
    const prefix = createCaseDir("openclaw-update-package-root");
    const { nodeModules } = await setupInstalledPackageAtNodeModules(
      path.join(prefix, "lib", "node_modules"),
    );
    const gitRoot = tempDirs.make("openclaw-update-git-service-root-");
    const sha = "a".repeat(40);
    const serviceEntrypoint = await writeOpenClawPackageFixture(gitRoot, "2026.4.21", {
      entrySource: "export {};\n",
      git: true,
      builtSha: sha,
    });
    const canonicalGitRoot = await fs.realpath(gitRoot);
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, undefined, canonicalGitRoot);
    mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
    mockGitUpdateAfterMutation(
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
    mockGatewayHealth("2026.4.21", "updated-checkout");
    serviceReadCommand.mockImplementation(async () => ({
      programArguments: [
        "node",
        gatewayCommandCall(gitEntrypoint, "install") ? gitEntrypoint : packageEntrypoint,
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
      { allowGatewayServiceRepair: false, allowGatewayActivation: false },
    ]);
    expect(gatewayCommandCall(gitEntrypoint, "install")).toBeDefined();
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
      const { nodeModules } = await setupInstalledPackageAtNodeModules(
        path.join(root, "package", "lib", "node_modules"),
      );
      const targetRoot = path.join(root, "checkout-target");
      const replacementRoot = path.join(root, "checkout-replacement");
      const checkoutAlias = path.join(root, "checkout-alias");
      await Promise.all([fs.mkdir(targetRoot), fs.mkdir(replacementRoot)]);
      await fs.symlink(targetRoot, checkoutAlias, "dir");
      const publishedRoot = await fs.realpath(checkoutAlias);
      mockFileBackedPathExists();
      mockNoopPostUpdatePluginConvergence();
      const sha = "a".repeat(40);
      vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
        const stagingRoot = requireValue(options?.cwd, "staged update root");
        expect(stagingRoot).not.toBe(publishedRoot);
        await options?.inspectGitTarget?.({});
        await writeOpenClawPackageFixture(stagingRoot, "2026.8.17", {
          git: true,
          builtSha: sha,
          entrySource: "export {};\n",
        });
        await options?.prepareGitExposure?.(stagingRoot, sha, undefined);
        await options?.validateCandidate?.(stagingRoot);
        await options?.beforeGitMutation?.({});
        expect(await options?.publishGitCheckout?.()).toBe(publishedRoot);
        return makeOkUpdateResult({
          mode: "git",
          root: publishedRoot,
          after: { sha, version: "2026.8.17" },
        });
      });
      mockNpmGlobalCommands(
        nodeModules,
        async (argv) => {
          if (argv[0] === "git" && argv[1] === "clone") {
            const stagingDir = requireValue(argv.at(-1), "Git clone staging directory");
            await writeOpenClawPackageFixture(stagingDir, "2026.8.17", { git: true });
            await fs.unlink(checkoutAlias);
            await fs.symlink(replacementRoot, checkoutAlias, "dir");
          }
        },
        () =>
          requireValue(vi.mocked(runGatewayUpdate).mock.calls[0]?.[0]?.cwd, "candidate checkout"),
      );

      await withEnvAsync({ OPENCLAW_GIT_DIR: checkoutAlias }, async () => {
        await updateCommand({ channel: "dev", yes: true, restart: false }).catch(
          (error: unknown) => {
            throw new Error(getErrorOutput() + getLogOutput(), { cause: error });
          },
        );
      });

      const installCall = packageInstallCommandCall();
      const candidateRoot = requireValue(
        vi.mocked(runGatewayUpdate).mock.calls[0]?.[0]?.cwd,
        "candidate checkout",
      );
      expect(installCall?.[0]).toContain(candidateRoot);
      expect(installCall?.[0]).not.toContain(checkoutAlias);
      expect(installCall?.[1].cwd).toBe(candidateRoot);
      await expect(fs.readdir(replacementRoot)).resolves.toEqual([]);
    },
  );

  it("does not stop an unresolved service when package-to-Git staging fails", async () => {
    const root = tempDirs.make("openclaw-update-package-to-git-unsafe-");
    const packageRoot = path.join(root, ".bun", "install", "global", "node_modules", "openclaw");
    const gitRoot = path.join(root, "git-root");
    const packageEntry = await writeOpenClawPackageFixture(packageRoot, "2026.4.20", {
      entrySource: "export {};\n",
    });
    const sha = "a".repeat(40);
    await writeOpenClawPackageFixture(gitRoot, "2026.8.18", { git: true, builtSha: sha });
    mockPackageInstallStatus(packageRoot);
    resolveGlobalManager.mockResolvedValue("bun");
    mockFileBackedPathExists();
    mockRunningManagedGateway(["node", packageEntry, "gateway", "run"]);
    mockGitUpdateAfterMutation(makeOkUpdateResult({ mode: "git", root: gitRoot, after: { sha } }));
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(packageEntry);
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (argv[1] === "add" && argv[2] === "-g") {
        return commandResult({ code: 1, stderr: "candidate install failed" });
      }
      return commandResult();
    });

    await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
      await expect(updateCommand({ channel: "dev", yes: true, json: true })).rejects.toEqual(
        new ExitError(1),
      );
    });

    expect(serviceStop).not.toHaveBeenCalled();
    await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("export {};\n");
    expect(freshRestartCalls()).toEqual([]);
    expectNoSideEffects(serviceStart, serviceRestart, runRestartScript, replaceConfigFile);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each(["package", "git"])(
    "leaves the %s service untouched when package-to-Git staging fails",
    async (serviceRoot) => {
      const root = tempDirs.make("openclaw-update-package-to-git-fail-");
      const prefix = path.join(root, "prefix");
      const nodeModules = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(nodeModules, "openclaw");
      const shim = path.join(prefix, "bin", "openclaw");
      const gitRoot = path.join(root, "git-root");
      const sha = "a".repeat(40);
      const packageEntry = await writeOpenClawPackageFixture(packageRoot, "2026.4.20", {
        entrySource: "export {};\n",
        inventory: true,
      });
      await fs.mkdir(path.dirname(shim), { recursive: true });
      await fs.writeFile(shim, "old package shim\n", { mode: 0o755 });
      const gitEntry = await writeOpenClawPackageFixture(gitRoot, "2026.8.18", {
        git: true,
        builtSha: sha,
        entrySource: "export {};\n",
      });
      const packageBefore = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
      const shimBefore = await fs.readFile(shim, "utf8");
      mockPackageInstallStatus(packageRoot);
      mockFileBackedPathExists();
      const serviceEntry = serviceRoot === "git" ? gitEntry : packageEntry;
      mockRunningManagedGateway(["node", serviceEntry, "gateway", "run"]);
      mockGitUpdateAfterMutation(
        makeOkUpdateResult({ mode: "git", root: gitRoot, after: { sha } }),
      );
      mockNpmGlobalCommands(nodeModules, async (argv) => {
        if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
          return commandResult({ code: 1, stderr: "candidate verification fixture failure" });
        }
        return undefined;
      });

      await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
        await expect(updateCommand({ channel: "dev", yes: true, json: true })).rejects.toEqual(
          new ExitError(1),
        );
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
      expect(serviceStop).not.toHaveBeenCalled();
      expect(freshRestartCalls()).toEqual([]);
      expectNoSideEffects(serviceStart, serviceRestart, runRestartScript);
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
    },
  );

  it.each(["package", "git"] as const)(
    "recovers only an untouched package service after source publication fails (service=%s)",
    async (serviceRoot) => {
      const root = tempDirs.make("openclaw-update-source-publish-failure-");
      const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
        path.join(root, "prefix", "lib", "node_modules"),
        "2026.4.20",
      );
      const gitRoot = path.join(root, "git-root");
      const sha = "a".repeat(40);
      const gitEntry = await writeOpenClawPackageFixture(gitRoot, "2026.8.18", {
        git: true,
        builtSha: sha,
        entrySource: "export {};\n",
      });
      mockNpmGlobalCommands(nodeModules, undefined, gitRoot);
      mockFileBackedPathExists();
      mockRunningManagedGateway([
        process.execPath,
        serviceRoot === "package" ? entryPath : gitEntry,
        "gateway",
        "run",
      ]);
      mockGatewayHealth(
        serviceRoot === "package" ? "2026.4.20" : "2026.8.18",
        "previous-gateway",
        serviceRoot === "git" ? "fixture-original-build" : undefined,
      );
      readPackageVersion.mockImplementation(async (packageRoot: string) => {
        const manifest = JSON.parse(
          await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ) as { version: string };
        return manifest.version;
      });
      vi.mocked(runGatewayUpdate).mockImplementationOnce(async (options) => {
        await options?.prepareGitExposure?.(gitRoot, sha, undefined);
        expect(serviceStop).not.toHaveBeenCalled();
        expect(await fs.realpath(pkgRoot)).toBe(pkgRoot);
        await options?.validateCandidate?.(gitRoot);
        expect(serviceStop).not.toHaveBeenCalled();
        await options?.beforeGitMutation?.({});
        expect(serviceStop).toHaveBeenCalledOnce();
        return makeOkUpdateResult({
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "source-rollback-failed",
          recovery: { serviceRestartSafe: false, reason: "source-rollback-failed" },
        });
      });

      await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
        await expect(updateCommand({ channel: "dev", yes: true, json: true })).rejects.toEqual(
          new ExitError(1),
        );
      });

      expect(candidateValidation).toHaveBeenCalledOnce();
      expect(lastWriteJsonCall()).toMatchObject({ reason: "source-rollback-failed" });
      expect(
        (await fs.readdir(nodeModules)).filter(
          (entry) =>
            entry.startsWith(".openclaw.update-stage-") ||
            entry.startsWith(".openclaw.package-backup-"),
        ).length,
      ).toBe(0);
      expect(doctorCommandCall()).toBeUndefined();
      expect(await fs.realpath(pkgRoot)).toBe(pkgRoot);
      expect(
        JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")),
      ).toMatchObject({ version: "2026.4.20" });
      if (serviceRoot === "package") {
        expect(freshRestartCalls()).toHaveLength(1);
        expect(freshRestartCalls()[0]?.[0]).toContain(entryPath);
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.4.20" },
        });
      } else {
        expect(freshRestartCalls()).toEqual([]);
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          recovery: { serviceRestartSafe: false, reason: "source-rollback-failed" },
        });
      }
    },
  );

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

  it("never restarts the candidate again after plugin post-update invalidates config", async () => {
    const serviceEntrypoint = path.join(process.cwd(), "dist", "index.js");
    const invalidPostUpdateSnapshot = configSnapshot(baseConfig, {
      valid: false,
      issues: [{ path: "plugins", message: "invalid plugin config" }],
    });
    syncPluginsForUpdateChannel.mockImplementationOnce(async () => {
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(invalidPostUpdateSnapshot);
      return pluginSyncResult(baseConfig);
    });
    mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
    mockGitUpdateAfterMutation();
    vi.mocked(runExec).mockImplementation(async (_file, args) => {
      if (args[1] === "config" && args[2] === "validate") {
        throw new Error("target plugin config invalid");
      }
      return { stdout: new Date(Date.now() - 1000).toString(), stderr: "" };
    });

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(serviceStop).toHaveBeenCalledTimes(1);
    expectNoSideEffects(serviceRestart, runDaemonRestart);
    expect(runRestartScript).toHaveBeenCalledOnce();
    expect(runRestartScript.mock.invocationCallOrder[0]).toBeLessThan(
      requireValue(
        syncPluginsForUpdateChannel.mock.invocationCallOrder[0],
        "plugin convergence order",
      ),
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runExec).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      [serviceEntrypoint, "config", "validate", "--json"],
      expect.objectContaining({ env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" } }),
    );
    expect(getLogOutput()).toContain("OpenClaw update failed: post-update-plugins.");
    expect(getErrorOutput()).not.toContain("Update failed during plugin post-update sync.");
  });

  it("parks the serving core for plugin Doctor and never restarts after Doctor fails", async () => {
    const serviceEntrypoint = path.join(process.cwd(), "dist", "index.js");
    mockRunningManagedGateway(["node", serviceEntrypoint, "gateway", "run"]);
    mockGitUpdateAfterMutation();
    mockNpmPluginOutcomes([], true);
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(serviceEntrypoint);
    vi.mocked(runExec).mockImplementation(async (_file, args) => {
      if (args[1] === "doctor" && args.includes("--repair")) {
        throw new Error("doctor process failed");
      }
      return { stdout: new Date(Date.now() - 1000).toString(), stderr: "" };
    });
    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(serviceStop).toHaveBeenCalledTimes(2);
    expect(runRestartScript).toHaveBeenCalledOnce();
    const firstRestartOrder = requireValue(
      runRestartScript.mock.invocationCallOrder[0],
      "core restart",
    );
    const packageOrder = requireValue(
      updateNpmInstalledPlugins.mock.invocationCallOrder[0],
      "plugin packages",
    );
    const secondStopOrder = requireValue(
      serviceStop.mock.invocationCallOrder[1],
      "plugin maintenance stop",
    );
    const doctorCallIndex = vi
      .mocked(runExec)
      .mock.calls.findIndex(([, args]) => args[1] === "doctor");
    const doctorOrder = requireValue(
      vi.mocked(runExec).mock.invocationCallOrder[doctorCallIndex],
      "plugin Doctor",
    );
    expect(firstRestartOrder).toBeLessThan(packageOrder);
    expect(packageOrder).toBeLessThan(secondStopOrder);
    expect(secondStopOrder).toBeLessThan(doctorOrder);
    expect(
      vi
        .mocked(runExec)
        .mock.calls.filter(([, args]) => ["doctor", "config"].includes(args[1] ?? ""))
        .map(([, args]) => args.slice(1)),
    ).toEqual([
      ["doctor", "--repair", "--non-interactive", "--no-workspace-suggestions", "--yes"],
      ["config", "validate", "--json"],
    ]);
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toHaveLength(0);

    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getLogOutput()).toContain("OpenClaw update failed: post-update-plugins.");
    expect(getLogOutput()).not.toContain("OpenClaw updated");
  });

  it("keeps managed service stop output off stdout during json package updates", async () => {
    const tempDir = tempDirs.make("openclaw-update-json-stop-service-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockRunningManagedGateway(["node", entryPath, "gateway", "run"]);
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
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir);
    mockRunningManagedGateway(["node", entryPath, "gateway", "run"]);
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

  it("leaves same-version package files intact with --no-restart", async () => {
    const tempDir = tempDirs.make("openclaw-update-current-");
    const { nodeModules, pkgRoot } = await setupInstalledPackageRoot(tempDir, "2026.4.23");
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

    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(doctorCommandCall()).toBeUndefined();
    expect(spawnCall()).toBeUndefined();
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(getLogOutput()).toContain("already-current");
  });

  it("retries package updates without optional deps when npm global update fails", async () => {
    const tempDir = tempDirs.make("openclaw-update-optional-");
    const nodeModules = path.join(tempDir, "lib", "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(pkgRoot);
    mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    await writeOpenClawPackageFixture(pkgRoot, "1.0.0", {
      inventory: true,
      entrySource: "export {};\n",
    });

    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (
        argv[0] === "npm" &&
        argv[1] === "i" &&
        argv.includes("-g") &&
        !argv.includes("--omit=optional")
      ) {
        return commandResult({ stderr: "node-gyp failed", code: 1 });
      }
      if (argv[0] === "npm" && argv[1] === "i") {
        await writeNpmPackageInstall(argv, pkgRoot);
      }
      return undefined;
    });

    await updateCommand({ yes: true, restart: false });

    const installArgvs = commandCalls()
      .map(([argv]) => argv)
      .filter((argv) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");
    const installPrefix = [
      "npm",
      "i",
      "-g",
      "--allow-scripts=openclaw",
      "--prefix",
      expect.stringContaining(".openclaw.update-stage-"),
      "openclaw@9999.0.0",
    ];
    const installFlags = ["--no-fund", "--no-audit", "--loglevel=error", "--min-release-age=0"];
    expect(installArgvs).toEqual([
      installPrefix.concat(installFlags),
      installPrefix.concat("--omit=optional", installFlags),
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
    await writeOpenClawPackageFixture(pkgRoot, "1.0.0", {
      entrySource: "export {};\n",
      inventory: true,
    });
    mockFileBackedPathExists();

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
      if (isOwningNpmCommand(argv[0]) && argv[1] === "i" && argv[2] === "-g") {
        await writeNpmPackageInstall(argv, pkgRoot);
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
    await mockPackageInstallAtCaseDir();
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
    mockFileBackedPathExists();

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
        await expect(updateCommand({})).rejects.toEqual(new ExitError(1));
      },
      assert: () => {
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      },
    },
  ] as const)("updateCommand reports outcomes: $name", runUpdateCliScenario);

  it("persists the requested channel only after a successful package update", async () => {
    await mockPackageInstallAtCaseDir();

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

    expect(serviceReadCommand).toHaveBeenCalledTimes(2);
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

    await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));

    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(serviceStop).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    const report = getLogOutput();
    expect(report).toContain(`Node 22.18.0 at ${serviceNode} is too old`);
    expect(report).toContain("Upgrade the Node runtime that owns the managed Gateway service");
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
    "plans service Node selection independently of database admission ($scenario)",
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

      if (command === "gateway") {
        await updateCommand({ dryRun: true });
      } else {
        await expect(updateCommand({ dryRun: true })).rejects.toEqual(new ExitError(1));
        expect(getLogOutput()).toContain("Gateway service installation ownership is unresolved");
      }

      expect(serviceReadCommand).toHaveBeenCalledTimes(2);
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
    await mockPackageInstallAtCaseDir();
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
    await mockPackageInstallAtCaseDir();
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

    await expect(updateCommand({ channel: "beta", yes: true })).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(replaceConfigFile, runCommandWithTimeout);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("does not repair legacy config during a dry run", async () => {
    await mockPackageInstallAtCaseDir();
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

    await expect(updateCommand({ dryRun: true, channel: "beta", yes: true })).rejects.toEqual(
      new ExitError(1),
    );

    expectNoSideEffects(
      replaceConfigFile,
      runCommandWithTimeout,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("does not persist the requested channel when the package update fails", async () => {
    await mockPackageInstallAtCaseDir();
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        return commandResult({ stderr: "install failed", code: 1 });
      }
      return commandResult();
    });

    await expect(updateCommand({ channel: "beta", yes: true })).rejects.toEqual(new ExitError(1));

    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("keeps the requested channel when plugin sync writes config after update", async () => {
    await mockPackageInstallAtCaseDir();
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) =>
      pluginSyncResult(config, true),
    );
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );

    await updateCommand({ channel: "beta", yes: true });

    expect(lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("beta");
  });

  it("refreshes post-doctor config before post-update plugin sync", async () => {
    await mockPackageInstallAtCaseDir();
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

    const syncConfig = syncPluginCall()?.config;
    const lastWrite = lastReplaceConfigCall();
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
    await mockPackageInstallAtCaseDir();
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
      const updateResult = makeOkUpdateResult({
        status,
        mode: "git",
        root: gitRoot,
        after: { sha, version: "2026.8.1" },
      });
      if (status === "ok") {
        mockGitUpdateAfterMutation(updateResult);
      } else {
        vi.mocked(runGatewayUpdate).mockResolvedValue(updateResult);
      }
      mockNoopPostUpdatePluginConvergence();

      await withEnvAsync({ OPENCLAW_GIT_DIR: gitRoot }, async () => {
        const command = updateCommand({ channel: "dev", yes: true, restart: false });
        if (status === "error") {
          await expect(command).rejects.toEqual(new ExitError(1));
        } else {
          await command;
        }
      });
      if (status === "error") {
        expect(packageInstallCommandCall()?.[0]).toBeUndefined();
        expectNoSideEffects(spawn, replaceConfigFile, completionCacheSpy);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2026.4.10"');
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
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

  it.each(["success", "failure"] as const)(
    "starts interactive update triage after cleanup and preserves update status after agent %s",
    async (agentOutcome) => {
      setTty(true);
      setStdoutTty(true);
      const stateDir = profileStateDir("update-triage");
      tempDirsToCleanup.add(stateDir);
      await fs.mkdir(stateDir, { recursive: true });
      const target = {
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        defaultWorkspaceDir: path.join(stateDir, "workspace"),
      };
      const operatorPath = `${path.join(stateDir, "coding-tools")}${path.delimiter}${process.env.PATH}`;
      const operatorNodeOptions = "--max-old-space-size=1024";
      await writeJsonFixture(target.configPath, baseSnapshot.config);
      const update: UpdateRunResult = {
        status: "error",
        mode: "git",
        root: process.cwd(),
        reason: "doctor-failed",
        before: { version: "1.0.0" },
        after: { version: "1.1.0" },
        recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
        steps: [],
        durationMs: 100,
      };
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
      mockOwnedGitService();
      primeServiceCommand(
        [process.execPath, path.join(process.cwd(), "dist", "index.js"), "gateway"],
        {
          PATH: "/usr/bin:/bin",
          NODE_OPTIONS: "",
          OPENCLAW_PROFILE: "update-triage",
          OPENCLAW_STATE_DIR: target.stateDir,
          OPENCLAW_CONFIG_PATH: target.configPath,
          OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
        },
      );
      mockGitUpdateAfterMutation(update);
      let triageEnv: Record<string, string | undefined> | undefined;
      const events: string[] = [];
      triageCommand.mockImplementationOnce(async () => {
        events.push("triage");
        triageEnv = {
          updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS,
          stateDir: process.env.OPENCLAW_STATE_DIR,
          configPath: process.env.OPENCLAW_CONFIG_PATH,
          defaultWorkspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
          path: process.env.PATH,
          nodeOptions: process.env.NODE_OPTIONS,
        };
        if (agentOutcome === "failure") {
          throw new ExitError(2);
        }
      });

      await withEnvAsync(
        {
          OPENCLAW_PROFILE: "update-triage",
          OPENCLAW_STATE_DIR: target.stateDir,
          OPENCLAW_CONFIG_PATH: target.configPath,
          OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          PATH: operatorPath,
          NODE_OPTIONS: operatorNodeOptions,
        },
        async () => {
          await expect(
            updateCommand({}).catch((error: unknown) => {
              events.push("exit");
              throw error;
            }),
          ).rejects.toEqual(new ExitError(1));
          expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
        },
      );

      expect(triageCommand).toHaveBeenCalledOnce();
      expect(triageEnv).toEqual({
        updateInProgress: undefined,
        ...target,
        path: operatorPath,
        nodeOptions: operatorNodeOptions,
      });
      expect(triageCommand.mock.calls[0]?.[1]).toMatchObject({
        recovery: {
          target,
          updateFailure: {
            result: {
              status: "error",
              mode: "git",
              root: process.cwd(),
              reason: "doctor-failed",
              before: update.before,
              after: update.after,
              recovery: update.recovery,
              steps: [],
            },
          },
        },
      });
      expect(serviceStop, `${getLogOutput()}\n${getErrorOutput()}`).toHaveBeenCalledOnce();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(events).toEqual(["triage", "exit"]);
    },
  );

  it.each([
    { name: "JSON", options: { json: true }, stdin: true, stdout: true, success: false },
    {
      name: "non-interactive --yes",
      options: { yes: true },
      stdin: true,
      stdout: true,
      success: false,
    },
    { name: "piped input", options: {}, stdin: false, stdout: true, success: false },
    { name: "piped output", options: {}, stdin: true, stdout: false, success: false },
    { name: "successful update", options: {}, stdin: true, stdout: true, success: true },
  ])(
    "does not automatically launch update triage for $name",
    async ({ options, stdin, stdout, success }) => {
      setTty(stdin);
      setStdoutTty(stdout);
      vi.mocked(runGatewayUpdate).mockResolvedValue(
        makeOkUpdateResult({
          status: success ? "ok" : "error",
          root: process.cwd(),
          ...(success
            ? {}
            : {
                reason: "doctor-failed",
                recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
              }),
        }),
      );

      if (success) {
        await updateCommand(options);
      } else {
        await expect(updateCommand(options)).rejects.toEqual(new ExitError(1));
      }

      expect(triageCommand).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(runUpdateFailureTriage).toHaveBeenCalledTimes(success ? 0 : 1);
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

    await expect(updateCommand({ channel: "dev" })).rejects.toEqual(new ExitError(1));

    const logs = getLogOutput();
    expect(logs).toContain("OpenClaw update skipped: dirty.");
    expect(logs).toContain(
      "Git-based updates need a clean working tree before they can switch commits, fetch, or rebase.",
    );
    expect(logs).toContain(
      "Commit, stash, or discard the local changes, then rerun `openclaw update`.",
    );
    expect(listUpdateRuns({ limit: 1 })[0]?.origin.nextAction).toContain(
      "Commit, stash, or discard the local changes",
    );
    expect(serviceStop).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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
      name: "uses the installed Git CLI when service env refresh cannot complete",
      run: async () => {
        await runRestartFallbackScenario({ daemonInstall: "fail" });
      },
      assert: () => {
        expectNoSideEffects(runDaemonInstall, runDaemonRestart);
      },
    },
    {
      name: "uses the installed Git CLI after service env refresh succeeds",
      run: async () => {
        await runRestartFallbackScenario({ daemonInstall: "ok" });
      },
      assert: () => {
        expectNoSideEffects(runDaemonInstall, runDaemonRestart);
      },
    },
    {
      name: "skips service env refresh when --no-restart is set",
      run: async () => {
        mockGitUpdateAfterMutation();
        serviceLoaded.mockResolvedValue(true);
        mockOwnedGitService();

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
    await mockPackageInstallAtCaseDir();
    vi.mocked(resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(undefined);
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(serviceStart).not.toHaveBeenCalled();
    expect(freshRestartCalls().length).toBe(0);
    expectNoSideEffects(prepareRestartScript, runRestartScript);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "tries the updated install restart when package service refresh fails (JSON: %s)",
    async (json) => {
      const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
      serviceLoaded.mockResolvedValue(true);
      primeServiceCommand(["node", updatedEntrypoint, "gateway", "run"]);
      mockGatewayInstallFailure(updatedEntrypoint);
      if (json) {
        vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
          const failed = argv[1] === updatedEntrypoint && argv[3] === "install";
          return commandResult({
            stdout: failed
              ? JSON.stringify(
                  {
                    action: "install",
                    ok: false,
                    error: "Gateway install blocked: newer configuration",
                    hints: ["Use the intended binary."],
                  },
                  null,
                  2,
                )
              : "",
            stderr: failed ? "runtime warning" : "",
            code: failed ? 1 : 0,
          });
        });
      }
      mockGatewayHealth("2026.4.24", "updated-gateway");

      await updateCommand({ yes: true, json });

      expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
      const restartCall = gatewayCommandCall(updatedEntrypoint, "restart");
      expect(restartCall?.[0].slice(1)).toEqual([
        updatedEntrypoint,
        "gateway",
        "restart",
        "--json",
      ]);
      expect(restartCall?.[1].cwd).toBe(updatedRoot);
      expect(runRestartScript).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      if (json) {
        expect(getErrorOutput()).toContain("Gateway install blocked: newer configuration");
      } else {
        expect(getLogOutput()).toContain("Gateway: restarted and verified.");
      }
    },
  );

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
    mockGatewayHealth("2026.4.24", "matching-old-gateway");

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
    mockGatewayHealth("2026.4.24", "matching-old-service");

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
    mockGatewayHealth("2026.4.23", "old-gateway");

    await expect(updateCommand({ yes: true, json: true, timeout: "123" })).rejects.toEqual(
      new ExitError(1),
    );

    expectNoSideEffects(runRestartScript, runDaemonRestart);
    const restartCall = gatewayCommandCall(updatedEntrypoint, "restart");
    expect(restartCall?.[0][0]).toContain("node");
    expect(restartCall?.[0].slice(1)).toEqual([updatedEntrypoint, "gateway", "restart", "--json"]);
    expect(restartCall?.[1].cwd).toBe(updatedRoot);
    expect(restartCall?.[1].timeoutMs).toBe(123_000);
    expect(gatewayHealthCall()).toMatchObject({ method: "health", scopes: ["operator.read"] });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "version-mismatch" });
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

    await expect(updateCommand({ yes: true, json: true, timeout: "123" })).rejects.toEqual(
      new ExitError(1),
    );

    const diagnostics = getErrorOutput();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(diagnostics).toContain("Gateway probe failed: timeout");
    expect(diagnostics).toContain("Port 18789 is already in use.");
    expect(diagnostics).not.toContain("Gateway version mismatch");
  });

  it("skips the post-refresh restart script when LaunchAgent already serves the expected package version", async () => {
    const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
    serviceLoaded.mockResolvedValue(true);
    mockGatewayHealth("2026.4.24", "updated-gateway");

    await updateCommand({ yes: true });

    const installCall = gatewayCommandCall(updatedEntrypoint, "install");
    expect(installCall?.[0][0]).toContain("node");
    expect(installCall?.[0].slice(1)).toEqual([
      updatedEntrypoint,
      "gateway",
      "install",
      "--force",
      "--json",
    ]);
    expect(installCall?.[1].cwd).toBe(updatedRoot);
    expect(installCall?.[1].timeoutMs).toBe(60_000);
    expect(gatewayCommandCall(updatedEntrypoint, "restart")).toBeUndefined();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(gatewayHealthCall()).toMatchObject({ method: "health", scopes: ["operator.read"] });
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
        mockGatewayHealth("2026.4.24", "updated-gateway");
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
      expectedExitCode: 1,
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        handoffId: "extended-stable-dry-run",
        note: "Preview requested from the agent.",
      },
      options: { channel: "extended-stable", dryRun: true, yes: true, json: true },
      beforeUpdate: async () => {
        await mockPackageInstallAtCaseDir();
        vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
          status: "failed",
          reason: "selector_missing",
        });
      },
    });

    expect(sentinel).toBeNull();
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("writes an extended-stable selector failure to the control-plane sentinel", async () => {
    const sentinel = await runControlPlaneUpdate({
      expectedExitCode: 1,
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        handoffId: "extended-stable-handoff",
        note: "Update requested from the agent.",
      },
      options: { channel: "extended-stable", yes: true, json: true },
      beforeUpdate: async () => {
        await mockPackageInstallAtCaseDir();
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
        expectedExitCode: 1,
        meta: {
          sessionKey: "agent:main:webchat:dm:user-123",
          continuationMessage: "This should not report a successful update.",
        },
        options: { yes: true, json: true },
        beforeUpdate: async () => {
          setupNpmUpdatedRootRefresh();
          prepareRestartScript.mockResolvedValue(null);
          serviceLoaded.mockResolvedValue(true);
          mockGatewayHealth("2026.4.23", "old-gateway");
          if (consumed) {
            const respond = expectDefined(callGateway.getMockImplementation(), "health response");
            callGateway.mockImplementation(async (opts) => {
              sentinelConsumed = (await clearRestartSentinel()) || sentinelConsumed;
              return respond(opts);
            });
          }
        },
      });
      if (consumed) {
        expect(sentinelConsumed).toBe(true);
        expect(sentinel).toBeNull();
      } else {
        expect(sentinel?.payload.status).toBe("error");
        expect(sentinel?.payload.stats?.reason).toBe("version-mismatch");
        expect(sentinel?.payload.continuation).toBeUndefined();
      }
      expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "version-mismatch" });
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
    },
  );

  it("fails a package update when the restarted gateway reports activated plugin load errors", async () => {
    setupNpmUpdatedRootRefresh();
    readPackageVersion.mockResolvedValue("2026.4.24");
    serviceLoaded.mockResolvedValue(true);
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.24", connId: "updated-gateway" },
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
      }),
    );

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(runRestartScript).toHaveBeenCalledTimes(1);
    expect(gatewayHealthCall()).toMatchObject({ method: "health", scopes: ["operator.read"] });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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
              OPENCLAW_WORKSPACE_DIR: path.relative(
                originalCwd,
                path.join(profileStateDir(), "workspace"),
              ),
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
      expectedEnv: () => ({
        OPENCLAW_STATE_DIR: profileStateDir(),
        OPENCLAW_WORKSPACE_DIR: path.join(profileStateDir(), "workspace"),
      }),
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
    expect(installCall?.[0].slice(1)).toEqual([
      entryPath,
      "gateway",
      "install",
      "--force",
      "--json",
    ]);
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
        const entrypoint = path.join(process.cwd(), "dist", "index.js");
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
        mockRunningManagedGateway(["node", entrypoint, "gateway"]);
        if (mutatesCore) {
          mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));
        }
        prepareRestartScript.mockResolvedValue(null);
        vi.mocked(defaultRuntime.log).mockClear();

        await updateCommand({});

        expect(doctorCommand).not.toHaveBeenCalled();
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBe(previous);
        const restartIndex = vi
          .mocked(runCommandWithTimeout)
          .mock.calls.findIndex(([argv]) => argv[2] === "gateway" && argv[3] === "restart");
        const restartOrder = requireValue(
          vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[restartIndex],
          "installed CLI restart call order",
        );
        const snapshotOrders = createPreUpdateConfigSnapshotMock.mock.invocationCallOrder;
        expect(createPreUpdateConfigSnapshotMock).toHaveBeenCalledTimes(1);
        expect(requireValue(snapshotOrders[0], "restart snapshot call order")).toBeLessThan(
          restartOrder,
        );

        const successIndex = vi
          .mocked(defaultRuntime.log)
          .mock.calls.findIndex((call) => String(call[0]).includes("OpenClaw updated"));
        expect(successIndex).toBeGreaterThanOrEqual(0);
        expect(
          vi.mocked(defaultRuntime.log).mock.invocationCallOrder[successIndex],
        ).toBeGreaterThan(restartOrder);
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
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
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
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
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
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
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
    await expect(
      updateFinalizeCommand({
        channel: "extended-stable",
        json: true,
        restart: false,
      }),
    ).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(replaceConfigFile, runExec, syncPluginsForUpdateChannel);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      mode: "git",
      reason: "unsupported_git_channel",
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
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
    const tempDir = createCaseDir("openclaw-rpc-finalize");
    const entryPath = await writeOpenClawPackageFixture(tempDir, "2026.6.18", {
      entrySource: "export {};\n",
    });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(tempDir);
    mockFileBackedPathExists();
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
    const finalizationCommands = vi
      .mocked(runExec)
      .mock.calls.filter(
        ([, args]) => args[0] === entryPath && ["doctor", "config"].includes(args[1] ?? ""),
      )
      .map(([, args]) => args.slice(1));
    expect(finalizationCommands).toEqual([
      ["doctor", "--repair", "--non-interactive"],
      ["doctor", "--repair", "--non-interactive", "--no-workspace-suggestions"],
      ["config", "validate", "--json"],
    ]);
    expect(doctorCommand).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
  });

  it("updateFinalizeCommand reapplies requested channel against post-doctor config", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
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
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
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
      run: async () => await invokeUpdateCli({ timeout: "invalid" }),
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
    const root = await setupNonInteractiveDowngrade();
    if (shouldRunPackageUpdate) {
      mockCurrentProcessFreshDoctor({ packageRoot: root, postCoreResumeAttempt: false });
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
        vi.mocked(runGatewayUpdate).mockImplementation(async (options) => {
          await writeOpenClawPackageFixture(tempDir, "2026.8.1", { git: true, builtSha: sha });
          await options?.prepareGitExposure?.(tempDir, sha, undefined);
          await options?.validateCandidate?.(tempDir);
          await options?.beforeGitMutation?.({});
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
      await invokeUpdateCli({ channel: "dev", yes: true, restart: false });
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
    await mockPackageInstallAtCaseDir("openclaw-stable-update");
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
