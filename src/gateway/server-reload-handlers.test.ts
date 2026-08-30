/**
 * Gateway config reload handler tests.
 */
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  prepareRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { addSession, markBackgrounded, markExited } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import {
  clearCurrentProviderAuthState as clearWarmedProviderAuthState,
  getCurrentProviderAuthStates,
  publishProviderAuthWarmSnapshot,
} from "../agents/model-provider-auth-state.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { prepareConfigRuntimeEnv } from "../config/config-env-vars.js";
import type { ConfigWriteNotification } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationStatus,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import {
  consumeGatewaySigusr1RestartIntent,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  setGatewaySigusr1RestartPolicy,
  setPreRestartDeferralCheck,
} from "../infra/restart.js";
import { registerPluginCommandInRegistry } from "../plugins/command-registration.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  createPluginCommandRuntime,
  type PluginCommandCatalogDecision,
} from "../plugins/plugin-command-runtime.js";
import { createPluginMetadataOwner } from "../plugins/plugin-metadata-collection.js";
import {
  captureActivePluginRegistrySnapshot,
  resetPluginRuntimeStateForTest,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { CommandLane } from "../process/lanes.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { buildWindowsCmdExeCommandLine } from "../process/windows-command.js";
import { createSimpleChannelSecretContract } from "../secrets/channel-secret-basic-runtime.js";
import { refResolutionError } from "../secrets/resolve-errors.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import { listActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import {
  classifySecretOwnerDegradationState,
  listSecretAssignmentOwners,
  resolveAndApplySecretAssignments,
} from "../secrets/runtime-owner-assignments.js";
import { createResolverContext } from "../secrets/runtime-shared.js";
import {
  activateSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshotIfCurrent,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { isRecord } from "../utils.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  type ChannelKind,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import { shouldRewarmProviderAuthState } from "./config-reload-recovery.js";
import type { GatewayHotReloadApplicationStatus } from "./config-reload-status.types.js";
import { applyHookMappings } from "./hooks-mapping.js";
import { commitHooksConfigReload } from "./hooks.js";
import { createChannelManager } from "./server-channels.js";
import { createLazyGatewayCronState } from "./server-cron-lazy.js";
import type { GatewayCronState } from "./server-cron.js";
import {
  GatewayConfigReloadSupersededError,
  GatewayHotReloadCancelledError,
} from "./server-reload-contracts.js";
import type { GatewayPluginReloadResult } from "./server-reload-handlers.js";
import {
  abortPendingChannelReloads,
  createGatewayReloadHandlers as createGatewayReloadHandlersImpl,
  startManagedGatewayConfigReloader as startManagedGatewayConfigReloaderImpl,
} from "./server-reload-handlers.js";
import { enforceSharedGatewaySessionGenerationForConfigWrite } from "./server-shared-auth-generation.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { createTerminalLaunchPolicy } from "./terminal/launch.js";

type ReloadHandlerParams = Parameters<typeof createGatewayReloadHandlersImpl>[0];
type ManagedReloaderParams = Parameters<typeof startManagedGatewayConfigReloaderImpl>[0];
type ConfigWriteListener = (event: ConfigWriteNotification) => void;
type ConfigWriteListenerRef = { current: ConfigWriteListener | null };
type ManagedReloaderTestParams = Pick<
  ManagedReloaderParams,
  "initialConfig" | "readSnapshot" | "subscribeToWrites"
> &
  Partial<ManagedReloaderParams>;

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const tempDirs: string[] = [];
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

const restartTesting = {
  resetSigusr1State() {
    resetGatewayRestartStateForInProcessRestart();
    markGatewaySigusr1RestartHandled();
    setGatewaySigusr1RestartPolicy({ allowExternal: false });
    setPreRestartDeferralCheck(() => 0);
    resetGatewayWorkAdmission();
  },
};

function createGatewayReloadHandlers(
  params: Partial<Omit<ReloadHandlerParams, "requestRecoveryRestart">> & {
    requestRecoveryRestart?: NonNullable<ReloadHandlerParams["requestRecoveryRestart"]> | null;
  },
) {
  const { requestRecoveryRestart, ...handlerParams } = params;
  return createGatewayReloadHandlersImpl({
    deps: {} as never,
    broadcast: vi.fn(),
    getState: createDefaultGatewayReloadState,
    setState: vi.fn(),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    pruneInactiveChannelAccountState: vi.fn(),
    stopPostReadySidecars: vi.fn(),
    reloadPlugins: vi.fn(async () => makePluginReloadResult()),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload: { info: vi.fn(), warn: vi.fn() },
    createHealthMonitor: () => null,
    ...handlerParams,
    cronReconciliation: params.cronReconciliation ?? createTestCronReconciliation(),
    ...(requestRecoveryRestart === null
      ? {}
      : {
          requestRecoveryRestart:
            requestRecoveryRestart ?? requestGatewayRestartWithSignalAdmission,
        }),
  });
}

function createDefaultGatewayReloadState(
  overrides: Partial<ReturnType<ReloadHandlerParams["getState"]>> = {},
) {
  return {
    hooksConfig: {} as never,
    hookClientIpConfig: {} as never,
    heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
    cronState: createTestCronState(),
    channelHealthMonitor: null,
    ...overrides,
  };
}

function createTestCronState(overrides: Partial<GatewayCronState> = {}): GatewayCronState {
  return {
    cron: { start: vi.fn(async () => {}), stop: vi.fn() } as never,
    storePath: "/tmp/cron.json",
    cronEnabled: false,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    reconcileHeartbeatJobs: vi.fn(async () => "converged" as const),
    ...overrides,
  };
}

function startManagedGatewayConfigReloader(params: ManagedReloaderTestParams) {
  return startManagedGatewayConfigReloaderImpl({
    minimalTestGateway: false,
    initialCompareConfig: params.initialConfig,
    initialInternalWriteHash: null,
    watchPath: "/tmp/openclaw.json",
    promoteSnapshot: vi.fn(async () => true) as never,
    deps: {} as never,
    broadcast: vi.fn(),
    getState: createDefaultGatewayReloadState,
    setState: vi.fn(),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    reloadPlugins: vi.fn(async () => makePluginReloadResult()),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    channelManager: { pruneInactiveChannelAccountState: vi.fn() } as never,
    activateRuntimeSecrets:
      params.activateRuntimeSecrets ?? createTestRuntimeSecretsActivator().activateRuntimeSecrets,
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: { current: undefined, required: null },
    clients: [],
    reconcileTerminalSessions: vi.fn(),
    commitTerminalConfig: vi.fn(),
    acceptTerminalConfig: vi.fn(),
    ...params,
    configRevisionProjector: params.configRevisionProjector ?? {
      projectRawHash: (hash) => hash,
      projectResolvedHash: (hash) => hash,
    },
    initialSnapshotRawHash: params.initialSnapshotRawHash ?? null,
    initialAuthoredConfig: params.initialAuthoredConfig ?? {},
    initialSnapshotValid: params.initialSnapshotValid ?? true,
    initialSnapshotIssues: params.initialSnapshotIssues ?? [],
    cronReconciliation: params.cronReconciliation ?? createTestCronReconciliation(),
    prepareTerminalConfig: params.prepareTerminalConfig ?? vi.fn(),
    requestRecoveryRestart:
      params.requestRecoveryRestart ?? requestGatewayRestartWithSignalAdmission,
  });
}

type GmailWatcherRestartParams = {
  cfg: OpenClawConfig;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  onSkipped?: () => void;
  signal?: AbortSignal;
};

type StartGmailWatcherWithLogs = (params: GmailWatcherRestartParams) => Promise<void>;
type StopGmailWatcher = () => Promise<void>;

const hoisted = vi.hoisted(() => ({
  startGmailWatcherWithLogs: vi.fn<StartGmailWatcherWithLogs>(async () => {}),
  stopGmailWatcher: vi.fn<StopGmailWatcher>(async () => {}),
  activeTaskCount: { value: 0 },
  activeTaskBlockers: [] as Array<{
    taskId: string;
    status: "queued" | "running";
    runtime: "subagent" | "acp" | "cli" | "cron";
    runId?: string;
    label?: string;
    title?: string;
  }>,
  activeEmbeddedRunCount: { value: 0 },
  activeEmbeddedRunSessionIds: [] as string[],
  activeEmbeddedRunSessionKeys: [] as string[],
  markRestartAbortedMainSessions: vi.fn(async (_params: unknown) => ({ marked: 1, skipped: 0 })),
  runtimeConfig: { value: { session: { store: "/tmp/active-sessions.json" } } as OpenClawConfig },
  assertOpenClawDatabasesReady: vi.fn(() => {}),
  applyLoggingConfig: vi.fn(),
  resetSkillSnapshotConfigFingerprintCache: vi.fn(),
  reloadEvents: [] as string[],
  loadModelCatalog: vi.fn(async (_params: { config: OpenClawConfig }) => []),
  resetModelCatalogCache: vi.fn(() => {}),
  advancePreparedModelRuntimeConfig: vi.fn((_cfg: OpenClawConfig) => {}),
  markPreparedModelRuntimeSnapshotsStale: vi.fn(
    (
      _reason?: string,
      _options?: {
        waitForReplacement?: boolean;
        preserveReplacementWait?: boolean;
        agentIds?: ReadonlySet<string>;
      },
    ) => Symbol("prepared-model-runtime-replacement"),
  ),
  rejectPendingPreparedModelRuntimeReplacement: vi.fn(
    (_gateId: symbol | undefined, _error: unknown) => {},
  ),
  refreshPreparedModelRuntimeSnapshots: vi.fn(
    async (_cfg: OpenClawConfig, _options?: { catalogMode?: "live" | "static" }) => {},
  ),
  refreshContextWindowCache: vi.fn(async (_cfg: OpenClawConfig) => {}),
  clearCurrentProviderAuthState: vi.fn(() => {}),
  warmCurrentProviderAuthStateOffMainThread: vi.fn(async (_cfg: OpenClawConfig) => {}),
  disposeAllSessionMcpRuntimes: vi.fn(async () => {}),
  buildGatewayCronService: vi.fn((_params?: { env?: NodeJS.ProcessEnv }) => ({
    cron: { start: vi.fn(async () => {}), stop: vi.fn() },
    storePath: "/tmp/rebuilt-cron.json",
    cronEnabled: true,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    reconcileHeartbeatJobs: vi.fn(async () => "converged" as const),
  })),
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: hoisted.stopGmailWatcher,
}));

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
}));

vi.mock("../tasks/task-registry.maintenance.js", async () => {
  const actual = await vi.importActual<typeof import("../tasks/task-registry.maintenance.js")>(
    "../tasks/task-registry.maintenance.js",
  );
  return {
    ...actual,
    getInspectableActiveTaskRestartBlockers: () => hoisted.activeTaskBlockers,
    getInspectableTaskRegistrySummary: () => ({
      total: hoisted.activeTaskCount.value,
      active: hoisted.activeTaskCount.value,
      terminal: 0,
      failures: 0,
      byStatus: {
        queued: 0,
        running: hoisted.activeTaskCount.value,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: hoisted.activeTaskCount.value,
        acp: 0,
        cli: 0,
        cron: 0,
      },
    }),
  };
});

vi.mock("../agents/embedded-agent-runner/active-run-projections.js", () => ({
  getActiveEmbeddedRunCount: () => hoisted.activeEmbeddedRunCount.value,
  listActiveEmbeddedRunSessionIds: () => hoisted.activeEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys: () => hoisted.activeEmbeddedRunSessionKeys,
}));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => ({
  markRestartAbortedMainSessions: hoisted.markRestartAbortedMainSessions,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => hoisted.runtimeConfig.value,
  };
});

vi.mock("../state/openclaw-database-preflight.js", () => ({
  assertOpenClawDatabasesReady: hoisted.assertOpenClawDatabasesReady,
}));

vi.mock("../logging/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/logger.js")>()),
  applyLoggingConfig: hoisted.applyLoggingConfig,
}));

vi.mock("../skills/runtime/snapshot-config-fingerprint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/runtime/snapshot-config-fingerprint.js")>()),
  resetSkillSnapshotConfigFingerprintCache: hoisted.resetSkillSnapshotConfigFingerprintCache,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: (params: { config: OpenClawConfig }) => {
    hoisted.reloadEvents.push("load-model-catalog");
    return hoisted.loadModelCatalog(params);
  },
  resetModelCatalogCache: () => {
    hoisted.reloadEvents.push("reset-model-catalog");
    hoisted.resetModelCatalogCache();
  },
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  advancePreparedModelRuntimeConfig: (cfg: OpenClawConfig) =>
    hoisted.advancePreparedModelRuntimeConfig(cfg),
  markPreparedModelRuntimeSnapshotsStale: (
    reason?: string,
    options?: { waitForReplacement?: boolean; preserveReplacementWait?: boolean },
  ) => {
    hoisted.reloadEvents.push("stale-prepared-model-runtime");
    return hoisted.markPreparedModelRuntimeSnapshotsStale(reason, options);
  },
  rejectPendingPreparedModelRuntimeReplacement: (gateId: symbol | undefined, error: unknown) =>
    hoisted.rejectPendingPreparedModelRuntimeReplacement(gateId, error),
  refreshPreparedModelRuntimeSnapshots: (
    cfg: OpenClawConfig,
    options?: { catalogMode?: "live" | "static" },
  ) => {
    hoisted.reloadEvents.push("refresh-prepared-model-runtime");
    return hoisted.refreshPreparedModelRuntimeSnapshots(cfg, options);
  },
}));

vi.mock("../agents/context.js", () => ({
  refreshContextWindowCache: async (cfg: OpenClawConfig) => {
    hoisted.reloadEvents.push("refresh-context-window");
    await hoisted.refreshContextWindowCache(cfg);
  },
}));

vi.mock("../agents/model-provider-auth.js", () => ({
  clearCurrentProviderAuthState: () => {
    hoisted.reloadEvents.push("clear-provider-auth");
    hoisted.clearCurrentProviderAuthState();
  },
  warmCurrentProviderAuthStateOffMainThread: async (
    cfg: OpenClawConfig,
    options?: { isCancelled?: () => boolean },
  ) => {
    hoisted.reloadEvents.push("warm-provider-auth");
    if (options?.isCancelled?.()) {
      return;
    }
    await hoisted.warmCurrentProviderAuthStateOffMainThread(cfg);
  },
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  disposeAllSessionMcpRuntimes: hoisted.disposeAllSessionMcpRuntimes,
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
  loadInstalledPluginIndexInstallRecordsSync: vi.fn(() => ({})),
}));

vi.mock("./server-cron.js", async () => {
  const actual = await vi.importActual<typeof import("./server-cron.js")>("./server-cron.js");
  return {
    ...actual,
    buildGatewayCronService: hoisted.buildGatewayCronService,
  };
});

function createRecordedChannelHandlers(events: string[]) {
  return {
    stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
      events.push(`stop:${channel}:${accountId}`);
    }),
    start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
      events.push(`start:${channel}:${accountId}`);
    }),
  };
}

function makePreparedSecretsSnapshot(
  config: OpenClawConfig,
  overrides: Omit<Partial<PreparedSecretsRuntimeSnapshot>, "authStores"> & {
    authStores?: Parameters<typeof prepareRuntimeAuthProfileStoreSnapshots>[0];
  } = {},
): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: config,
    config,
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    warnings: [],
    webTools: createEmptyRuntimeWebToolsMetadata(),
    ...overrides,
    authStores: prepareRuntimeAuthProfileStoreSnapshots(overrides.authStores ?? []),
  };
}

type PrepareRuntimeSecretsSnapshotForTest = NonNullable<
  Parameters<typeof createRuntimeSecretsActivator>[0]["prepareRuntimeSecretsSnapshot"]
>;

function createTestRuntimeSecretsActivator(
  prepare: PrepareRuntimeSecretsSnapshotForTest = async ({ config }) =>
    makePreparedSecretsSnapshot(config),
) {
  const prepareRuntimeSecretsSnapshot = vi.fn(prepare);
  const emitStateEvent = vi.fn();
  const logSecrets = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // Keep the callable owner intact: deferred publication is keyed by its identity.
  const activateRuntimeSecrets = createRuntimeSecretsActivator({
    prepareRuntimeSecretsSnapshot,
    activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
    emitStateEvent,
    logSecrets,
  });
  return { activateRuntimeSecrets, prepareRuntimeSecretsSnapshot, emitStateEvent, logSecrets };
}

function makeActiveTaskBlocker(
  overrides: Partial<(typeof hoisted.activeTaskBlockers)[number]> = {},
): (typeof hoisted.activeTaskBlockers)[number] {
  return {
    taskId: "task-blocking-reload",
    status: "running",
    runtime: "subagent",
    ...overrides,
  };
}

function makePluginReloadResult(
  overrides: Partial<GatewayPluginReloadResult> = {},
): GatewayPluginReloadResult {
  return {
    restartChannels: new Set(),
    activeChannels: new Set(),
    ...overrides,
  };
}

function enableChannelReloadsForTest() {
  const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
  const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
  return () => {
    if (previousSkipChannels === undefined) {
      delete process.env.OPENCLAW_SKIP_CHANNELS;
    } else {
      process.env.OPENCLAW_SKIP_CHANNELS = previousSkipChannels;
    }
    if (previousSkipProviders === undefined) {
      delete process.env.OPENCLAW_SKIP_PROVIDERS;
    } else {
      process.env.OPENCLAW_SKIP_PROVIDERS = previousSkipProviders;
    }
  };
}

function createTestCronReconciliation() {
  const complete = vi.fn<() => Promise<void>>(async () => {});
  return {
    arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete })),
    complete,
    invalidate: vi.fn(),
  };
}

function createCronRestartPlan(): GatewayReloadPlan {
  return createHotTailPlan({
    changedPaths: ["cron"],
    hotReasons: ["cron"],
    restartCron: true,
  });
}

function createHotTailPlan(overrides: Partial<GatewayReloadPlan> = {}): GatewayReloadPlan {
  return {
    changedPaths: ["logging.level"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: ["logging.level"],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    noopPaths: [],
    ...overrides,
  };
}

function createGatewayRestartPlan(changedPath = "gateway.port"): GatewayReloadPlan {
  return createHotTailPlan({
    changedPaths: [changedPath],
    restartGateway: true,
    restartReasons: [changedPath],
    hotReasons: [],
  });
}

function createPluginReloadPlan(): GatewayReloadPlan {
  return createHotTailPlan({
    changedPaths: ["plugins.enabled"],
    hotReasons: ["plugins.enabled"],
    reloadPlugins: true,
  });
}

function createValidConfigSnapshot(config: OpenClawConfig, hash: string) {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    sourceConfig: config,
    resolved: config,
    valid: true,
    runtimeConfig: config,
    config,
    issues: [],
    warnings: [],
    legacyIssues: [],
    hash,
  };
}

function createConfigWriteNotification(
  config: OpenClawConfig,
  persistedHash: string,
  revision: number,
  fingerprint: string,
  sourceFingerprint: string,
  overrides: Partial<ConfigWriteNotification> = {},
): ConfigWriteNotification {
  return {
    configPath: "/tmp/openclaw.json",
    sourceConfig: config,
    runtimeConfig: config,
    persistedHash,
    revision,
    fingerprint,
    sourceFingerprint,
    writtenAtMs: Date.now(),
    ...overrides,
  };
}

function createConfigWriteListenerRef(): ConfigWriteListenerRef {
  return { current: null };
}

function captureConfigWriteListener(
  ref: ConfigWriteListenerRef,
  clearOnlyIfCurrent = true,
): ManagedReloaderParams["subscribeToWrites"] {
  return (listener) => {
    ref.current = listener;
    return () => {
      if (!clearOnlyIfCurrent || ref.current === listener) {
        ref.current = null;
      }
    };
  };
}

function createReloadHandlersForTest(
  logReload = { info: vi.fn(), warn: vi.fn() },
  channels?: {
    start: ReloadHandlerParams["startChannel"];
    stop: ReloadHandlerParams["stopChannel"];
    pruneInactiveChannelAccountState?: ReloadHandlerParams["pruneInactiveChannelAccountState"];
  },
  reloadPlugins?: Parameters<typeof createGatewayReloadHandlers>[0]["reloadPlugins"],
  stopPostReadySidecars = vi.fn(),
  recovery: boolean | NonNullable<ReloadHandlerParams["requestRecoveryRestart"]> = true,
  options?: {
    getChannelAutostartSuppression?: ReloadHandlerParams["getChannelAutostartSuppression"];
  },
) {
  const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
  const reconcileHeartbeatJobs = vi.fn<GatewayCronState["reconcileHeartbeatJobs"]>(
    async () => "converged",
  );
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  let state: Parameters<ReloadHandlerParams["setState"]>[0] = {
    hooksConfig: {} as never,
    hookClientIpConfig: {} as never,
    heartbeatRunner: heartbeatRunner as never,
    cronState: createTestCronState({
      cron: cron as never,
      reconcileHeartbeatJobs,
    }),
    channelHealthMonitor: null,
  };
  const setState = vi.fn((nextState: typeof state) => {
    state = nextState;
  });
  const cronReconciliation = createTestCronReconciliation();
  const logCron = { error: vi.fn() };
  const logChannels = { info: vi.fn(), error: vi.fn() };
  const handlers = createGatewayReloadHandlers({
    getState: () => state,
    setState,
    startChannel: channels?.start ?? vi.fn(async () => {}),
    stopChannel: channels?.stop ?? vi.fn(async () => {}),
    ...(channels?.pruneInactiveChannelAccountState
      ? { pruneInactiveChannelAccountState: channels.pruneInactiveChannelAccountState }
      : {}),
    ...(reloadPlugins ? { reloadPlugins } : {}),
    getChannelAutostartSuppression: options?.getChannelAutostartSuppression,
    stopPostReadySidecars,
    logChannels,
    logCron,
    logReload,
    cronReconciliation,
    requestRecoveryRestart:
      typeof recovery === "function"
        ? recovery
        : recovery
          ? requestGatewayRestartWithSignalAdmission
          : null,
    ...(typeof recovery === "boolean" ? { restartRecoveryAvailable: recovery } : {}),
  });
  return {
    ...handlers,
    cron,
    cronReconciliation,
    heartbeatRunner,
    logChannels,
    logCron,
    reconcileHeartbeatJobs,
    setState,
  };
}

function createManagedRestartSequenceHarness(
  options: { invalidateGenerationOnReconcile?: boolean } = {},
) {
  const initialConfig = {
    gateway: {
      port: 18789,
      reload: {},
      terminal: { enabled: true },
    },
  } as OpenClawConfig;
  setRuntimeConfigSnapshot(initialConfig, initialConfig);
  activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
  const deferredConfig = {
    gateway: {
      port: 18790,
      reload: {},
      terminal: { enabled: true },
      auth: {
        mode: "token",
        token: {
          source: "env",
          provider: "default",
          id: "RESTART_A_TOKEN",
        },
      },
    },
  } as OpenClawConfig;
  const invalidConfig = {
    gateway: {
      ...deferredConfig.gateway,
      auth: {
        mode: "token",
        token: {
          source: "env",
          provider: "default",
          id: "MISSING_RESTART_TOKEN",
        },
      },
      terminal: { enabled: false },
    },
  } as OpenClawConfig;
  const missingHotSecret = {
    source: "env" as const,
    provider: "default",
    id: "MISSING_HOT_TOKEN",
  };
  const invalidHotConfig = {
    ...deferredConfig,
    models: {
      providers: {
        test: {
          baseUrl: "https://example.com",
          apiKey: missingHotSecret,
          models: [],
        },
      },
    },
  } as OpenClawConfig;
  const invalidNoopConfig = {
    ...deferredConfig,
    plugins: {
      entries: {
        brave: {
          config: { webSearch: { apiKey: missingHotSecret } },
        },
      },
    },
  } as OpenClawConfig;
  const replacementConfig = {
    gateway: {
      ...deferredConfig.gateway,
      bind: "lan",
    },
  } as OpenClawConfig;
  const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
  const writeListenerRef = createConfigWriteListenerRef();
  let snapshotConfig = initialConfig;
  let snapshotHash = "initial";
  const unavailableSecretIds = new Set(["MISSING_RESTART_TOKEN", "MISSING_HOT_TOKEN"]);
  let recordPromotion: ((hash: string) => void) | undefined;
  let recordReloadError: ((message: string) => void) | undefined;
  const nextPromotion = () =>
    new Promise<string>((resolve) => {
      recordPromotion = resolve;
    });
  const nextReloadError = () =>
    new Promise<string>((resolve) => {
      recordReloadError = resolve;
    });
  const promoteSnapshot = vi.fn(async (snapshot: { hash?: string }) => {
    recordPromotion?.(snapshot.hash ?? "");
    recordPromotion = undefined;
    return true;
  });
  const logReload = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((message: string) => {
      recordReloadError?.(message);
      recordReloadError = undefined;
    }),
  };
  const { activateRuntimeSecrets, prepareRuntimeSecretsSnapshot } =
    createTestRuntimeSecretsActivator(async ({ config }) => {
      const secretInputs = [
        config.gateway?.auth?.token,
        config.models?.providers?.test?.apiKey,
        (config.plugins?.entries?.brave?.config as { webSearch?: { apiKey?: unknown } } | undefined)
          ?.webSearch?.apiKey,
      ];
      for (const secretInput of secretInputs) {
        if (
          typeof secretInput === "object" &&
          secretInput !== null &&
          "id" in secretInput &&
          typeof secretInput.id === "string" &&
          unavailableSecretIds.has(secretInput.id)
        ) {
          throw new Error(`required SecretRef ${secretInput.id} is unavailable`);
        }
      }
      return makePreparedSecretsSnapshot(config);
    });
  const requestRecoveryRestart = vi.fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>(
    () => ({ status: "emitted" }),
  );
  const sharedGatewaySessionGenerationState = { current: undefined, required: null };
  let generationInvalidated = false;
  const reloader = startManagedGatewayConfigReloader({
    initialConfig,
    readSnapshot: vi.fn(async () =>
      createValidConfigSnapshot(snapshotConfig, snapshotHash),
    ) as never,
    promoteSnapshot: promoteSnapshot as never,
    subscribeToWrites: captureConfigWriteListener(writeListenerRef),
    logReload,
    activateRuntimeSecrets,
    prepareTerminalConfig: (plan, nextConfig) => {
      terminalPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
    },
    reconcileTerminalSessions: vi.fn(() => {
      if (options.invalidateGenerationOnReconcile && !generationInvalidated) {
        generationInvalidated = true;
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: sharedGatewaySessionGenerationState,
          nextConfig: {},
          resolveRuntimeSnapshotGeneration: () => "concurrent-generation",
          clients: [],
        });
      }
    }),
    commitTerminalConfig: terminalPolicy.commitConfig,
    acceptTerminalConfig: terminalPolicy.acceptConfig,
    sharedGatewaySessionGenerationState,
    requestRecoveryRestart,
  });
  const writeConfig = (
    config: OpenClawConfig,
    hash: string,
    revision: number,
    runtimeConfig: OpenClawConfig = config,
  ) => {
    const listener = writeListenerRef.current;
    if (!listener) {
      throw new Error("Expected config write listener to be registered");
    }
    snapshotConfig = config;
    snapshotHash = hash;
    listener(
      createConfigWriteNotification(config, hash, revision, `runtime-${hash}`, `source-${hash}`, {
        runtimeConfig,
      }),
    );
  };

  return {
    prepareRuntimeSecretsSnapshot,
    assertRestartReady: hoisted.assertOpenClawDatabasesReady,
    deferredConfig,
    initialConfig,
    invalidConfig,
    invalidHotConfig,
    invalidNoopConfig,
    logReload,
    nextPromotion,
    nextReloadError,
    promoteSnapshot,
    reloader,
    replacementConfig,
    requestRecoveryRestart,
    sharedGatewaySessionGenerationState,
    terminalPolicy,
    setSecretAvailable: (id: string) => unavailableSecretIds.delete(id),
    setSecretUnavailable: (id: string) => unavailableSecretIds.add(id),
    writeConfig,
  };
}

async function withGatewayRestartSignal(
  run: (signalSpy: ReturnType<typeof vi.fn>) => Promise<void>,
) {
  restartTesting.resetSigusr1State();
  resetGatewayWorkAdmission();
  const signalSpy = vi.fn();
  process.once("SIGUSR1", signalSpy);
  try {
    await run(signalSpy);
  } finally {
    process.removeListener("SIGUSR1", signalSpy);
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
  }
}

// Other gateway test helpers (test-helpers.mocks.ts, test-helpers.server.ts)
// set OPENCLAW_SKIP_CHANNELS / OPENCLAW_SKIP_PROVIDERS at module load. When a
// shared vitest worker imports those helpers before this file runs, the leaked
// env routes reloads into the skip branch and channel restarts never fire.
const testGatewayRestartListener = () => {};
let pluginRegistrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(() => {
  pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
  stageActivePluginRegistry(createTestRegistry([]), null, "default");
  process.on("SIGUSR1", testGatewayRestartListener);
  resetGatewayWorkAdmission();
  resetProcessRegistryForTests();
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
  hoisted.resetSkillSnapshotConfigFingerprintCache.mockClear();
  hoisted.applyLoggingConfig.mockClear();
});

afterEach(() => {
  restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
  process.removeListener("SIGUSR1", testGatewayRestartListener);
  setGatewaySigusr1RestartPolicy({ allowExternal: false });
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  resetProcessRegistryForTests();
  hoisted.startGmailWatcherWithLogs.mockClear();
  hoisted.stopGmailWatcher.mockClear();
  hoisted.activeTaskCount.value = 0;
  hoisted.activeTaskBlockers.length = 0;
  hoisted.activeEmbeddedRunCount.value = 0;
  hoisted.activeEmbeddedRunSessionIds.length = 0;
  hoisted.activeEmbeddedRunSessionKeys.length = 0;
  hoisted.markRestartAbortedMainSessions.mockClear();
  hoisted.runtimeConfig.value = { session: { store: "/tmp/active-sessions.json" } };
  hoisted.assertOpenClawDatabasesReady.mockClear();
  hoisted.reloadEvents.length = 0;
  hoisted.advancePreparedModelRuntimeConfig.mockClear();
  hoisted.markPreparedModelRuntimeSnapshotsStale.mockClear();
  hoisted.rejectPendingPreparedModelRuntimeReplacement.mockClear();
  hoisted.refreshPreparedModelRuntimeSnapshots.mockClear();
  hoisted.refreshContextWindowCache.mockClear();
  hoisted.clearCurrentProviderAuthState.mockClear();
  hoisted.warmCurrentProviderAuthStateOffMainThread.mockClear();
  hoisted.disposeAllSessionMcpRuntimes.mockClear();
  hoisted.disposeAllSessionMcpRuntimes.mockResolvedValue(undefined);
  hoisted.buildGatewayCronService.mockClear();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function runManagedOwnershipScenario(params: {
  kind: "noop" | "hot" | "restart";
  getPluginMetadata?: ManagedReloaderParams["getPluginMetadata"];
  loggingChanged?: boolean;
  queueRevert: boolean;
  secretProviderChanged?: boolean;
  sharedAuthRotation?: boolean;
  /** Makes secrets activation resolve to a different object than it received. */
  resolveToDistinctConfig?: boolean;
}) {
  const auth = params.sharedAuthRotation
    ? {
        mode: "token" as const,
        token: { source: "file" as const, provider: "default", id: "/token" },
      }
    : undefined;
  const initialConfig = {
    gateway: {
      reload: { mode: params.sharedAuthRotation ? ("hot" as const) : ("off" as const) },
      ...(auth ? { auth } : {}),
    },
    ...(params.secretProviderChanged
      ? { secrets: { providers: { default: { source: "file" as const, path: "/old" } } } }
      : {}),
    hooks: { enabled: true, token: "test-token", path: "/old" },
  } satisfies OpenClawConfig;
  const configA = {
    gateway: {
      reload: {
        mode: params.kind === "restart" ? ("restart" as const) : ("hot" as const),
      },
      ...(auth ? { auth } : {}),
    },
    hooks: {
      enabled: true,
      token: "test-token",
      path: params.kind === "noop" ? "/old" : "/a",
    },
    ...(params.kind === "noop" && !params.sharedAuthRotation
      ? { talk: { realtime: { instructions: "updated instructions" } } }
      : {}),
    ...(params.secretProviderChanged
      ? { secrets: { providers: { default: { source: "file" as const, path: "/new" } } } }
      : {}),
    ...(params.loggingChanged ? { logging: { level: "debug" as const } } : {}),
  } satisfies OpenClawConfig;
  const configB = structuredClone(initialConfig);
  const snapshot = (config: OpenClawConfig) => makePreparedSecretsSnapshot(config);
  const writeListenerRef = createConfigWriteListenerRef();
  let resolveAccepted: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => {
    resolveAccepted = resolve;
  });
  const acceptTerminalConfig = vi.fn(() => resolveAccepted?.());
  const commitTerminalConfig = vi.fn();
  const prepareTerminalConfig = vi.fn();
  const reconcileTerminalSessions = vi.fn();
  const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
  let queuedB = false;
  const resolvedConfigs: OpenClawConfig[] = [];
  const { activateRuntimeSecrets, prepareRuntimeSecretsSnapshot } =
    createTestRuntimeSecretsActivator(async ({ config }) => {
      if (params.queueRevert && !queuedB) {
        queuedB = true;
        writeListenerRef.current?.(
          createConfigWriteNotification(configB, "hash-b", 2, "runtime-b", "source-b"),
        );
      }
      if (!params.resolveToDistinctConfig && !params.sharedAuthRotation) {
        return snapshot(config);
      }
      // Real secret resolution returns a NEW config object. Returning the input
      // unchanged is what let a rebuild against the source candidate look correct.
      const resolved: OpenClawConfig = {
        ...config,
        ...(params.sharedAuthRotation
          ? { gateway: { ...config.gateway, auth: { mode: "token", token: "new-shared-token" } } }
          : {}),
      };
      resolvedConfigs.push(resolved);
      return makePreparedSecretsSnapshot(config, { config: resolved });
    });
  const initialRuntimeConfig: OpenClawConfig = params.sharedAuthRotation
    ? {
        ...initialConfig,
        gateway: { ...initialConfig.gateway, auth: { mode: "token", token: "old-shared-token" } },
      }
    : initialConfig;
  const generation = (token: string | undefined) =>
    resolveSharedGatewaySessionGeneration({ mode: "token", token, allowTailscale: false });
  const sharedState = {
    current: generation(params.sharedAuthRotation ? "old-shared-token" : undefined),
    required: null,
  };
  const staleClose = vi.fn();
  const currentClose = vi.fn();
  const nonSharedClose = vi.fn();
  const startChannel = vi.fn(async () => {});
  const stopChannel = vi.fn(async () => {});
  const setState = vi.fn();
  const reloadPlugins = vi.fn(async () => makePluginReloadResult());
  activateSecretsRuntimeSnapshot(
    makePreparedSecretsSnapshot(initialConfig, { config: initialRuntimeConfig }),
  );
  const reloader = startManagedGatewayConfigReloader({
    initialConfig: initialRuntimeConfig,
    initialCompareConfig: initialConfig,
    startChannel,
    stopChannel,
    setState,
    reloadPlugins,
    sharedGatewaySessionGenerationState: sharedState,
    resolveSharedGatewaySessionGenerationForConfig: (config) =>
      generation(
        typeof config.gateway?.auth?.token === "string" ? config.gateway.auth.token : undefined,
      ),
    clients: params.sharedAuthRotation
      ? [
          {
            usesSharedGatewayAuth: true,
            sharedGatewaySessionGeneration: generation("old-shared-token"),
            socket: { close: staleClose },
          },
          {
            usesSharedGatewayAuth: true,
            sharedGatewaySessionGeneration: generation("new-shared-token"),
            socket: { close: currentClose },
          },
          {
            usesSharedGatewayAuth: false,
            sharedGatewaySessionGeneration: generation("old-shared-token"),
            socket: { close: nonSharedClose },
          },
        ]
      : [],
    getPluginMetadata: params.getPluginMetadata,
    readSnapshot: vi.fn(async () => createValidConfigSnapshot(configB, "hash-b")) as never,
    subscribeToWrites: captureConfigWriteListener(writeListenerRef, false),
    activateRuntimeSecrets,
    prepareTerminalConfig,
    reconcileTerminalSessions,
    commitTerminalConfig,
    acceptTerminalConfig,
    requestRecoveryRestart,
  });
  writeListenerRef.current?.(
    createConfigWriteNotification(configA, "hash-a", 1, "runtime-a", "source-a"),
  );
  try {
    await accepted;
    return {
      acceptTerminalConfig,
      prepareRuntimeSecretsSnapshot,
      commitTerminalConfig,
      configA,
      configB,
      prepareTerminalConfig,
      resolvedConfigs,
      reconcileTerminalSessions,
      requestRecoveryRestart,
      sharedState,
      expectedGeneration: generation("new-shared-token"),
      staleClose,
      currentClose,
      nonSharedClose,
      startChannel,
      stopChannel,
      setState,
      reloadPlugins,
    };
  } finally {
    await reloader.stop();
  }
}

async function withManagedChannelSecretFixture(
  options: {
    shape?: "named" | "default" | "shared";
    accountScopedRestart?: boolean;
  },
  run: (fixture: {
    initialSource: OpenClawConfig;
    nextSource: (providerPath: string, hot?: boolean) => OpenClawConfig;
    oldPath: string;
    newPath: string;
    missingPath: string;
    starts: Array<{ accountId: string; token: unknown }>;
    stops: string[];
    manager: ReturnType<typeof createChannelManager>;
    write: (config: OpenClawConfig) => Promise<RuntimeConfigWriteApplicationStatus>;
    failStop: () => void;
    failStart: () => void;
    recoverDuringPreparation: () => void;
    prepareCount: () => number;
    commitTerminalConfig: ReturnType<typeof vi.fn>;
    requestRecoveryRestart: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  const fixtureDir = fs.realpathSync(autoCleanupTempDirs.make("openclaw-channel-secret-reload-"));
  const oldPath = path.join(fixtureDir, "old.json");
  const newPath = path.join(fixtureDir, "next.json");
  const missingPath = path.join(fixtureDir, "missing.json");
  const writeToken = (file: string, token: string) =>
    fs.writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
  writeToken(oldPath, "old-channel-token");
  writeToken(newPath, "new-channel-token");
  const ref = { source: "file" as const, provider: "channel", id: "/token" };
  const shape = options.shape ?? "named";
  const initialSource: OpenClawConfig = {
    gateway: { reload: { mode: "hot" } },
    secrets: { providers: { channel: { source: "file", path: oldPath, mode: "json" } } },
    channels: {
      mattermost:
        shape === "shared"
          ? { botToken: ref, accounts: { root: {}, ada: {}, other: { botToken: "independent" } } }
          : shape === "default"
            ? { accounts: { default: { botToken: ref }, ada: { botToken: "independent" } } }
            : { accounts: { root: { botToken: "independent" }, ada: { botToken: ref } } },
    },
  };
  const readChannel = (config: OpenClawConfig) => {
    const channel = config.channels?.mattermost;
    if (!isRecord(channel) || !isRecord(channel.accounts)) {
      throw new Error("Expected channel-account fixture");
    }
    return { channel, accounts: channel.accounts };
  };
  const starts: Array<{ accountId: string; token: unknown }> = [];
  const stops: string[] = [];
  let rejectStop = false;
  let rejectStart = false;
  const plugin: ChannelPlugin<{ accountId: string; botToken: unknown; enabled: boolean }> = {
    ...createChannelTestPluginBase({ id: "mattermost" }),
    reload: {
      configPrefixes: ["channels.mattermost"],
      accountScopedRestart: options.accountScopedRestart ?? true,
    },
    config: {
      listAccountIds: (config) => Object.keys(readChannel(config).accounts),
      resolveAccount: (config, requestedAccountId) => {
        const accountId = requestedAccountId ?? "default";
        const { channel, accounts } = readChannel(config);
        // Teardown can still address a just-removed lifetime.
        const value = accounts[accountId];
        const account = isRecord(value) ? value : {};
        return {
          accountId,
          botToken: account.botToken ?? channel.botToken,
          enabled: channel.enabled !== false && account.enabled !== false,
        };
      },
      isConfigured: (account) => {
        if (rejectStart && account.accountId === "ada") {
          throw new Error("replacement start failed");
        }
        return typeof account.botToken === "string";
      },
    },
    gateway: {
      stopAccount: async () => {
        if (rejectStop) {
          throw new Error("account teardown failed");
        }
      },
      startAccount: async ({ accountId, account, abortSignal }) => {
        starts.push({ accountId, token: account.botToken });
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
          } else {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        stops.push(accountId);
      },
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "mattermost", plugin, source: "test" }]));
  const contract = createSimpleChannelSecretContract({
    channelKey: "mattermost",
    label: "Fixture",
    accountFields: ["botToken"],
    channelFields: ["botToken"],
    mode: "account-inheritance",
  });
  const prepare = async (sourceConfig: OpenClawConfig) => {
    const config = structuredClone(sourceConfig);
    const context = createResolverContext({ sourceConfig, env: {} });
    contract.collectRuntimeConfigAssignments({ config, context });
    const resolution = await resolveAndApplySecretAssignments({
      assignments: context.assignments,
      context,
      options: { config: sourceConfig, env: {}, cache: context.cache },
      allowOwnerIsolation: true,
    });
    return makePreparedSecretsSnapshot(sourceConfig, {
      config,
      warnings: context.warnings,
      degradedOwners: resolution.degradedOwners,
      secretOwners: listSecretAssignmentOwners(context.assignments, resolution.resolvedValues),
    });
  };
  const initialSnapshot = await prepare(initialSource);
  activateSecretsRuntimeSnapshot(initialSnapshot);
  const manager = createChannelManager({
    getRuntimeConfig: () => getActiveSecretsRuntimeSnapshot()?.config ?? initialSnapshot.config,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  await manager.startChannel("mattermost");
  starts.length = 0;
  let recoverNextPreparation = false;
  let preparationCount = 0;
  const { activateRuntimeSecrets } = createTestRuntimeSecretsActivator(async ({ config }) => {
    preparationCount += 1;
    return await prepare(config);
  });
  const activatePreparedSnapshotIfCurrent =
    activateRuntimeSecrets.activatePreparedSnapshotIfCurrent;
  vi.spyOn(activateRuntimeSecrets, "activatePreparedSnapshotIfCurrent").mockImplementation(
    async (...args) => {
      if (recoverNextPreparation) {
        recoverNextPreparation = false;
        writeToken(missingPath, "old-channel-token");
        activateSecretsRuntimeSnapshot(await prepare(initialSource));
        return null;
      }
      return await activatePreparedSnapshotIfCurrent(...args);
    },
  );
  const writeListenerRef = createConfigWriteListenerRef();
  const commitTerminalConfig = vi.fn();
  const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
  let currentSource = initialSource;
  let revision = 0;
  const reloader = startManagedGatewayConfigReloader({
    initialConfig: initialSnapshot.config,
    initialCompareConfig: initialSource,
    readSnapshot: vi.fn(async () =>
      createValidConfigSnapshot(currentSource, `hash-${revision}`),
    ) as never,
    subscribeToWrites: captureConfigWriteListener(writeListenerRef),
    channelManager: manager,
    startChannel: manager.startChannel,
    stopChannel: manager.stopChannel,
    activateRuntimeSecrets,
    commitTerminalConfig,
    requestRecoveryRestart,
  });
  try {
    await run({
      initialSource,
      nextSource: (providerPath, hot = false) =>
        structuredClone({
          ...initialSource,
          secrets: {
            providers: {
              channel: { source: "file" as const, path: providerPath, mode: "json" as const },
            },
          },
          ...(hot ? { tools: { elevated: { enabled: false } } } : {}),
        }),
      oldPath,
      newPath,
      missingPath,
      starts,
      stops,
      manager,
      write: async (config) => {
        currentSource = config;
        revision += 1;
        const application = createRuntimeConfigWriteApplication();
        const notification = createConfigWriteNotification(
          config,
          `hash-${revision}`,
          revision,
          `runtime-${revision}`,
          `source-${revision}`,
        );
        if (!writeListenerRef.current) {
          throw new Error("Expected managed config writer");
        }
        writeListenerRef.current(attachRuntimeConfigWriteApplication(notification, application));
        return await application.result;
      },
      failStop: () => {
        rejectStop = true;
      },
      failStart: () => {
        rejectStart = true;
      },
      recoverDuringPreparation: () => {
        recoverNextPreparation = true;
      },
      prepareCount: () => preparationCount,
      commitTerminalConfig,
      requestRecoveryRestart,
    });
  } finally {
    await reloader.stop();
    rejectStop = false;
    await manager.stopChannel("mattermost");
  }
}

describe("managed channel credential publication", () => {
  it.each([
    { mode: "noop", cold: false },
    { mode: "hot", cold: false },
    { mode: "noop", cold: true },
    { mode: "hot", cold: true },
  ] as const)(
    "$mode provider rotation reconciles only Ada (cold=$cold)",
    async ({ mode, cold }) => {
      await withManagedChannelSecretFixture({}, async (fixture) => {
        const next = fixture.nextSource(
          cold ? fixture.missingPath : fixture.newPath,
          mode === "hot",
        );
        expect(await fixture.write(next)).toBe("applied");
        expect(fixture.stops).toEqual(["ada"]);
        expect(fixture.starts).toEqual(
          cold ? [] : [{ accountId: "ada", token: "new-channel-token" }],
        );
        const accounts = fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost;
        expect(accounts?.root?.running).toBe(true);
        expect(accounts?.ada?.running).toBe(!cold);
        expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(next);
        expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
        expect(fixture.commitTerminalConfig).toHaveBeenCalledOnce();
        if (cold) {
          expect(listActiveDegradedSecretOwners()).toContainEqual(
            expect.objectContaining({ ownerId: "mattermost:ada", degradationState: "cold" }),
          );
          await expect(
            fixture.manager.startChannelAccountForRecovery("mattermost", "ada", {
              preserveManualStop: true,
              skipUnavailableAccounts: true,
            }),
          ).resolves.toEqual({ status: "skipped", reason: "secret-unavailable" });
          await expect(
            fixture.manager.startChannel("mattermost", "ada", { manual: true }),
          ).rejects.toMatchObject({
            code: "SECRET_SURFACE_UNAVAILABLE",
            ownerId: "mattermost:ada",
          });
        }
      });
    },
  );

  it.each(["noop", "hot"] as const)("keeps unchanged LKG during a %s edit", async (mode) => {
    await withManagedChannelSecretFixture({}, async (fixture) => {
      fs.unlinkSync(fixture.oldPath);
      const next = {
        ...fixture.nextSource(fixture.oldPath, mode === "hot"),
        logging: { level: "debug" as const },
      };
      expect(await fixture.write(next)).toBe("applied");
      expect(fixture.stops).toEqual([]);
      expect(fixture.starts).toEqual([]);
      expect(listActiveDegradedSecretOwners()).toContainEqual(
        expect.objectContaining({ ownerId: "mattermost:ada", degradationState: "stale" }),
      );
      expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost?.ada?.running).toBe(
        true,
      );
      expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(fixture.commitTerminalConfig).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { shape: "named", accountScopedRestart: false, ids: ["ada", "root"] },
    { shape: "default", accountScopedRestart: true, ids: ["ada", "default"] },
    { shape: "shared", accountScopedRestart: true, ids: ["ada", "other", "root"] },
  ] as const)(
    "preserves whole-channel contract for $shape (opt-in=$accountScopedRestart)",
    async (entry) => {
      await withManagedChannelSecretFixture(entry, async (fixture) => {
        expect(await fixture.write(fixture.nextSource(fixture.newPath))).toBe("applied");
        expect(fixture.stops.toSorted()).toEqual(entry.ids);
        expect(fixture.starts.map(({ accountId }) => accountId).toSorted()).toEqual(entry.ids);
        expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
      });
    },
  );

  it("leaves cold accounts stopped during a whole-channel replacement", async () => {
    await withManagedChannelSecretFixture({ accountScopedRestart: false }, async (fixture) => {
      expect(await fixture.write(fixture.nextSource(fixture.missingPath))).toBe("applied");
      expect(fixture.stops.toSorted()).toEqual(["ada", "root"]);
      expect(fixture.starts).toEqual([{ accountId: "root", token: "independent" }]);
      expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost?.ada?.running).toBe(
        false,
      );
      expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
    });
  });

  it("prunes a removed account when its surviving sibling becomes cold", async () => {
    await withManagedChannelSecretFixture({}, async (fixture) => {
      const next = fixture.nextSource(fixture.missingPath);
      const channel = next.channels?.mattermost;
      if (!isRecord(channel) || !isRecord(channel.accounts)) {
        throw new Error("Expected account fixture");
      }
      delete channel.accounts.root;
      expect(await fixture.write(next)).toBe("applied");
      expect(fixture.stops.toSorted()).toEqual(["ada", "root"]);
      expect(fixture.starts).toEqual([]);
      expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost).not.toHaveProperty(
        "root",
      );
      expect(fixture.manager.resolveRuntimeAccountId("mattermost", "root")).toBeUndefined();
      expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
    });
  });

  it("does not resume a manual stop when the provider recovers", async () => {
    await withManagedChannelSecretFixture({}, async (fixture) => {
      await fixture.manager.stopChannel("mattermost", "ada");
      fixture.stops.length = 0;
      expect(await fixture.write(fixture.nextSource(fixture.newPath))).toBe("applied");
      expect(fixture.starts).toEqual([]);
      expect(fixture.stops).toEqual([]);
      expect(fixture.manager.isManuallyStopped("mattermost", "ada")).toBe(true);
      expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost?.root?.running).toBe(
        true,
      );
    });
  });

  it.each([false, true])(
    "recovers a cold account without undoing a manual stop (%s)",
    async (manualStop) => {
      await withManagedChannelSecretFixture({}, async (fixture) => {
        expect(await fixture.write(fixture.nextSource(fixture.missingPath))).toBe("applied");
        expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost?.ada?.running).toBe(
          false,
        );
        if (manualStop) {
          await fixture.manager.stopChannel("mattermost", "ada");
        }
        fixture.stops.length = 0;
        fixture.starts.length = 0;
        expect(await fixture.write(fixture.nextSource(fixture.newPath))).toBe("applied");
        expect(fixture.stops).toEqual([]);
        expect(fixture.starts).toEqual(
          manualStop ? [] : [{ accountId: "ada", token: "new-channel-token" }],
        );
        expect(fixture.manager.getRuntimeSnapshot().channelAccounts.mattermost?.root?.running).toBe(
          true,
        );
        expect(fixture.manager.isManuallyStopped("mattermost", "ada")).toBe(manualStop);
        expect(listActiveDegradedSecretOwners()).toEqual([]);
        expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
      });
    },
  );

  it("rebuilds targets after a cold preparation loses its snapshot revision", async () => {
    await withManagedChannelSecretFixture({}, async (fixture) => {
      fixture.recoverDuringPreparation();
      expect(await fixture.write(fixture.nextSource(fixture.missingPath))).toBe("applied");
      expect(fixture.prepareCount()).toBe(2);
      expect(fixture.stops).toEqual([]);
      expect(fixture.starts).toEqual([]);
      expect(listActiveDegradedSecretOwners()).toEqual([]);
      expect(fixture.commitTerminalConfig).toHaveBeenCalledOnce();
    });
  });

  it.each(["stop", "start"] as const)(
    "reports promoted no-op %s failure as recovery-required",
    async (failure) => {
      await withManagedChannelSecretFixture({}, async (fixture) => {
        if (failure === "stop") {
          fixture.failStop();
        } else {
          fixture.failStart();
        }
        const providerPath = failure === "stop" ? fixture.missingPath : fixture.newPath;
        expect(await fixture.write(fixture.nextSource(providerPath))).toBe(
          "applied-restart-required",
        );
        // Restart emission follows asynchronous secret preflight, after the write receipt.
        await waitForFast(() => expect(fixture.requestRecoveryRestart).toHaveBeenCalledOnce());
        expect(fixture.commitTerminalConfig).toHaveBeenCalledOnce();
      });
    },
  );
});

describe("managed reload transaction ownership", () => {
  it.each(["converged", "retry-scheduled", "failed", "superseded", "committed-recovery"] as const)(
    "keeps serving config and metadata together while managed cron reconciliation is pending (%s)",
    async (outcome) => {
      const fixtureDir = autoCleanupTempDirs.make("openclaw-managed-reload-publication-");
      const configPath = path.join(fixtureDir, "openclaw.json");
      const configFor = (generation: string): OpenClawConfig => ({
        gateway: { auth: { mode: "none" }, reload: { mode: "hot" } },
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: { workspace: path.join(fixtureDir, generation) } },
        },
        cron: { enabled: false },
        plugins: { enabled: false, slots: { memory: "none" } },
      });
      const initialConfig = configFor("a");
      const configB = configFor("b");
      const configC = configFor("c");
      const enteredB = createDeferred();
      const enteredC = createDeferred();
      const reconcileB = createDeferred<"converged" | "retry-scheduled">();
      const reconcileC = createDeferred<"converged">();
      const owner = createPluginMetadataOwner();
      const writeListenerRef = createConfigWriteListenerRef();
      const reconcileTerminalSessions = vi.fn();
      const commitTerminalConfig = vi.fn();
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      let snapshotConfig = initialConfig;
      let snapshotHash = "initial";
      let database: ReturnType<typeof openOpenClawStateDatabase> | undefined;
      let reloader: ReturnType<typeof startManagedGatewayConfigReloader> | undefined;
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureDir);

      try {
        // Startup initializes the canonical store before preparing process metadata.
        database = openOpenClawStateDatabase();
        const activateRuntimeSecrets = createRuntimeSecretsActivator({
          logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          emitStateEvent: vi.fn(),
          prepareRuntimeSecretsSnapshot: async ({ config }) =>
            makePreparedSecretsSnapshot(config, { config: structuredClone(config) }),
          activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
        });
        await activateRuntimeSecrets(initialConfig, { reason: "startup", activate: true });
        const runtimeA = getRuntimeConfigSnapshot();
        if (!runtimeA) {
          throw new Error("expected the real startup config snapshot");
        }
        const metadataA = owner.prepare({ config: initialConfig });
        owner.publish(metadataA, { config: runtimeA, sourceConfig: initialConfig });
        const state = createDefaultGatewayReloadState();
        state.cronState.reconcileHeartbeatJobs = vi.fn<GatewayCronState["reconcileHeartbeatJobs"]>(
          async (candidate) => {
            if (!candidate) {
              throw new Error("expected managed candidate config");
            }
            if (
              candidate.config.agents?.entries?.main?.workspace ===
              configB.agents?.entries?.main?.workspace
            ) {
              enteredB.resolve();
              return await reconcileB.promise;
            }
            enteredC.resolve();
            return await reconcileC.promise;
          },
        );
        if (outcome === "committed-recovery") {
          hoisted.refreshContextWindowCache.mockRejectedValueOnce(
            new Error("context refresh failed"),
          );
        }
        reloader = startManagedGatewayConfigReloader({
          initialConfig: runtimeA,
          initialCompareConfig: initialConfig,
          initialAuthoredConfig: initialConfig,
          initialSnapshotRawHash: snapshotHash,
          watchPath: configPath,
          pluginMetadataOwner: owner,
          getPluginMetadata: owner.getActive,
          prepareConfigCandidate: ({ runtimeConfig, sourceConfig }) => ({
            runtimeConfig,
            compareConfig: sourceConfig,
            pluginMetadata: owner.prepare({ config: runtimeConfig }),
          }),
          readSnapshot: async () => ({
            ...createValidConfigSnapshot(snapshotConfig, snapshotHash),
            path: configPath,
            parsed: snapshotConfig,
            raw: JSON.stringify(snapshotConfig),
          }),
          subscribeToWrites: captureConfigWriteListener(writeListenerRef),
          activateRuntimeSecrets,
          getState: () => state,
          reconcileTerminalSessions,
          commitTerminalConfig,
          requestRecoveryRestart,
        });
        const writeConfig = (config: OpenClawConfig, hash: string, revision: number) => {
          const listener = writeListenerRef.current;
          if (!listener) {
            throw new Error("expected the managed config write listener");
          }
          snapshotConfig = config;
          snapshotHash = hash;
          const application = createRuntimeConfigWriteApplication();
          listener(
            attachRuntimeConfigWriteApplication(
              createConfigWriteNotification(
                config,
                hash,
                revision,
                `runtime-${hash}`,
                `source-${hash}`,
                {
                  configPath,
                },
              ),
              application,
            ),
          );
          expect(application.claimed).toBe(true);
          return application;
        };
        const applicationB = writeConfig(configB, "candidate-b", 1);
        const settledB = vi.fn();
        void applicationB.result.then(settledB);
        await Promise.race([
          enteredB.promise,
          applicationB.result.then((status) => {
            throw new Error(`managed reload settled ${status} before monitor reconciliation`);
          }),
        ]);

        // Read the actual serving slot, not this suite's hoisted config facade mock.
        expect(getRuntimeConfigSnapshot()).toBe(runtimeA);
        expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(initialConfig);
        expect(owner.getActive()).toBe(metadataA);
        expect(getCurrentPluginMetadataSnapshot({ allowWorkspaceScopedSnapshot: true })).toBe(
          metadataA.selectedSnapshot,
        );
        expect(settledB).not.toHaveBeenCalled();
        expect(state.heartbeatRunner.updateConfig).not.toHaveBeenCalled();
        expect(reconcileTerminalSessions).not.toHaveBeenCalled();
        expect(commitTerminalConfig).not.toHaveBeenCalled();

        let expectedConfig = configB;
        if (outcome === "superseded") {
          const applicationC = writeConfig(configC, "candidate-c", 2);
          reconcileB.resolve("converged");
          await expect(applicationB.result).resolves.toBe("superseded");
          await Promise.race([
            enteredC.promise,
            applicationC.result.then((status) => {
              throw new Error(`replacement reload settled ${status} before monitor reconciliation`);
            }),
          ]);
          expect(getRuntimeConfigSnapshot()).toBe(runtimeA);
          expect(owner.getActive()).toBe(metadataA);
          expect(reconcileTerminalSessions).not.toHaveBeenCalled();
          reconcileC.resolve("converged");
          await expect(applicationC.result).resolves.toBe("applied");
          expectedConfig = configC;
        } else {
          if (outcome === "failed") {
            reconcileB.reject(new Error("monitor reconciliation failed"));
          } else {
            reconcileB.resolve(outcome === "retry-scheduled" ? "retry-scheduled" : "converged");
          }
          await expect(applicationB.result).resolves.toBe(
            outcome === "failed" || outcome === "retry-scheduled"
              ? "failed"
              : outcome === "committed-recovery"
                ? "applied-restart-required"
                : "applied",
          );
        }

        if (outcome === "failed" || outcome === "retry-scheduled") {
          expect(getRuntimeConfigSnapshot()).toBe(runtimeA);
          expect(owner.getActive()).toBe(metadataA);
          expect(state.heartbeatRunner.updateConfig).not.toHaveBeenCalled();
          expect(reconcileTerminalSessions).not.toHaveBeenCalled();
          expect(commitTerminalConfig).not.toHaveBeenCalled();
        } else {
          expect(getRuntimeConfigSnapshot()).toEqual(expectedConfig);
          expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(expectedConfig);
          const activeMetadata = owner.getActive();
          expect(activeMetadata).not.toBe(metadataA);
          expect(activeMetadata?.selectedSnapshot.workspaceDir).toBe(
            expectedConfig.agents?.entries?.main?.workspace,
          );
          expect(getCurrentPluginMetadataSnapshot({ allowWorkspaceScopedSnapshot: true })).toBe(
            activeMetadata?.selectedSnapshot,
          );
          expect(state.heartbeatRunner.updateConfig).toHaveBeenCalledExactlyOnceWith(
            expectedConfig,
          );
          expect(reconcileTerminalSessions).toHaveBeenCalledOnce();
          expect(commitTerminalConfig).toHaveBeenCalledExactlyOnceWith(expectedConfig);
        }
        if (outcome === "committed-recovery") {
          await waitForFast(() => expect(requestRecoveryRestart).toHaveBeenCalledOnce());
        }
        expect(requestRecoveryRestart).toHaveBeenCalledTimes(
          outcome === "committed-recovery" ? 1 : 0,
        );
      } finally {
        reconcileB.resolve("converged");
        reconcileC.resolve("converged");
        await reloader?.stop();
        owner.dispose();
        if (database) {
          closeOpenClawStateDatabaseByPath(database.path);
        }
        vi.unstubAllEnvs();
      }
    },
  );

  it("rotates shared auth on a provider-only no-op without replacing services", async () => {
    const result = await runManagedOwnershipScenario({
      kind: "noop",
      queueRevert: false,
      secretProviderChanged: true,
      sharedAuthRotation: true,
    });
    expect(result.staleClose).toHaveBeenCalledExactlyOnceWith(4001, "gateway auth changed");
    expect(result.currentClose).not.toHaveBeenCalled();
    expect(result.nonSharedClose).not.toHaveBeenCalled();
    expect(result.sharedState).toEqual({ current: result.expectedGeneration, required: null });
    expect(result.startChannel).not.toHaveBeenCalled();
    expect(result.stopChannel).not.toHaveBeenCalled();
    expect(result.reloadPlugins).not.toHaveBeenCalled();
    expect(result.setState).not.toHaveBeenCalled();
    expect(result.requestRecoveryRestart).not.toHaveBeenCalled();
    expect(result.commitTerminalConfig).toHaveBeenCalledOnce();
    expect(result.reconcileTerminalSessions).toHaveBeenCalledOnce();
    const resolved = result.resolvedConfigs.at(-1);
    expect(resolved?.gateway?.auth?.token).toBe("new-shared-token");
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledOnce();
    expect(hoisted.refreshPreparedModelRuntimeSnapshots.mock.calls[0]?.[0]).toBe(resolved);
  });

  it("advances prepared model config stamps for a no-op publication", async () => {
    const result = await runManagedOwnershipScenario({ kind: "noop", queueRevert: false });

    expect(hoisted.advancePreparedModelRuntimeConfig).toHaveBeenCalledExactlyOnceWith(
      result.configA,
    );
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).not.toHaveBeenCalled();
  });

  it("rebuilds prepared model owners for a no-op secret-provider publication", async () => {
    const pluginMetadata = {} as never;
    const result = await runManagedOwnershipScenario({
      kind: "noop",
      queueRevert: false,
      secretProviderChanged: true,
      getPluginMetadata: () => pluginMetadata,
    });

    expect(hoisted.advancePreparedModelRuntimeConfig).not.toHaveBeenCalled();
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledExactlyOnceWith(
      result.configA,
      {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        pluginMetadata,
      },
    );
  });

  it("rebuilds a no-op secret-provider publication from the resolved committed config", async () => {
    // Regression: the rebuild used the source-derived candidate. When secret
    // resolution yields a different object, the rebuilt owner carries an
    // identity no reader supplies, so every strict catalog read rejects it --
    // reviving the failure on the very fallback meant to be safe.
    const pluginMetadata = {} as never;
    const result = await runManagedOwnershipScenario({
      kind: "noop",
      queueRevert: false,
      secretProviderChanged: true,
      resolveToDistinctConfig: true,
      getPluginMetadata: () => pluginMetadata,
    });

    const resolved = result.resolvedConfigs.at(-1);
    expect(resolved).toBeDefined();
    expect(resolved).not.toBe(result.configA);
    expect(hoisted.advancePreparedModelRuntimeConfig).not.toHaveBeenCalled();
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledOnce();
    // Identity, not deep equality: the resolved config is a clone of the source
    // candidate, so toHaveBeenCalledWith would match either object and prove
    // nothing about which one the rebuild actually used.
    const [rebuiltWith, options] = hoisted.refreshPreparedModelRuntimeSnapshots.mock.calls[0] ?? [];
    expect(rebuiltWith).toBe(resolved);
    expect(rebuiltWith).not.toBe(result.configA);
    expect(options).toEqual({
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      pluginMetadata,
    });
  });

  it("applies a current in-process hot config", async () => {
    const result = await runManagedOwnershipScenario({ kind: "hot", queueRevert: false });

    // Hot plans rebuild prepared owners. Advancing the stamp in place is reserved for no-op plans.
    expect(hoisted.advancePreparedModelRuntimeConfig).not.toHaveBeenCalled();
    expect(result.prepareRuntimeSecretsSnapshot).toHaveBeenCalledOnce();
    expect(result.commitTerminalConfig).toHaveBeenCalledOnce();
    expect(result.acceptTerminalConfig).toHaveBeenCalledOnce();
    expect(result.prepareTerminalConfig).toHaveBeenCalledOnce();
    expect(result.reconcileTerminalSessions).toHaveBeenCalledOnce();
    expect(hoisted.applyLoggingConfig).not.toHaveBeenCalled();
    expect(hoisted.resetSkillSnapshotConfigFingerprintCache).toHaveBeenCalledOnce();
    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(result.configA);
  });

  it("publishes logging-only changes from an applied hot config", async () => {
    await runManagedOwnershipScenario({ kind: "hot", loggingChanged: true, queueRevert: false });

    expect(hoisted.applyLoggingConfig).toHaveBeenCalledExactlyOnceWith({ level: "debug" });
  });

  it.each(["noop", "hot", "restart"] as const)(
    "yields stale config A when queued %s config B reverts to the old source",
    async (kind) => {
      const result = await runManagedOwnershipScenario({ kind, queueRevert: true });

      expect(result.prepareRuntimeSecretsSnapshot).toHaveBeenCalledOnce();
      expect(result.commitTerminalConfig).not.toHaveBeenCalled();
      expect(result.acceptTerminalConfig).toHaveBeenCalledOnce();
      expect(result.prepareTerminalConfig).toHaveBeenCalledOnce();
      expect(result.reconcileTerminalSessions).not.toHaveBeenCalled();
      expect(result.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(result.configB);
    },
  );
});

describe("provider auth hot reload path ownership", () => {
  it.each([
    "auth",
    "auth.profiles.openai.provider",
    "auth.order.openai",
    "env",
    "env.vars.OPENAI_API_KEY",
    "models",
    "models.providers.openai.api",
    "models.providers.anthropic",
    "plugins",
    "plugins.entries.openai.enabled",
    "secrets",
    "secrets.providers.default.path",
    "agent.model",
    "agent.model.default",
    "agents",
    "agents.list",
    "agents.defaults",
    "agents.defaults.model",
    "agents.defaults.models.provider.agentRuntime.id",
    "agents.defaults.modelPolicy",
    "agents.defaults.utilityModel",
    "agents.defaults.agentRuntime",
    "agents.defaults.runtime",
    "agents.defaults.imageModel.primary",
    "agents.defaults.mediaModels.video.primary",
    "agents.defaults.voiceModel.primary",
    "agents.defaults.pdfModel.primary",
    "agents.defaults.heartbeat",
    "agents.defaults.heartbeat.model",
    "agents.defaults.compaction",
    "agents.defaults.compaction.model",
    "agents.defaults.compaction.provider",
    "agents.defaults.compaction.memoryFlush",
    "agents.defaults.compaction.memoryFlush.model",
    "agents.defaults.workspace",
    "agents.defaults.agentDir",
    "agents.defaults.subagents",
    "agents.defaults.subagents.model.primary",
    "agents.entries",
    "agents.entries.main",
    "agents.entries.main.id",
    "agents.entries.main.default",
    "agents.entries.main.model",
    "agents.entries.main.models.provider.agentRuntime.id",
    "agents.entries.main.modelPolicy",
    "agents.entries.main.utilityModel",
    "agents.entries.main.agentRuntime",
    "agents.entries.main.runtime",
    "agents.entries.main.heartbeat",
    "agents.entries.main.heartbeat.model",
    "agents.entries.main.workspace",
    "agents.entries.main.agentDir",
    "agents.entries.main.subagents",
    "agents.entries.main.subagents.model.primary",
  ])("rewarm remains required for auth-relevant config path %s", (changedPath) => {
    expect(shouldRewarmProviderAuthState(createHotTailPlan({ changedPaths: [changedPath] }))).toBe(
      true,
    );
  });

  it.each([
    "agents.defaults.heartbeat.target",
    "agents.defaults.heartbeat.delivery.target",
    "agents.defaults.heartbeat.every",
    "agents.defaults.heartbeat.activeHours.start",
    "agents.entries.main.heartbeat.delivery.target",
    "agents.entries.main.heartbeat.every",
    "agents.entries.main.heartbeat.lightContext",
    "agents.defaults.compaction.enabled",
    "agents.defaults.compaction.mode",
    "agents.defaults.compaction.keepRecentTokens",
    "agents.defaults.compaction.timeoutSeconds",
    "agents.defaults.compaction.memoryFlush.enabled",
    "agents.defaults.compaction.memoryFlush.softThresholdTokens",
    "agent.heartbeat",
    "agents.entries.main.cron",
    "agents.entries.main.ui",
    "agents.entries.main.tools",
    "agents.entries.main.skills",
    "agents.entries.main.memory",
    "agents.entries.main.systemPrompt",
    "agents.defaults.systemPrompt",
    "agents.defaults.subagents.thinking",
    "agents.entries.main.subagents.thinking",
    "agents.defaults.subagents.archiveAfterMinutes",
    "mcp.servers.context7.command",
    "hooks.gmail",
    "hooks.path",
    "logging.level",
    "channels.telegram",
    "channels.discord.accounts.bot",
    "gateway.port",
    "cron.schedules.daily",
  ])("skips provider auth scans for unrelated config path %s", (changedPath) => {
    expect(shouldRewarmProviderAuthState(createHotTailPlan({ changedPaths: [changedPath] }))).toBe(
      false,
    );
  });

  it("rewarm remains required when plugins reload without a config path", () => {
    expect(
      shouldRewarmProviderAuthState(createHotTailPlan({ changedPaths: [], reloadPlugins: true })),
    ).toBe(true);
  });

  it("retains auth-relevant changes mixed with unrelated config paths", () => {
    expect(
      shouldRewarmProviderAuthState(
        createHotTailPlan({
          changedPaths: ["logging.level", "agents.defaults.workspace"],
        }),
      ),
    ).toBe(true);
  });
});

describe("gateway hot reload model state", () => {
  it.each([
    {
      reconciliationResult: "converged" as const,
      becomesStale: false,
      reviewAborted: true,
      publishes: true,
    },
    {
      reconciliationResult: "retry-scheduled" as const,
      becomesStale: false,
      reviewAborted: false,
      publishes: false,
    },
    {
      reconciliationResult: "converged" as const,
      becomesStale: true,
      reviewAborted: false,
      publishes: false,
    },
  ])(
    "keeps active skill review cancellation aligned with $reconciliationResult reconciliation (stale: $becomesStale)",
    async ({ reconciliationResult, becomesStale, reviewAborted, publishes }) => {
      const fixtureDir = autoCleanupTempDirs.make("openclaw-skill-review-reload-");
      const outputPath = path.join(fixtureDir, "review-output.md");
      const reviewStarted = createDeferred<AbortSignal>();
      const releaseReview = createDeferred();
      const releaseReconciliation = createDeferred();
      const cron = new CronService({
        storePath: path.join(fixtureDir, "jobs.json"),
        cronEnabled: true,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runSkillCollectionReview: async ({ abortSignal }) => {
          if (!abortSignal) {
            throw new Error("skill review cancellation signal missing");
          }
          reviewStarted.resolve(abortSignal);
          await releaseReview.promise;
          abortSignal.throwIfAborted();
          await writeFile(outputPath, "review output", "utf8");
          return { status: "ok" as const, summary: "reviewed main" };
        },
      });
      const previousConfig = {
        skills: { workshop: { autonomous: { mode: "auto" } } },
      } satisfies OpenClawConfig;
      const nextConfig = {
        skills: { workshop: { autonomous: { mode: "off" } } },
      } satisfies OpenClawConfig;
      let activeRun: Promise<unknown> | undefined;

      try {
        await cron.start();
        const added = await cron.add(
          {
            declarationKey: "skill-collection-review:main",
            name: "skill-collection-review-main",
            enabled: true,
            schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000 },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "skillCollectionReview" },
          },
          { enabledExplicit: true, systemOwned: true },
        );
        const job = "job" in added ? added.job : added;
        activeRun = cron.run(job.id, "force");
        const abortSignal = await reviewStarted.promise;
        const reconcileHeartbeatJobs = vi.fn<GatewayCronState["reconcileHeartbeatJobs"]>(
          async () => {
            await releaseReconciliation.promise;
            return reconciliationResult;
          },
        );
        let state = {
          ...createDefaultGatewayReloadState(),
          cronState: createTestCronState({ cron, cronEnabled: true, reconcileHeartbeatJobs }),
        };
        const setState = vi.fn((nextState: typeof state) => {
          state = nextState;
        });
        const { applyHotReload } = createGatewayReloadHandlers({
          getState: () => state,
          setState,
        });
        let current = true;

        const reload = applyHotReload(
          buildGatewayReloadPlan(["skills.workshop.autonomous.mode"]),
          nextConfig,
          {
            sourceConfig: previousConfig,
            isCurrent: () => current,
            publish: async (commit) => await commit(),
          },
        );

        await waitForFast(() =>
          expect(reconcileHeartbeatJobs.mock.calls[0]?.[0]?.config).toBe(nextConfig),
        );
        const candidate = reconcileHeartbeatJobs.mock.calls[0]?.[0];
        expect(candidate?.isCurrent()).toBe(true);
        expect(abortSignal.aborted).toBe(false);
        current = !becomesStale;
        expect(candidate?.isCurrent()).toBe(!becomesStale);
        releaseReconciliation.resolve();
        if (publishes) {
          await expect(reload).resolves.toBe("applied");
        } else {
          await expect(reload).rejects.toThrow(becomesStale ? "superseded" : "cron monitor");
        }
        expect(abortSignal.aborted).toBe(reviewAborted);
        expect(setState).toHaveBeenCalledTimes(publishes ? 1 : 0);
        releaseReview.resolve();
        await activeRun;
        if (reviewAborted) {
          await expect(readFile(outputPath, "utf8")).rejects.toThrow();
        } else {
          await expect(readFile(outputPath, "utf8")).resolves.toBe("review output");
        }
      } finally {
        releaseReview.resolve();
        releaseReconciliation.resolve();
        await activeRun?.catch(() => undefined);
        cron.stop();
      }
    },
  );

  it.each(["eager", "lazy"] as const)(
    "keeps a supervised on-exit child alive exactly once across %s cron reload",
    async (initialOwner) => {
      const fixtureDir = autoCleanupTempDirs.make("openclaw-cron-exit-reload-");
      const childScriptPath = path.join(fixtureDir, "watcher.cjs");
      const markerPath = path.join(fixtureDir, "watcher-runs.txt");
      const releasePath = path.join(fixtureDir, "release-watcher");
      const config = {
        session: { mainKey: "main", store: path.join(fixtureDir, "sessions.json") },
        cron: { enabled: true, store: path.join(fixtureDir, "jobs.json") },
      } as OpenClawConfig;
      await writeFile(
        childScriptPath,
        "const fs=require('node:fs');" +
          "fs.appendFileSync(process.argv[2],'run\\n');" +
          "const timer=setInterval(()=>{if(fs.existsSync(process.argv[3]))clearInterval(timer)},10)",
        "utf8",
      );
      const childArgs = [childScriptPath, markerPath, releasePath];
      const command =
        process.platform === "win32"
          ? buildWindowsCmdExeCommandLine(process.execPath, childArgs)
          : [process.execPath, ...childArgs].map((argument) => JSON.stringify(argument)).join(" ");
      const supervisor = getProcessSupervisor();
      const spawn = vi.spyOn(supervisor, "spawn");
      const previousCronFactory = hoisted.buildGatewayCronService.getMockImplementation();
      if (!previousCronFactory) {
        throw new Error("expected the default cron test factory");
      }
      let state: ReturnType<ReloadHandlerParams["getState"]> | undefined;

      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureDir);
      vi.stubEnv("OPENCLAW_SKIP_CRON", "0");
      hoisted.runtimeConfig.value = config;
      setRuntimeConfigSnapshot(config, config);

      try {
        const actualCron =
          await vi.importActual<typeof import("./server-cron.js")>("./server-cron.js");
        hoisted.buildGatewayCronService.mockImplementation(
          (params) =>
            actualCron.buildGatewayCronService(
              params as Parameters<typeof actualCron.buildGatewayCronService>[0],
            ) as unknown as ReturnType<typeof hoisted.buildGatewayCronService>,
        );
        const buildInitialCron =
          initialOwner === "lazy" ? createLazyGatewayCronState : actualCron.buildGatewayCronService;
        const initialCronState = buildInitialCron({
          cfg: config,
          deps: {} as never,
          broadcast: vi.fn(),
        });
        state = {
          ...createDefaultGatewayReloadState(),
          cronState: initialCronState,
        };
        await initialCronState.cron.start();
        const job = await initialCronState.cron.add({
          name: "preserve the real watched child",
          enabled: true,
          schedule: { kind: "on-exit", command },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "watched child finished" },
        });
        await initialCronState.reconcileExitWatchers();
        await waitForFast(async () => expect(await readFile(markerPath, "utf8")).toBe("run\n"), {
          timeout: 10_000,
        });
        expect(spawn).toHaveBeenCalledOnce();
        const watchedRun = await spawn.mock.results[0]?.value;
        if (!watchedRun) {
          throw new Error("expected the supervised cron exit watcher to start");
        }

        const handlers = createGatewayReloadHandlers({
          getState: () => {
            if (!state) {
              throw new Error("expected gateway state");
            }
            return state;
          },
          setState: (nextState) => {
            state = nextState;
          },
        });

        await withGatewayRestartSignal(async () => {
          await handlers.applyHotReload(createCronRestartPlan(), config);
        });

        expect(supervisor.getRecord(watchedRun.runId)).toMatchObject({
          pid: watchedRun.pid,
          state: "running",
        });
        expect(await readFile(markerPath, "utf8")).toBe("run\n");
        expect(spawn).toHaveBeenCalledOnce();

        await writeFile(releasePath, "release");
        await waitForFast(() => expect(state?.cronState.cron.getJob(job.id)?.enabled).toBe(false), {
          timeout: 10_000,
        });
        expect(await readFile(markerPath, "utf8")).toBe("run\n");
        expect(spawn).toHaveBeenCalledOnce();
      } finally {
        hoisted.buildGatewayCronService.mockImplementation(previousCronFactory);
        await writeFile(releasePath, "release").catch(() => {});
        await state?.cronState.cron.stopAndDrain?.();
        spawn.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("passes an agent-entry-local refresh scope through the commit and rebuild", async () => {
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createReloadHandlersForTest(logReload);
    const nextConfig = {} as OpenClawConfig;

    await applyHotReload(
      buildGatewayReloadPlan(["agents.entries.Alpha.model", "meta.lastTouchedAt"]),
      nextConfig,
    );

    expect(hoisted.markPreparedModelRuntimeSnapshotsStale).toHaveBeenCalledWith(
      "prepared model runtime owner is stale before config publication",
      { waitForReplacement: true, agentIds: new Set(["alpha"]) },
    );
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledWith(nextConfig, {
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
      agentIds: new Set(["alpha"]),
    });
  });

  it.each([
    "agents.defaults.compaction.model",
    "agents.defaults.compaction.maxActiveTranscriptBytes",
  ])("refreshes prepared model runtime without restarting subsystems: %s", async (changedPath) => {
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const channels = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const { applyHotReload, heartbeatRunner, cron } = createReloadHandlersForTest(
      logReload,
      channels,
    );
    const nextConfig = {
      agents: {
        defaults: {
          compaction: {
            model: "mock-openai/gpt-5.6-luna-new",
            maxActiveTranscriptBytes: "10b",
          },
        },
      },
    } satisfies OpenClawConfig;

    await applyHotReload(buildGatewayReloadPlan([changedPath]), nextConfig);

    expect(hoisted.markPreparedModelRuntimeSnapshotsStale).toHaveBeenCalledOnce();
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledWith(nextConfig, {
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
    });
    expect(heartbeatRunner.updateConfig).not.toHaveBeenCalled();
    expect(cron.stop).not.toHaveBeenCalled();
    expect(channels.start).not.toHaveBeenCalled();
    expect(channels.stop).not.toHaveBeenCalled();
    expect(hoisted.disposeAllSessionMcpRuntimes).not.toHaveBeenCalled();
    expect(logReload.info).toHaveBeenCalledWith(`config hot reload applied (${changedPath})`);
  });

  it("stops old cron exit watchers and reconciles rebuilt ones after cron restart", async () => {
    const order: string[] = [];
    const newCron = {
      start: vi.fn(async () => {
        order.push("start-new");
      }),
      stop: vi.fn(),
    };
    const newReconcileExitWatchers = vi.fn(async () => {
      order.push("reconcile-watchers");
    });
    const rebuiltCronState = {
      cron: newCron,
      storePath: "/tmp/rebuilt-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: newReconcileExitWatchers,
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
      reconcileHeartbeatJobs: vi.fn(async () => "converged" as const),
    };
    hoisted.buildGatewayCronService.mockImplementationOnce(() => {
      order.push("build-new");
      return rebuiltCronState;
    });
    const { applyHotReload, cron, cronReconciliation, setState } = createReloadHandlersForTest();
    cron.stop.mockImplementation(() => {
      order.push("stop-old");
    });
    cronReconciliation.invalidate.mockImplementation(() => {
      order.push("invalidate-old");
    });
    cronReconciliation.arm.mockImplementation(() => ({
      complete: async () => {
        order.push("hook");
      },
    }));
    const nextConfig = { cron: { enabled: true } } as OpenClawConfig;

    await withGatewayRestartSignal(async () => {
      await applyHotReload(createCronRestartPlan(), nextConfig);
    });

    expect(cron.stop).toHaveBeenCalledTimes(1);
    expect(newCron.start).toHaveBeenCalledTimes(1);
    await waitForFast(() => expect(newReconcileExitWatchers).toHaveBeenCalledTimes(1));
    await waitForFast(() => expect(order.at(-1)).toBe("hook"));
    expect(order).toEqual([
      "build-new",
      "invalidate-old",
      "stop-old",
      "start-new",
      "reconcile-watchers",
      "hook",
    ]);
    expect(cronReconciliation.arm).toHaveBeenCalledWith({
      reason: "reload",
      config: nextConfig,
      cronState: rebuiltCronState,
    });
    expect(setState).toHaveBeenCalledWith(
      expect.objectContaining({
        cronState: rebuiltCronState,
      }),
    );
  });

  it("keeps the gateway context resolver when hot reload rebuilds cron", async () => {
    const resolveGatewayContext = vi.fn(() => undefined);
    const { applyHotReload } = createGatewayReloadHandlers({ resolveGatewayContext });

    await withGatewayRestartSignal(async () => {
      await applyHotReload(createCronRestartPlan(), { cron: { enabled: true } });
    });

    expect(hoisted.buildGatewayCronService).toHaveBeenCalledWith(
      expect.objectContaining({ resolveGatewayContext }),
    );
  });

  it("completes reload reconciliation when the replacement scheduler is disabled", async () => {
    const rebuiltCronState = {
      cron: { start: vi.fn(async () => {}), stop: vi.fn() },
      storePath: "/tmp/rebuilt-cron.json",
      cronEnabled: false,
      reconcileExitWatchers: vi.fn(async () => {}),
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
      reconcileHeartbeatJobs: vi.fn(async () => "converged" as const),
    };
    hoisted.buildGatewayCronService.mockReturnValueOnce(rebuiltCronState);
    const { applyHotReload, cronReconciliation } = createReloadHandlersForTest();
    const nextConfig = { cron: { enabled: false } } as OpenClawConfig;

    await withGatewayRestartSignal(async () => {
      await applyHotReload(createCronRestartPlan(), nextConfig);
    });

    await waitForFast(() => expect(cronReconciliation.complete).toHaveBeenCalledTimes(1));
    expect(cronReconciliation.arm).toHaveBeenCalledWith({
      reason: "reload",
      config: nextConfig,
      cronState: rebuiltCronState,
    });
  });

  it("rejects cron reload before commit when recovery restart is unavailable", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const { applyHotReload, cron, setState } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      vi.fn(),
      false,
    );

    await expect(
      applyHotReload(createCronRestartPlan(), { cron: { enabled: true } }),
    ).rejects.toThrow(
      "config reload requires a managed gateway restart owner for irreversible hot reload",
    );

    expect(setState).not.toHaveBeenCalled();
    expect(cron.stop).not.toHaveBeenCalled();
  });

  it("waits for heartbeat monitor convergence before publishing an in-place update", async () => {
    const { applyHotReload, heartbeatRunner, reconcileHeartbeatJobs, setState } =
      createReloadHandlersForTest(undefined, undefined, undefined, vi.fn(), false);
    const nextConfig = { agents: { defaults: { heartbeat: { every: "1h" } } } } as OpenClawConfig;
    let releaseReconciliation!: () => void;
    const reconciliation = new Promise<"converged">((resolve) => {
      releaseReconciliation = () => resolve("converged");
    });
    reconcileHeartbeatJobs.mockImplementationOnce(async () => await reconciliation);

    const reload = applyHotReload(createHotTailPlan({ restartHeartbeat: true }), nextConfig);
    await waitForFast(() =>
      expect(reconcileHeartbeatJobs.mock.calls[0]?.[0]?.config).toBe(nextConfig),
    );

    expect(heartbeatRunner.updateConfig).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();

    releaseReconciliation();
    await expect(reload).resolves.toBe("applied");
    expect(heartbeatRunner.updateConfig).toHaveBeenCalledWith(nextConfig);
    expect(setState).toHaveBeenCalledOnce();
  });

  it("does not publish an in-place heartbeat update while reconciliation is retrying", async () => {
    const { applyHotReload, heartbeatRunner, reconcileHeartbeatJobs, setState } =
      createReloadHandlersForTest(undefined, undefined, undefined, vi.fn(), false);
    reconcileHeartbeatJobs.mockResolvedValueOnce("retry-scheduled");

    await expect(
      applyHotReload(createHotTailPlan({ restartHeartbeat: true }), {
        agents: { defaults: { heartbeat: { every: "1h" } } },
      } as OpenClawConfig),
    ).rejects.toThrow("cron monitor");

    expect(heartbeatRunner.updateConfig).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it.each([
    { from: "off" as const, to: "auto" as const },
    { from: "auto" as const, to: "off" as const },
  ])(
    "reconciles skill review jobs when Workshop mode changes from $from to $to",
    async ({ from, to }) => {
      const { applyHotReload, heartbeatRunner, reconcileHeartbeatJobs, setState } =
        createReloadHandlersForTest(undefined, undefined, undefined, vi.fn(), false);
      const previousConfig = {
        skills: { workshop: { autonomous: { mode: from } } },
      } satisfies OpenClawConfig;
      const nextConfig = {
        skills: { workshop: { autonomous: { mode: to } } },
      } satisfies OpenClawConfig;

      await expect(
        applyHotReload(buildGatewayReloadPlan(["skills.workshop.autonomous.mode"]), nextConfig, {
          sourceConfig: previousConfig,
          isCurrent: () => true,
          publish: async (commit) => await commit(),
        }),
      ).resolves.toBe("applied");

      await waitForFast(() =>
        expect(reconcileHeartbeatJobs.mock.calls[0]?.[0]?.config).toBe(nextConfig),
      );
      expect(heartbeatRunner.updateConfig).not.toHaveBeenCalled();
      expect(setState).toHaveBeenCalledOnce();
    },
  );

  it("rejects an ownerless heartbeat update failure before runtime commit", async () => {
    const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
    const { applyHotReload, heartbeatRunner, setState } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      vi.fn(),
      false,
    );
    heartbeatRunner.updateConfig.mockImplementationOnce(() => {
      throw new Error("heartbeat update failed");
    });
    setCommandLaneConcurrency(CommandLane.Main, 0);
    let queuedTaskStarted = false;
    const queuedTask = enqueueCommandInLane(CommandLane.Main, async () => {
      queuedTaskStarted = true;
    });

    try {
      await expect(
        applyHotReload(
          createHotTailPlan({ restartHeartbeat: true }),
          { agents: { defaults: { maxConcurrent: 1 } } } as OpenClawConfig,
          {
            sourceConfig: { agents: { defaults: { maxConcurrent: 1 } } },
            publish,
            isCurrent: () => true,
          },
        ),
      ).rejects.toThrow("heartbeat update failed");

      expect(publish).toHaveBeenCalledOnce();
      expect(setState).not.toHaveBeenCalled();
      expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(0);
      expect(queuedTaskStarted).toBe(false);
    } finally {
      setCommandLaneConcurrency(CommandLane.Main, 1);
      await queuedTask;
    }
  });

  it("restarts when the replacement cron fails after runtime commit", async () => {
    await withGatewayRestartSignal(async (signalSpy) => {
      const logReload = { info: vi.fn(), warn: vi.fn() };
      hoisted.buildGatewayCronService.mockReturnValueOnce({
        cron: {
          start: vi.fn(async () => {
            throw new Error("cron start failed");
          }),
          stop: vi.fn(),
        },
        storePath: "/tmp/rebuilt-cron.json",
        cronEnabled: true,
        reconcileExitWatchers: vi.fn(async () => {}),
        reconcileStreamWatchers: vi.fn(async () => {}),
        stopStreamWatchers: vi.fn(async () => {}),
        reconcileHeartbeatJobs: vi.fn(async () => "converged" as const),
      });
      const { applyHotReload, setState } = createReloadHandlersForTest(logReload);

      await expect(
        applyHotReload(createCronRestartPlan(), { cron: { enabled: true } }),
      ).resolves.toBe("applied-restart-required");

      expect(setState).toHaveBeenCalledOnce();
      await waitForFast(() => expect(signalSpy).toHaveBeenCalledOnce());
      expect(logReload.warn).toHaveBeenCalledWith(
        "cron reload failed after config commit: cron start failed; restarting gateway",
      );
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    });
  });

  it("ignores a delayed cron failure after a newer reload supersedes it", async () => {
    let rejectFirstStart: ((reason: Error) => void) | undefined;
    const firstCronState = {
      cron: {
        start: vi.fn(
          async () =>
            await new Promise<void>((_resolve, reject) => {
              rejectFirstStart = reject;
            }),
        ),
        stop: vi.fn(),
      },
      storePath: "/tmp/first-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
      reconcileHeartbeatJobs: vi.fn(async () => "converged" as const),
    };
    const secondCronState = {
      cron: { start: vi.fn(async () => {}), stop: vi.fn() },
      storePath: "/tmp/second-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
      reconcileHeartbeatJobs: vi.fn(async () => "converged" as const),
    };
    hoisted.buildGatewayCronService
      .mockReturnValueOnce(firstCronState)
      .mockReturnValueOnce(secondCronState);
    const { applyHotReload, logCron } = createReloadHandlersForTest();

    await withGatewayRestartSignal(async (signalSpy) => {
      await applyHotReload(createCronRestartPlan(), { cron: { enabled: true } });
      await waitForFast(() => expect(firstCronState.cron.start).toHaveBeenCalledOnce());
      await applyHotReload(createCronRestartPlan(), { cron: { enabled: true } });
      rejectFirstStart?.(new Error("superseded start failed"));
      await waitForFast(() =>
        expect(logCron.error).toHaveBeenCalledWith(
          "failed to start: Error: superseded start failed",
        ),
      );
      expect(signalSpy).not.toHaveBeenCalled();
    });
  });

  it("restarts instead of rolling back when cron teardown fails after runtime commit", async () => {
    await withGatewayRestartSignal(async (signalSpy) => {
      const logReload = { info: vi.fn(), warn: vi.fn() };
      const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
      const { applyHotReload, cron, setState } = createReloadHandlersForTest(logReload);
      cron.stop.mockImplementation(() => {
        throw new Error("cron stop failed");
      });

      await expect(
        applyHotReload(
          createCronRestartPlan(),
          { cron: { enabled: true } },
          {
            sourceConfig: { cron: { enabled: true } },
            publish,
            isCurrent: () => true,
          },
        ),
      ).resolves.toBe("applied-restart-required");

      expect(publish).toHaveBeenCalledOnce();
      expect(setState).toHaveBeenCalledOnce();
      expect(logReload.warn).toHaveBeenCalledWith(
        "runtime commit failed after config commit: cron stop failed; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    });
  });

  it("resets prepared model runtime state for every hot reload and rewarms after plugin reload", async () => {
    const reloadPlugins = vi.fn(async (params): Promise<GatewayPluginReloadResult> => {
      hoisted.reloadEvents.push("prepare-plugins");
      await params.commitRuntime();
      hoisted.reloadEvents.push("replace-plugins");
      return makePluginReloadResult();
    });
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      reloadPlugins,
      logReload,
    });

    const nextConfig = { plugins: { enabled: true } } as OpenClawConfig;
    await applyHotReload(createPluginReloadPlan(), nextConfig);

    const firstResetIndex = hoisted.reloadEvents.indexOf("clear-provider-auth");
    expect(firstResetIndex).toBeGreaterThanOrEqual(0);
    expect(hoisted.reloadEvents.slice(firstResetIndex)).toEqual([
      "clear-provider-auth",
      "prepare-plugins",
      "stale-prepared-model-runtime",
      "replace-plugins",
      "clear-provider-auth",
      "refresh-prepared-model-runtime",
      "refresh-context-window",
      "warm-provider-auth",
    ]);
    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
    expect(hoisted.markPreparedModelRuntimeSnapshotsStale).toHaveBeenCalledWith(
      "prepared model runtime owner is stale before config publication",
      { waitForReplacement: true },
    );
    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledWith(nextConfig, {
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
    });
    expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledWith(nextConfig);
  });

  it("disposes cached MCP runtimes on MCP config hot reloads", async () => {
    const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    hoisted.disposeAllSessionMcpRuntimes.mockRejectedValueOnce(new Error("dispose failed"));
    const { applyHotReload, setState } = createReloadHandlersForTest(
      logReload,
      undefined,
      undefined,
      vi.fn(),
    );
    const nextConfig = { mcp: { servers: {} } } as OpenClawConfig;

    await applyHotReload(
      createHotTailPlan({
        changedPaths: ["mcp.servers.context7.command"],
        hotReasons: ["mcp.servers.context7.command"],
        disposeMcpRuntimes: true,
      }),
      nextConfig,
    );

    expect(hoisted.disposeAllSessionMcpRuntimes).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledOnce();
    expect(logReload.warn).toHaveBeenCalledWith(
      "bundle-mcp runtime disposal during config reload failed: Error: dispose failed",
    );
    expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();
  });

  it("skips provider-auth rewarm for unrelated agent heartbeat hot reloads", async () => {
    const { applyHotReload } = createReloadHandlersForTest();
    const nextConfig = {
      agents: { defaults: { heartbeat: { target: "telegram" } } },
    } as OpenClawConfig;

    await applyHotReload(
      createHotTailPlan({
        changedPaths: ["agents.defaults.heartbeat.target"],
        hotReasons: ["agents.defaults.heartbeat.target"],
        restartHeartbeat: true,
      }),
      nextConfig,
    );

    expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();
  });

  it("keeps unrelated heartbeat reloads lazy and authenticates the next user lookup once", async () => {
    const { applyHotReload } = createReloadHandlersForTest();
    const nextConfig = {
      agents: { defaults: { heartbeat: { target: "telegram" } } },
    } satisfies OpenClawConfig;
    const readProfiles = vi.fn(() => ({
      "openai:fixture": {
        type: "api_key" as const,
        provider: "openai",
        key: "provider-auth-test-fixture",
      },
    }));
    publishProviderAuthWarmSnapshot({
      agents: [
        {
          agentId: "main",
          configFingerprint: "previous-config-fingerprint",
          providers: [["openai", false]],
        },
      ],
    });
    hoisted.clearCurrentProviderAuthState.mockImplementationOnce(clearWarmedProviderAuthState);

    try {
      await applyHotReload(
        createHotTailPlan({
          changedPaths: ["agents.defaults.heartbeat.target"],
          hotReasons: ["agents.defaults.heartbeat.target"],
          restartHeartbeat: true,
        }),
        nextConfig,
      );

      expect(hoisted.clearCurrentProviderAuthState).toHaveBeenCalledOnce();
      expect(getCurrentProviderAuthStates()).toBeNull();
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();

      const { hasAuthForModelProvider } = await vi.importActual<
        typeof import("../agents/model-provider-auth.js")
      >("../agents/model-provider-auth.js");
      await expect(
        hasAuthForModelProvider({
          provider: "openai",
          cfg: nextConfig,
          agentDir: "/virtual/provider-auth-agent",
          workspaceDir: "/virtual/provider-auth-workspace",
          env: {},
          allowPluginSyntheticAuth: false,
          discoverExternalCliAuth: false,
          store: {
            version: 1,
            get profiles() {
              return readProfiles();
            },
          },
        }),
      ).resolves.toBe(true);
      expect(readProfiles).toHaveBeenCalledOnce();
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();
    } finally {
      clearWarmedProviderAuthState();
    }
  });

  it("keeps provider-auth rewarm for model-provider hot reloads", async () => {
    const { applyHotReload } = createReloadHandlersForTest();
    const nextConfig = {
      models: { providers: { openai: { api: "openai" } } },
    } as unknown as OpenClawConfig;

    await applyHotReload(
      createHotTailPlan({
        changedPaths: ["models.providers.openai.api"],
        hotReasons: ["models.providers.openai.api"],
        restartHeartbeat: true,
      }),
      nextConfig,
    );

    expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledWith(nextConfig);
  });

  it.each([
    "auth.profiles.openai.provider",
    "env.vars.OPENAI_API_KEY",
    "agents.list",
    "agents.defaults.imageModel.primary",
    "agents.defaults.heartbeat.model",
    "agents.entries.main.heartbeat.model",
    "agents.defaults.compaction.model",
    "agents.defaults.compaction.provider",
    "agents.defaults.compaction.memoryFlush.model",
    "agents.entries.main.default",
    "agents.entries.main.runtime.id",
  ])("runs provider-auth rewarm for previously missed auth owner %s", async (changedPath) => {
    const { applyHotReload } = createReloadHandlersForTest();
    const nextConfig = {} satisfies OpenClawConfig;

    await applyHotReload(
      createHotTailPlan({
        changedPaths: [changedPath],
        hotReasons: [changedPath],
      }),
      nextConfig,
    );

    expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledWith(nextConfig);
  });

  it("refreshes context metadata when the default workspace changes", async () => {
    const { applyHotReload, setState } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      vi.fn(),
    );
    const nextConfig = {
      agents: { defaults: { workspace: "/tmp/next-workspace" } },
    } as OpenClawConfig;

    await applyHotReload(
      createHotTailPlan({
        changedPaths: ["agents.defaults.workspace"],
        hotReasons: ["agents.defaults.workspace"],
      }),
      nextConfig,
    );

    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
    expect(setState).toHaveBeenCalledOnce();
  });

  it("rejects an ownerless context cache reload before runtime commit", async () => {
    const { applyHotReload, setState } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      vi.fn(),
      false,
    );

    await expect(
      applyHotReload(
        createHotTailPlan({
          changedPaths: ["agents.defaults.workspace"],
          hotReasons: ["agents.defaults.workspace"],
        }),
        { agents: { defaults: { workspace: "/tmp/next-workspace" } } } as OpenClawConfig,
      ),
    ).rejects.toThrow(
      "config reload requires a managed gateway restart owner for irreversible hot reload",
    );

    expect(setState).not.toHaveBeenCalled();
    expect(hoisted.refreshContextWindowCache).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "adds the agents object",
      previousConfig: {},
      nextConfig: { agents: { defaults: { workspace: "/tmp/next-workspace" } } },
      expectedPath: "agents",
    },
    {
      label: "removes the defaults object",
      previousConfig: { agents: { defaults: { workspace: "/tmp/previous-workspace" } } },
      nextConfig: { agents: {} },
      expectedPath: "agents.defaults",
    },
  ])("refreshes context metadata when a workspace change $label", async (testCase) => {
    const { applyHotReload } = createReloadHandlersForTest();
    const previousConfig = testCase.previousConfig as OpenClawConfig;
    const nextConfig = testCase.nextConfig as OpenClawConfig;
    const changedPaths = diffConfigPaths(previousConfig, nextConfig);
    expect(changedPaths).toEqual([testCase.expectedPath]);

    await applyHotReload(buildGatewayReloadPlan(changedPaths), nextConfig);

    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
  });
});

describe("gateway hot reload superseded tail recovery", () => {
  it("rearms detached stale-tail recovery against an already accepted config", async () => {
    vi.useFakeTimers();
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const prepareRuntimeConfig = vi.fn(
      async (): Promise<OpenClawConfig> => ({ logging: { level: "debug" } }),
    );
    const handlers = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    handlers.recordAcceptedRestartTarget({
      runtimeConfig: { logging: { level: "debug" } },
      sourceConfig: { logging: { level: "debug" } },
      prepareRuntimeConfig,
    });
    hoisted.refreshContextWindowCache.mockRejectedValueOnce(new Error("detached tail failed"));
    const plan = createHotTailPlan({
      changedPaths: ["agents.defaults.workspace"],
      hotReasons: ["agents.defaults.workspace"],
    });

    try {
      await handlers.applyHotReload(
        plan,
        { agents: { defaults: { workspace: "/tmp/a" } } },
        {
          sourceConfig: { agents: { defaults: { workspace: "/tmp/a" } } },
          isCurrent: () => false,
          publish: async (commit) => await commit(),
        },
      );
      await vi.runAllTimersAsync();

      expect(prepareRuntimeConfig).toHaveBeenCalledOnce();
      expect(requestRecoveryRestart).toHaveBeenCalledWith(
        "config reload: hot reload recovery: context window cache reload",
        undefined,
      );
    } finally {
      handlers.stopRestartRetries();
    }
  });

  it("pauses stale-target recovery until a newer valid config is accepted", async () => {
    vi.useFakeTimers();
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handlers = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const configA = { logging: { level: "info" as const } } satisfies OpenClawConfig;
    const configC = { logging: { level: "debug" as const } } satisfies OpenClawConfig;
    const prepareA = vi.fn(async () => configA);
    const prepareC = vi.fn(async () => configC);
    handlers.recordAcceptedRestartTarget({
      runtimeConfig: configA,
      sourceConfig: configA,
      prepareRuntimeConfig: prepareA,
    });
    let rejectTail: ((error: Error) => void) | undefined;
    hoisted.refreshContextWindowCache.mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectTail = reject;
        }),
    );
    const plan = createHotTailPlan({
      changedPaths: ["agents.defaults.workspace"],
      hotReasons: ["agents.defaults.workspace"],
    });

    try {
      const staleTail = handlers.applyHotReload(plan, configA, {
        sourceConfig: configA,
        isCurrent: () => false,
        publish: async (commit) => await commit(),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(hoisted.refreshContextWindowCache).toHaveBeenCalledOnce();

      handlers.pauseGatewayRestartForConfigCandidate();
      const acceptedBeforeTailFailure = handlers.acceptRestartConfig(configC);
      expect(acceptedBeforeTailFailure.debt).toBeUndefined();
      rejectTail?.(new Error("stale A tail failed"));
      await staleTail;
      await vi.runAllTimersAsync();

      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(prepareA).not.toHaveBeenCalled();

      const accepted = handlers.publishAcceptedRestartTarget({
        runtimeConfig: configC,
        sourceConfig: configC,
        prepareRuntimeConfig: prepareC,
      });
      expect(accepted.conservativeDebt).toBeDefined();
      if (!accepted.conservativeDebt) {
        throw new Error("expected paused stale-tail recovery debt");
      }
      const restart = handlers.requestGatewayRestart(accepted.conservativeDebt.plan, configC, {
        retainDebtAcrossConfigChanges: accepted.conservativeDebt.retainDebtAcrossConfigChanges,
        debtConfig: configC,
        prepareRuntimeConfig: prepareC,
      });
      restart.settle("committed");
      await vi.runAllTimersAsync();

      expect(requestRecoveryRestart).toHaveBeenCalledOnce();
      expect(prepareC).toHaveBeenCalledOnce();
    } finally {
      handlers.stopRestartRetries();
    }
  });

  it.each(["mcp", "gmail", "channel", "context"] as const)(
    "does not restart into invalid config B after revocation during the $surface tail",
    async (surface) => {
      const entered = createDeferred();
      const release = createDeferred();
      const invalidConfigB = {
        gateway: {
          auth: {
            mode: "token" as const,
            token: {
              source: "env" as const,
              provider: "default",
              id: "MISSING_TAIL_TOKEN",
            },
          },
        },
      } satisfies OpenClawConfig;
      let pendingConfig: OpenClawConfig | null = null;
      const isCurrent = () => pendingConfig === null;
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      const startChannel = vi.fn(async () => {});
      const stopChannel = vi.fn(async () => {
        if (surface !== "channel") {
          return;
        }
        entered.resolve();
        await release.promise;
        throw new Error("channel tail failed");
      });
      const stopPostReadySidecars = vi.fn(async () => {
        if (surface === "mcp") {
          throw new Error("gmail tail failed after MCP disposal");
        }
        if (surface !== "gmail") {
          return;
        }
        entered.resolve();
        await release.promise;
        throw new Error("gmail tail failed");
      });
      if (surface === "mcp") {
        hoisted.disposeAllSessionMcpRuntimes.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
        });
      }
      if (surface === "context") {
        hoisted.refreshContextWindowCache.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          throw new Error("context tail failed");
        });
      }
      const logReload = { info: vi.fn(), warn: vi.fn() };
      const handlers = createReloadHandlersForTest(
        logReload,
        { start: startChannel, stop: stopChannel },
        undefined,
        stopPostReadySidecars,
        requestRecoveryRestart,
      );
      const plan = createHotTailPlan(
        surface === "mcp"
          ? { disposeMcpRuntimes: true, restartGmailWatcher: true }
          : surface === "gmail"
            ? { restartGmailWatcher: true }
            : surface === "channel"
              ? { restartChannels: new Set(["discord"]) }
              : {
                  changedPaths: ["agents.defaults.workspace"],
                  hotReasons: ["agents.defaults.workspace"],
                },
      );
      const configA = {
        agents: { defaults: { workspace: "/tmp/a" } },
      } as OpenClawConfig;
      const reloadA = handlers.applyHotReload(plan, configA, {
        sourceConfig: configA,
        isCurrent,
        publish: async (commit) => await commit(),
      });

      await entered.promise;
      pendingConfig = invalidConfigB;
      release.resolve();
      await expect(reloadA).resolves.toBe("applied");

      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        expect.stringContaining("recovery deferred to the newer config"),
      );
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();

      const configC = { logging: { level: "debug" as const } } satisfies OpenClawConfig;
      pendingConfig = configC;
      await handlers.applyHotReload(createHotTailPlan(), configC, {
        sourceConfig: configC,
        isCurrent: () => pendingConfig === configC,
        publish: async (commit) => await commit(),
      });

      expect(handlers.setState).toHaveBeenCalledTimes(2);
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(0);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
    },
  );

  it("finishes a channel restart after config B revokes A between stop and start", async () => {
    const stopped = createDeferred();
    const releaseStop = createDeferred();
    let current = true;
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {
      stopped.resolve();
      await releaseStop.promise;
    });
    const handlers = createReloadHandlersForTest(
      undefined,
      { start: startChannel, stop: stopChannel },
      undefined,
      vi.fn(),
      requestRecoveryRestart,
    );
    const reloadA = handlers.applyHotReload(
      createHotTailPlan({ restartChannels: new Set(["discord"]) }),
      {},
      {
        sourceConfig: {},
        isCurrent: () => current,
        publish: async (commit) => await commit(),
      },
    );

    await stopped.promise;
    current = false;
    releaseStop.resolve();
    await reloadA;

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord", undefined, {
      preserveManualStop: true,
      skipUnavailableAccounts: true,
    });
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
  });

  it.each(["discord", "telegram"] as const)(
    "starts the %s channel outside the config-reload request admission",
    async (channel) => {
      const startRootCounts: number[] = [];
      const handlers = createReloadHandlersForTest(undefined, {
        start: vi.fn(async () => {
          startRootCounts.push(getActiveGatewayRootWorkCount({ excludeCurrent: true }));
        }),
        stop: vi.fn(async () => {}),
      });
      const root = tryBeginGatewayRootWorkAdmission();
      expect(root).not.toBeNull();

      try {
        await root?.run(async () => {
          await handlers.applyHotReload(
            createHotTailPlan({ restartChannels: new Set([channel]) }),
            {},
          );
        });
      } finally {
        root?.release();
      }

      expect(startRootCounts).toEqual([1]);
    },
  );
});

describe("gateway hot reload commit policy", () => {
  it("retires the old health monitor before publishing its replacement", async () => {
    const events: string[] = [];
    const oldMonitor = {
      stop: vi.fn(() => events.push("stop")),
      waitForIdle: vi.fn(async () => {
        events.push("waitForIdle");
      }),
    };
    const nextMonitor = {};
    let state: Parameters<ReloadHandlerParams["setState"]>[0] = {
      hooksConfig: {} as never,
      hookClientIpConfig: {} as never,
      heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
      cronState: createTestCronState(),
      channelHealthMonitor: oldMonitor as never,
    };
    const setState = vi.fn((nextState: typeof state) => {
      events.push("setState");
      state = nextState;
    });
    const { applyHotReload } = createGatewayReloadHandlers({
      getState: () => state,
      setState,
      createHealthMonitor: vi.fn(() => {
        events.push("create");
        return nextMonitor as never;
      }),
      requestRecoveryRestart: vi.fn(() => ({ status: "emitted" as const })),
    });

    await applyHotReload(createHotTailPlan({ restartHealthMonitor: true }), {} as OpenClawConfig);

    expect(events).toEqual(["setState", "stop", "waitForIdle", "create", "setState"]);
    expect(state.channelHealthMonitor).toBe(nextMonitor);
  });

  it("preserves SIGUSR1 policy when hook preparation rejects the config", async () => {
    setGatewaySigusr1RestartPolicy({ allowExternal: false });
    const { applyHotReload } = createReloadHandlersForTest();

    await expect(
      applyHotReload(
        createHotTailPlan({
          changedPaths: ["commands.restart", "hooks.enabled"],
          hotReasons: ["commands.restart", "hooks.enabled"],
          reloadHooks: true,
        }),
        { commands: { restart: true }, hooks: { enabled: true } },
      ),
    ).rejects.toThrow("hooks.enabled requires hooks.token");

    expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(false);
  });

  it("preserves the active hook transform cache across rejected and policy-only reloads", async () => {
    const configDir = autoCleanupTempDirs.make("openclaw-rejected-hook-reload-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const transformPath = path.join(transformsRoot, "reloadable.mjs");
    fs.writeFileSync(transformPath, 'export default () => ({ kind: "wake", text: "accepted" });');
    const activeMappings = [
      {
        id: "reloadable",
        matchPath: "reloadable",
        action: "agent" as const,
        messageTemplate: "unused",
        transform: { modulePath: transformPath },
      },
    ];
    commitHooksConfigReload();
    const applyActiveTransform = () =>
      applyHookMappings(activeMappings, {
        payload: {},
        headers: {},
        url: new URL("http://127.0.0.1:18789/hooks/reloadable"),
        path: "reloadable",
      });

    const first = await applyActiveTransform();
    expect(first?.ok).toBe(true);
    const firstAction = first?.ok ? first.actions[0] : undefined;
    if (firstAction?.kind === "wake") {
      expect(firstAction.text).toBe("accepted");
    }

    const { applyHotReload } = createReloadHandlersForTest();

    fs.writeFileSync(transformPath, 'export default () => ({ kind: "wake", text: "candidate" });');
    const nextTime = new Date(Date.now() + 5_000);
    fs.utimesSync(transformPath, nextTime, nextTime);

    await expect(
      applyHotReload(
        {
          changedPaths: ["hooks.token"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["hooks.token"],
          reloadHooks: true,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { hooks: { enabled: true } },
      ),
    ).rejects.toThrow("hooks.enabled requires hooks.token");

    const afterRejectedReload = await applyActiveTransform();
    expect(afterRejectedReload?.ok).toBe(true);
    const rejectedAction = afterRejectedReload?.ok ? afterRejectedReload.actions[0] : undefined;
    if (rejectedAction?.kind === "wake") {
      expect(rejectedAction.text).toBe("accepted");
    }

    await applyHotReload(
      createHotTailPlan({
        changedPaths: ["agents.entries"],
        hotReasons: ["agents.entries"],
        refreshHooksPolicy: true,
      }),
      {
        agents: { ownership: "explicit", entries: { next: {} } },
        hooks: { enabled: true, token: "hook-secret" },
      },
    );

    const afterPolicyReload = await applyActiveTransform();
    expect(afterPolicyReload?.ok).toBe(true);
    const policyAction = afterPolicyReload?.ok ? afterPolicyReload.actions[0] : undefined;
    if (policyAction?.kind === "wake") {
      expect(policyAction.text).toBe("accepted");
    }
  });
});

describe("gateway restart deferral preflight", () => {
  it("retries an immediate restart when signal admission fails", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    vi.useFakeTimers();

    try {
      expect(requestGatewayRestart(createGatewayRestartPlan(), {}).status).toBe("recovery-pending");
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      stopRestartRetries();
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("defers a restart emission retry while host suspension is prepared", async () => {
    let recordRetryEmission: (() => void) | undefined;
    const retryEmitted = new Promise<void>((resolve) => {
      recordRetryEmission = resolve;
    });
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockImplementationOnce(() => {
        recordRetryEmission?.();
        return { status: "emitted" };
      });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
    vi.useFakeTimers();

    try {
      const initialResult = await runWithGatewayIndependentRootWorkAdmission(async () =>
        requestGatewayRestart(createGatewayRestartPlan(), {}),
      );
      expect(initialResult.status).toBe("recovery-pending");
      suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);

      expect(suspension?.release()).toBe(true);
      await retryEmitted;
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      suspension?.release();
      stopRestartRetries();
    }
  });

  it("retires a rejected preflight after it supersedes committed restart work", async () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValue({ status: "failed" });
    const {
      beginGatewayRestartLifecycle,
      requestGatewayRestart,
      retireRejectedRestartRequest,
      stopRestartRetries,
    } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const restartPlan = createGatewayRestartPlan() satisfies GatewayReloadPlan;
    vi.useFakeTimers();

    try {
      const rejected = requestGatewayRestart(restartPlan, {});
      rejected.settle("rejected");
      expect(retireRejectedRestartRequest()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);

      const committed = requestGatewayRestart(restartPlan, {});
      committed.settle("committed");
      const rejectedPreflight = beginGatewayRestartLifecycle();
      rejectedPreflight.settle("rejected");
      expect(retireRejectedRestartRequest()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      stopRestartRetries();
    }
  });

  it("preserves rejected immediate writer-restart debt across an unrelated accepted config", () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { acceptRestartConfig, requestGatewayRestart, stopRestartRetries } =
      createReloadHandlersForTest(
        undefined,
        undefined,
        undefined,
        undefined,
        requestRecoveryRestart,
      );
    const configA = {
      hooks: { enabled: true, token: "test-token", path: "/a" },
    } as OpenClawConfig;
    const configB = {
      ...configA,
      logging: { level: "debug" },
    } as OpenClawConfig;
    const forcedRestartPlan = {
      changedPaths: ["hooks.path"],
      restartGateway: true,
      restartReasons: ["writer requires restart"],
      hotReasons: ["hooks.path"],
      reloadHooks: true,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: false,
      restartChannels: new Set<ChannelKind>(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    } satisfies GatewayReloadPlan;

    try {
      const rejected = requestGatewayRestart(forcedRestartPlan, configA);
      expect(rejected.status).toBe("recovery-pending");
      rejected.settle("rejected");

      const accepted = acceptRestartConfig(configB);
      expect(accepted.debt).toBeDefined();
      if (!accepted.debt) {
        throw new Error("Expected rejected writer restart debt");
      }
      const rearmed = requestGatewayRestart(accepted.debt.plan, configB, {
        retainDebtAcrossConfigChanges: accepted.debt.retainDebtAcrossConfigChanges,
      });
      rearmed.settle("committed");

      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
      expect(requestRecoveryRestart.mock.calls[1]?.[0]).toBe(
        "config reload: writer requires restart",
      );
    } finally {
      stopRestartRetries();
    }
  });

  it("reports restart debt until a replacement config retires it", () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValue({ status: "failed" });
    const handlers = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const restartPlan = {
      ...createHotTailPlan(),
      changedPaths: ["gateway.port"],
      restartGateway: true,
      restartReasons: ["gateway.port"],
      hotReasons: [],
    } satisfies GatewayReloadPlan;

    try {
      expect(handlers.hasOutstandingGatewayRestart()).toBe(false);
      const restart = handlers.requestGatewayRestart(restartPlan, {
        gateway: { port: 19_001 },
      });
      restart.settle("rejected");
      expect(handlers.hasOutstandingGatewayRestart()).toBe(true);

      expect(handlers.acceptRestartConfig({})).toEqual({ retireRejectedRestart: true });
      expect(handlers.hasOutstandingGatewayRestart()).toBe(false);
    } finally {
      handlers.stopRestartRetries();
    }
  });

  it("preserves deferred hot-recovery debt across unrelated accepted config changes", async () => {
    const requestRecoveryRestart = vi.fn<
      NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>
    >(() => ({ status: "emitted" }));
    const channels = {
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => {
        hoisted.activeTaskBlockers.push(
          makeActiveTaskBlocker({ taskId: "discord-recovery-blocker" }),
        );
        throw new Error("discord restart failed");
      }),
    };
    const {
      acceptRestartConfig,
      applyHotReload,
      beginGatewayRestartLifecycle,
      pauseGatewayRestartForConfigCandidate,
      requestGatewayRestart,
      stopRestartRetries,
    } = createReloadHandlersForTest(
      undefined,
      channels,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const configA = {
      channels: { discord: { token: "discord-token-a" } },
      logging: { level: "info" },
    } as OpenClawConfig;
    const configC = {
      ...configA,
      logging: { level: "debug" },
    } as OpenClawConfig;
    const configB = {
      ...configA,
      gateway: { port: 19_001 },
    } as OpenClawConfig;
    const plan = createHotTailPlan({
      changedPaths: ["channels.discord.token", "logging.level"],
      hotReasons: ["channels.discord.token"],
      restartChannels: new Set<ChannelKind>(["discord"]),
      noopPaths: ["logging.level"],
    }) satisfies GatewayReloadPlan;
    const configRestartPlan = {
      ...createHotTailPlan(),
      changedPaths: ["gateway.port"],
      restartGateway: true,
      restartReasons: ["gateway.port"],
      hotReasons: [],
    } satisfies GatewayReloadPlan;
    vi.useFakeTimers();

    try {
      await applyHotReload(plan, configA);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();

      pauseGatewayRestartForConfigCandidate();
      const replacementLifecycle = beginGatewayRestartLifecycle();
      const replacement = requestGatewayRestart(configRestartPlan, configB);
      replacement.settle("committed");
      replacementLifecycle.settle("committed");
      expect(requestRecoveryRestart).not.toHaveBeenCalled();

      // Hot C supersedes and retires B's config-owned restart. Recovery A must
      // remain independently debt-eligible until a real restart is accepted.
      pauseGatewayRestartForConfigCandidate();
      hoisted.activeTaskBlockers.length = 0;
      await vi.advanceTimersByTimeAsync(500);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();

      const accepted = acceptRestartConfig(configC);
      expect(accepted.retireRejectedRestart).toBe(false);
      expect(accepted.debt).toBeDefined();
      if (!accepted.debt) {
        throw new Error("Expected hot-recovery restart debt");
      }
      expect(accepted.debt.plan.restartReasons).toEqual([
        "hot reload recovery: channel restart (discord)",
      ]);
      const rearmed = requestGatewayRestart(accepted.debt.plan, configC, {
        retainDebtAcrossConfigChanges: accepted.debt.retainDebtAcrossConfigChanges,
      });
      rearmed.settle("committed");

      expect(requestRecoveryRestart.mock.calls).toEqual([
        ["config reload: hot reload recovery: channel restart (discord)"],
      ]);
    } finally {
      hoisted.activeTaskBlockers.length = 0;
      stopRestartRetries();
    }
  });

  it("retires conservative hot-recovery debt after a replacement restart emits", async () => {
    const requestRecoveryRestart = vi.fn<
      NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>
    >(() => ({ status: "emitted" }));
    const channels = {
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => {
        hoisted.activeTaskBlockers.push(
          makeActiveTaskBlocker({ taskId: "discord-recovery-clear-blocker" }),
        );
        throw new Error("discord restart failed");
      }),
    };
    const {
      acceptRestartConfig,
      applyHotReload,
      beginGatewayRestartLifecycle,
      hasOutstandingGatewayRestart,
      pauseGatewayRestartForConfigCandidate,
      requestGatewayRestart,
      stopRestartRetries,
    } = createReloadHandlersForTest(
      undefined,
      channels,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const configA = {
      channels: { discord: { token: "discord-token-a" } },
    } as OpenClawConfig;
    const configB = {
      ...configA,
      gateway: { port: 19_001 },
    } as OpenClawConfig;
    const recoveryPlan = {
      ...createHotTailPlan(),
      changedPaths: ["channels.discord.token"],
      hotReasons: ["channels.discord.token"],
      restartChannels: new Set<ChannelKind>(["discord"]),
    } satisfies GatewayReloadPlan;
    const configRestartPlan = {
      ...createHotTailPlan(),
      changedPaths: ["gateway.port"],
      restartGateway: true,
      restartReasons: ["gateway.port"],
      hotReasons: [],
    } satisfies GatewayReloadPlan;
    vi.useFakeTimers();

    try {
      await applyHotReload(recoveryPlan, configA);
      pauseGatewayRestartForConfigCandidate();
      const replacementLifecycle = beginGatewayRestartLifecycle();
      const replacement = requestGatewayRestart(configRestartPlan, configB);
      replacement.settle("committed");
      replacementLifecycle.settle("committed");

      hoisted.activeTaskBlockers.length = 0;
      await vi.advanceTimersByTimeAsync(500);
      expect(requestRecoveryRestart).toHaveBeenCalledOnce();
      expect(requestRecoveryRestart).toHaveBeenCalledWith("config reload: gateway.port", undefined);

      pauseGatewayRestartForConfigCandidate();
      const accepted = acceptRestartConfig(configA);
      expect(accepted).toEqual({ retireRejectedRestart: true });
      expect(hasOutstandingGatewayRestart()).toBe(false);
    } finally {
      hoisted.activeTaskBlockers.length = 0;
      stopRestartRetries();
    }
  });

  it("does not schedule post-commit hot recovery after restart handling stops", async () => {
    let markChannelStart: (() => void) | undefined;
    const channelStart = new Promise<void>((resolve) => {
      markChannelStart = resolve;
    });
    let releaseChannelStart: (() => void) | undefined;
    const channelStartBlocked = new Promise<void>((resolve) => {
      releaseChannelStart = resolve;
    });
    const requestRecoveryRestart = vi.fn<
      NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>
    >(() => ({ status: "emitted" }));
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload, stopRestartRetries } = createReloadHandlersForTest(
      logReload,
      {
        stop: vi.fn(async () => {}),
        start: vi.fn(async () => {
          markChannelStart?.();
          await channelStartBlocked;
          throw new Error("channel start failed during shutdown");
        }),
      },
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const plan = {
      ...createHotTailPlan(),
      changedPaths: ["channels.discord.token"],
      hotReasons: ["channels.discord.token"],
      restartChannels: new Set<ChannelKind>(["discord"]),
    } satisfies GatewayReloadPlan;

    const reloadPromise = applyHotReload(plan, {
      channels: { discord: { token: "next-token" } },
    });
    await channelStart;
    stopRestartRetries();
    releaseChannelStart?.();
    await reloadPromise;

    expect(requestRecoveryRestart).not.toHaveBeenCalled();
    expect(logReload.warn).toHaveBeenCalledWith(
      "channel restart (discord) failed during gateway shutdown",
    );
  });

  it("cancels a failed restart retry when a newer restart supersedes it", async () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    vi.useFakeTimers();

    try {
      expect(
        requestGatewayRestart(createGatewayRestartPlan(), { gateway: { port: 18790 } }).status,
      ).toBe("recovery-pending");

      expect(
        requestGatewayRestart(createGatewayRestartPlan("gateway.auth"), {
          gateway: { port: 18791 },
        }).status,
      ).toBe("accepted");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      stopRestartRetries();
    }
  });

  it("holds root admission across an immediate config-reload restart signal", () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    const { requestGatewayRestart } = createReloadHandlersForTest();

    try {
      expect(requestGatewayRestart(createGatewayRestartPlan(), {}).status).toBe("accepted");

      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();

      markGatewaySigusr1RestartHandled();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("defers config restart until a background exec actually exits", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlersForTest(logReload);
    const session = createProcessSessionFixture({
      id: "background-restart-blocker",
      command: "private command",
      pid: 12345,
    });
    addSession(session);
    markBackgrounded(session);
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      expect(requestGatewayRestart(createGatewayRestartPlan(), {}).status).toBe("accepted");

      expect(signalSpy).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        "config change requires gateway restart (gateway.port) — deferring until 1 background exec session(s) complete",
      );

      markExited(session, 0, null, "completed");
      await vi.advanceTimersByTimeAsync(500);

      expect(signalSpy).toHaveBeenCalledOnce();
      expect(logReload.info).toHaveBeenCalledWith(
        "all operations and replies completed; restarting gateway now",
      );
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("keeps retrying a deferred restart until signal admission succeeds", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      logReload,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    const session = createProcessSessionFixture({
      id: "background-restart-retry",
      command: "private command",
      pid: 12346,
    });
    addSession(session);
    markBackgrounded(session);
    vi.useFakeTimers();

    try {
      expect(requestGatewayRestart(createGatewayRestartPlan(), {}).status).toBe("accepted");

      markExited(session, 0, null, "completed");
      await vi.advanceTimersByTimeAsync(500);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);
      expect(logReload.warn).toHaveBeenCalledWith(
        "gateway restart recovery emission failed; retrying",
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(3);
    } finally {
      stopRestartRetries();
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("defers config restart across an admitted process handoff", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlersForTest(logReload);
    const handoff = tryBeginGatewayRootWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      expect(requestGatewayRestart(createGatewayRestartPlan(), {}).status).toBe("accepted");
      expect(signalSpy).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        "config change requires gateway restart (gateway.port) — deferring until 1 gateway request(s) complete",
      );

      handoff?.release();
      await vi.advanceTimersByTimeAsync(500);

      expect(signalSpy).toHaveBeenCalledOnce();
    } finally {
      handoff?.release();
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("defers channel hot reload until active embedded work drains", async () => {
    const restoreChannelReloadEnv = enableChannelReloadsForTest();
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const setState = vi.fn();
    let runtimePublished = false;
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      setState,
      startChannel,
      stopChannel,
      logReload,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      createHotTailPlan({
        changedPaths: ["channels.discord.token"],
        hotReasons: ["channels.discord.token"],
        restartChannels: new Set(["discord"]),
      }),
      {
        gateway: { reload: {} },
        channels: { discord: { token: "token" } },
      },
      {
        sourceConfig: {
          gateway: { reload: {} },
          channels: { discord: { token: "token" } },
        },
        isCurrent: () => true,
        publish: async (commit) => {
          runtimePublished = true;
          await commit();
        },
      },
    );
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();
      expect(runtimePublished).toBe(false);
      expect(setState).not.toHaveBeenCalled();

      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500);
      await reloadPromise;
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reloadPromise.catch(() => {});
      restoreChannelReloadEnv();
    }

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord", undefined, {
      preserveManualStop: true,
      skipUnavailableAccounts: true,
    });
    expect(runtimePublished).toBe(true);
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("uses the default channel reload deferral timeout when config omits deferralTimeoutMs", async () => {
    const restoreChannelReloadEnv = enableChannelReloadsForTest();
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      startChannel,
      stopChannel,
      logReload,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      createHotTailPlan({
        changedPaths: ["channels.telegram.botToken"],
        hotReasons: ["channels.telegram.botToken"],
        restartChannels: new Set(["telegram"]),
      }),
      {
        channels: { telegram: { botToken: "token" } },
      },
    );
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(299_500);
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await reloadPromise;
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reloadPromise.catch(() => {});
      restoreChannelReloadEnv();
    }

    expect(stopChannel).toHaveBeenCalledWith("telegram", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("telegram", undefined, {
      preserveManualStop: true,
      skipUnavailableAccounts: true,
    });
    expect(logReload.warn).toHaveBeenCalledWith(
      expect.stringContaining("channel reload timeout after"),
    );
  });

  it("logs active task run ids before waiting and when forcing after timeout", async () => {
    restartTesting.resetSigusr1State();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlersForTest(logReload);
    hoisted.activeTaskCount.value = 1;
    hoisted.activeEmbeddedRunSessionIds.push("session-issue-82433");
    hoisted.activeEmbeddedRunSessionKeys.push("agent:main:issue-82433");
    hoisted.activeTaskBlockers.push(
      makeActiveTaskBlocker({
        taskId: "task-nightly",
        runId: "run-nightly",
        runtime: "cron",
        label: "nightly sync",
        title: "refresh all accounts",
      }),
    );
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      requestGatewayRestart(createGatewayRestartPlan(), {
        gateway: { reload: {} },
      });

      expect(logReload.warn.mock.calls).toEqual(
        expect.arrayContaining([
          [
            "config change requires gateway restart (gateway.port) — deferring until 1 background task run(s) complete",
          ],
          [
            "restart blocked by active background task run(s): taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts",
          ],
        ]),
      );

      await vi.advanceTimersByTimeAsync(300_000);
      await Promise.resolve();

      expect(signalSpy).toHaveBeenCalledTimes(1);
      expect(consumeGatewaySigusr1RestartIntent()).toEqual({
        force: true,
        reason: "config reload forced restart",
      });
      expect(hoisted.markRestartAbortedMainSessions).not.toHaveBeenCalled();
      expect(logReload.warn.mock.calls).toEqual(
        expect.arrayContaining([
          [
            "config change requires gateway restart (gateway.port) — deferring until 1 background task run(s) complete",
          ],
          [
            "restart blocked by active background task run(s): taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts",
          ],
          [
            "restart timeout after 300000ms with 1 background task run(s) still active (taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts); forcing restart",
          ],
        ]),
      );
    } finally {
      hoisted.activeTaskCount.value = 0;
      vi.useRealTimers();
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
    }
  });

  it("uses the default restart deferral timeout when config omits deferralTimeoutMs", async () => {
    restartTesting.resetSigusr1State();
    const { requestGatewayRestart } = createReloadHandlersForTest();
    hoisted.activeTaskCount.value = 1;
    hoisted.activeTaskBlockers.push(makeActiveTaskBlocker({ taskId: "task-running-1" }));
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      requestGatewayRestart(createGatewayRestartPlan(), {});

      await vi.advanceTimersByTimeAsync(299_500);
      expect(signalSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(signalSpy).toHaveBeenCalledTimes(1);
    } finally {
      hoisted.activeTaskCount.value = 0;
      process.removeListener("SIGUSR1", signalSpy);
      vi.useRealTimers();
      restartTesting.resetSigusr1State();
    }
  });
});

describe("gateway channel hot reload handlers", () => {
  function createChannelReloadPlan(channels: ChannelKind[]): GatewayReloadPlan {
    return createHotTailPlan({
      changedPaths: channels.map((channel) => `channels.${channel}.enabled`),
      hotReasons: ["channels"],
      restartChannels: new Set(channels),
    });
  }

  async function withChannelReloadsEnabled<T>(run: () => Promise<T>): Promise<T> {
    const restoreChannelReloadEnv = enableChannelReloadsForTest();
    try {
      return await run();
    } finally {
      restoreChannelReloadEnv();
    }
  }

  function createAccountReloadPlan(
    accountIds: string[],
    overrides: Partial<GatewayReloadPlan> = {},
  ): GatewayReloadPlan {
    return {
      ...createChannelReloadPlan([]),
      changedPaths: accountIds.map((accountId) => `channels.discord.accounts.${accountId}`),
      restartChannelAccounts: new Map([["discord", new Set(accountIds)]]),
      ...overrides,
    };
  }

  async function withDiscordAccountResolver(
    listAccountIds: () => string[],
    run: () => Promise<void>,
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => unknown = () => ({}),
  ) {
    const registry = createTestRegistry([
      {
        pluginId: "discord",
        plugin: {
          ...createChannelTestPluginBase({
            id: "discord",
            config: { listAccountIds, resolveAccount },
          }),
        },
        source: "test",
      },
    ]);
    setActivePluginRegistry(registry);
    try {
      await run();
    } finally {
      resetPluginRuntimeStateForTest();
    }
  }

  async function withDiscordAccounts(accountIds: string[], run: () => Promise<void>) {
    await withDiscordAccountResolver(() => accountIds, run);
  }

  it("restarts only the changed account", async () => {
    const events: string[] = [];
    const startRootCounts: number[] = [];
    const accountStopSettled = createDeferred();
    const channels = {
      stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`stop:${channel}:${accountId}`);
        await accountStopSettled.promise;
      }),
      start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`start:${channel}:${accountId}`);
        startRootCounts.push(getActiveGatewayRootWorkCount({ excludeCurrent: true }));
      }),
    };
    const { applyHotReload } = createReloadHandlersForTest(undefined, channels);
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    let reload: Promise<GatewayHotReloadApplicationStatus> | undefined;

    try {
      await root?.run(async () => {
        await withChannelReloadsEnabled(async () => {
          await withDiscordAccounts(["default", "alpha", "beta"], async () => {
            reload = applyHotReload(createAccountReloadPlan(["alpha"]), {});
            await waitForFast(() => expect(events).toEqual(["stop:discord:alpha"]));
            expect(channels.start).not.toHaveBeenCalled();

            accountStopSettled.resolve();
            await reload;
          });
        });
      });
    } finally {
      accountStopSettled.resolve();
      await reload?.catch(() => {});
      root?.release();
    }

    expect(events).toEqual(["stop:discord:alpha", "start:discord:alpha"]);
    expect(startRootCounts).toEqual([1]);
    expect(channels.stop).toHaveBeenCalledOnce();
    expect(channels.start).toHaveBeenCalledOnce();
  });

  it("continues targeted restarts after an account failure", async () => {
    const events: string[] = [];
    const channels = {
      stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`stop:${channel}:${accountId}`);
        if (accountId === "alpha") {
          throw new Error("stop failed");
        }
      }),
      start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`start:${channel}:${accountId}`);
      }),
    };
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const { applyHotReload } = createReloadHandlersForTest(
      undefined,
      channels,
      undefined,
      undefined,
      requestRecoveryRestart,
    );

    await withChannelReloadsEnabled(async () => {
      await withDiscordAccounts(["default", "alpha", "beta"], async () => {
        await applyHotReload(createAccountReloadPlan(["alpha", "beta"]), {});
      });
    });

    expect(events).toEqual(["stop:discord:alpha", "stop:discord:beta", "start:discord:beta"]);
    expect(requestRecoveryRestart).toHaveBeenCalledOnce();
  });

  it("promotes unlisted accounts to a wholesale restart", async () => {
    const events: string[] = [];
    const channels = createRecordedChannelHandlers(events);
    const { applyHotReload } = createReloadHandlersForTest(undefined, channels);

    await withChannelReloadsEnabled(async () => {
      await withDiscordAccounts(["default", "alpha"], async () => {
        await applyHotReload(createAccountReloadPlan(["removed-account"]), {});
      });
    });

    expect(events).toEqual(["stop:discord:undefined", "start:discord:undefined"]);
  });

  it("promotes unresolvable accounts to a wholesale restart before stopping any account", async () => {
    const events: string[] = [];
    const channels = createRecordedChannelHandlers(events);
    const { applyHotReload, logChannels } = createReloadHandlersForTest(undefined, channels);

    await withChannelReloadsEnabled(async () => {
      await withDiscordAccountResolver(
        () => ["default", "alpha", "beta"],
        async () => {
          await applyHotReload(createAccountReloadPlan(["alpha", "beta"]), {});
        },
        (_cfg, accountId) => {
          if (accountId === "beta") {
            throw new Error("account resolution failed");
          }
          return {};
        },
      );
    });

    expect(events).toEqual(["stop:discord:undefined", "start:discord:undefined"]);
    expect(logChannels.info).toHaveBeenCalledWith(
      "promoting discord account reload to whole-channel restart after account resolution failed: account resolution failed",
    );
  });

  it("requests recovery when account enumeration fails after config commit", async () => {
    const channels = {
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
    };
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const { applyHotReload } = createReloadHandlersForTest(
      undefined,
      channels,
      undefined,
      undefined,
      requestRecoveryRestart,
    );

    await withChannelReloadsEnabled(async () => {
      await withDiscordAccountResolver(
        () => {
          throw new Error("account enumeration failed");
        },
        async () => {
          await applyHotReload(createAccountReloadPlan(["alpha"]), {});
        },
      );
    });

    expect(channels.stop).not.toHaveBeenCalled();
    expect(channels.start).not.toHaveBeenCalled();
    expect(requestRecoveryRestart).toHaveBeenCalledOnce();
  });

  it("skips per-account restarts for channels already queued for wholesale restart", async () => {
    const events: string[] = [];
    const channels = createRecordedChannelHandlers(events);
    const { applyHotReload } = createReloadHandlersForTest(undefined, channels);

    await withChannelReloadsEnabled(async () => {
      await withDiscordAccounts(["default", "alpha"], async () => {
        await applyHotReload(
          createAccountReloadPlan(["alpha"], { restartChannels: new Set(["discord"]) }),
          {},
        );
      });
    });

    expect(events).toEqual(["stop:discord:undefined", "start:discord:undefined"]);
  });

  it("aggregates targeted and wholesale stop failures into one suppressed recovery request", async () => {
    const events: string[] = [];
    const channels = {
      stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`stop:${channel}:${accountId}`);
        throw new Error("stop failed");
      }),
      start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`start:${channel}:${accountId}`);
      }),
    };
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const { applyHotReload } = createReloadHandlersForTest(
      undefined,
      channels,
      undefined,
      undefined,
      requestRecoveryRestart,
      {
        getChannelAutostartSuppression: () => ({
          reason: "crash-loop-breaker",
          message: "safe mode",
        }),
      },
    );

    await withChannelReloadsEnabled(async () => {
      await withDiscordAccounts(["default", "alpha"], async () => {
        await applyHotReload(
          createAccountReloadPlan(["alpha"], {
            restartChannels: new Set<ChannelKind>(["telegram"]),
          }),
          {},
        );
      });
    });

    expect(events).toEqual(["stop:discord:alpha", "stop:telegram:undefined"]);
    expect(requestRecoveryRestart).toHaveBeenCalledOnce();
  });

  it("stops account targets without restarting them while autostart is suppressed", async () => {
    const events: string[] = [];
    const channels = createRecordedChannelHandlers(events);
    const { applyHotReload } = createReloadHandlersForTest(
      undefined,
      channels,
      undefined,
      undefined,
      true,
      {
        getChannelAutostartSuppression: () => ({
          reason: "crash-loop-breaker",
          message: "safe mode",
        }),
      },
    );

    await withChannelReloadsEnabled(async () => {
      await withDiscordAccounts(["default", "alpha"], async () => {
        await applyHotReload(createAccountReloadPlan(["alpha"]), {});
      });
    });

    expect(events).toEqual(["stop:discord:alpha"]);
  });

  it("rechecks agent work admitted after plugin reload leaves the channel running", async () => {
    const events: string[] = [];
    const channels = createRecordedChannelHandlers(events);
    const reloadPlugins = vi.fn(async (params): Promise<GatewayPluginReloadResult> => {
      await params.beforeReplace(new Set());
      hoisted.activeEmbeddedRunCount.value = 1;
      return makePluginReloadResult({ activeChannels: new Set(["discord"]) });
    });
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createReloadHandlersForTest(logReload, channels, reloadPlugins);
    vi.useFakeTimers();
    let reload: Promise<GatewayHotReloadApplicationStatus> | undefined;

    try {
      await withChannelReloadsEnabled(async () => {
        await withDiscordAccounts(["default", "alpha"], async () => {
          reload = applyHotReload(createAccountReloadPlan(["alpha"], { reloadPlugins: true }), {});
          await vi.advanceTimersByTimeAsync(0);
          expect(events).toEqual([]);
          expect(logReload.warn).toHaveBeenCalledWith(expect.stringContaining("(discord)"));

          hoisted.activeEmbeddedRunCount.value = 0;
          await vi.advanceTimersByTimeAsync(500);
          await reload;
        });
      });
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reload?.catch(() => {});
    }

    expect(events).toEqual(["stop:discord:alpha", "start:discord:alpha"]);
    expect(reloadPlugins).toHaveBeenCalledOnce();
  });

  it("requires a recovery owner for targeted account reloads", async () => {
    const { applyHotReload } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );

    await expect(applyHotReload(createAccountReloadPlan(["alpha"]), {})).rejects.toThrow(
      "config reload requires a managed gateway restart owner for irreversible hot reload",
    );
  });

  it("refuses channel restarts while crash-loop safe mode suppresses autostart", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const { applyHotReload } = createGatewayReloadHandlers({
      startChannel: channels.start,
      stopChannel: channels.stop,
      getChannelAutostartSuppression: () => ({
        reason: "crash-loop-breaker",
        message: "safe mode",
      }),
      logChannels,
    });

    await withChannelReloadsEnabled(() => applyHotReload(createChannelReloadPlan(["discord"]), {}));

    expect(channels.stop).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(channels.start).not.toHaveBeenCalled();
    expect(logChannels.info).toHaveBeenCalledWith(
      "stopping discord channel before suppressed hot reload",
    );
    expect(logChannels.info).toHaveBeenCalledWith(
      "channel restart during hot reload suppressed by crash-loop breaker for channels: discord",
    );
  });

  it("restarts WhatsApp when the planner receives a selfChatMode change", async () => {
    const whatsappPlugin = {
      ...createChannelTestPluginBase({ id: "whatsapp" }),
      reload: {
        configPrefixes: ["web", "channels.whatsapp.accounts", "channels.whatsapp.selfChatMode"],
        noopPrefixes: ["channels.whatsapp"],
      },
    };
    const registry = createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    ]);
    const events: string[] = [];
    const channels = {
      stop: vi.fn(async (channel: ChannelKind) => {
        events.push(`stop:${channel}`);
      }),
      start: vi.fn(async (channel: ChannelKind) => {
        events.push(`start:${channel}`);
      }),
    };

    setActivePluginRegistry(registry);
    try {
      const plan = buildGatewayReloadPlan(["channels.whatsapp.selfChatMode"]);
      const { applyHotReload } = createReloadHandlersForTest(undefined, channels);

      expect(plan.restartGateway).toBe(false);
      expect(plan.restartChannels).toEqual(new Set(["whatsapp"]));
      await withChannelReloadsEnabled(() => applyHotReload(plan, {}));

      expect(events).toEqual(["stop:whatsapp", "start:whatsapp"]);
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it.each([
    {
      name: "stop",
      expectedEvents: ["stop:telegram", "stop:discord", "start:discord"],
    },
    {
      name: "start",
      expectedEvents: ["stop:telegram", "start:telegram", "stop:discord", "start:discord"],
    },
  ])("continues restarting later channels after a hot-reload $name failure", async (testCase) => {
    const events: string[] = [];
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
      if (channel === "telegram" && testCase.name === "stop") {
        throw new Error("stop failed");
      }
    });
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
      if (channel === "telegram" && testCase.name === "start") {
        throw new Error("start failed");
      }
    });
    const { applyHotReload } = createGatewayReloadHandlers({
      setState,
      startChannel,
      stopChannel,
      logChannels,
      logReload,
    });

    await withGatewayRestartSignal(async (signalSpy) => {
      await withChannelReloadsEnabled(async () => {
        await expect(
          applyHotReload(createChannelReloadPlan(["telegram", "discord"]), {}),
        ).resolves.toBe("applied-restart-required");
      });
      expect(signalSpy).toHaveBeenCalledOnce();
    });

    expect(events).toEqual(testCase.expectedEvents);
    expect(logChannels.error).toHaveBeenCalledWith(
      `failed to restart telegram channel during hot reload: ${testCase.name} failed`,
    );
    expect(setState).toHaveBeenCalledTimes(1);
    expect(logReload.warn).toHaveBeenCalledWith(
      "channel restart (telegram) failed after config commit; restarting gateway",
    );
  });
});

describe("gateway Gmail hot reload handlers", () => {
  function createGmailReloadPlan(): GatewayReloadPlan {
    return createHotTailPlan({
      changedPaths: ["hooks.gmail.account"],
      hotReasons: ["hooks.gmail.account"],
      restartGmailWatcher: true,
    });
  }

  function createGmailConfig(account: string): OpenClawConfig {
    return {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", gmail: { account } },
    };
  }

  it("stops queued post-ready sidecars before restarting Gmail watcher", async () => {
    const stopPostReadySidecars = vi.fn();
    const { applyHotReload } = createGatewayReloadHandlers({
      stopPostReadySidecars,
    });
    const nextConfig = {
      hooks: { enabled: true, gmail: { account: "next@example.com" } },
    } as never;

    await applyHotReload(createGmailReloadPlan(), nextConfig);

    expect(hoisted.refreshContextWindowCache).not.toHaveBeenCalled();
    expect(stopPostReadySidecars).toHaveBeenCalledBefore(hoisted.stopGmailWatcher);
    expect(hoisted.startGmailWatcherWithLogs).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: nextConfig }),
    );
  });

  it("restarts when post-ready sidecar teardown fails after runtime commit", async () => {
    await withGatewayRestartSignal(async (signalSpy) => {
      const logReload = { info: vi.fn(), warn: vi.fn() };
      const stopPostReadySidecars = vi.fn(async () => {
        throw new Error("sidecar stop failed");
      });
      const { applyHotReload, setState } = createReloadHandlersForTest(
        logReload,
        undefined,
        undefined,
        stopPostReadySidecars,
      );

      await expect(
        applyHotReload(createGmailReloadPlan(), createGmailConfig("next@example.com")),
      ).resolves.toBe("applied-restart-required");

      expect(stopPostReadySidecars).toHaveBeenCalledOnce();
      expect(setState).toHaveBeenCalledOnce();
      expect(logReload.warn).toHaveBeenCalledWith(
        "gmail watcher reload failed after config commit: sidecar stop failed; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    });
  });

  it("passes a cancellable signal to Gmail watcher restarts", async () => {
    const abortController = new AbortController();
    const clearGmailRestartAbortController = vi.fn();
    const { applyHotReload } = createGatewayReloadHandlers({
      createGmailRestartAbortController: () => abortController,
      clearGmailRestartAbortController,
    });
    const nextConfig = createGmailConfig("next@example.com");

    await applyHotReload(createGmailReloadPlan(), nextConfig);

    const [restartParams] = hoisted.startGmailWatcherWithLogs.mock.calls[0] ?? [];
    expect(restartParams).toMatchObject({ cfg: nextConfig });
    expect(restartParams?.signal).toBe(abortController.signal);
    expect(restartParams?.signal?.aborted).toBe(false);
    abortController.abort();
    expect(restartParams?.signal?.aborted).toBe(true);
    expect(clearGmailRestartAbortController).toHaveBeenCalledWith(abortController);
  });

  it("retries managed no-op reloads without publishing superseded secret failures", async () => {
    vi.useFakeTimers();
    const writeListenerRef = createConfigWriteListenerRef();
    const initialConfig: OpenClawConfig = {
      gateway: { reload: {} },
      messages: { visibleReplies: "automatic" },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: {} },
      messages: { visibleReplies: "message_tool" },
    };
    const snapshot = (config: OpenClawConfig) => makePreparedSecretsSnapshot(config);
    let preparationAttempt = 0;
    const { activateRuntimeSecrets, prepareRuntimeSecretsSnapshot, emitStateEvent, logSecrets } =
      createTestRuntimeSecretsActivator(async ({ config }) => {
        const attempt = preparationAttempt++;
        if (attempt === 0) {
          activateSecretsRuntimeSnapshot(snapshot(initialConfig));
          // A typed failure would publish degradation if the superseded owner were still valid.
          throw refResolutionError({
            code: "SECRET_REF_NOT_FOUND",
            source: "env",
            provider: "default",
            refId: "SUPERSEDED_RELOAD_REF",
            message: "superseded secret preparation failure",
          });
        }
        if (attempt === 1) {
          queueMicrotask(() => {
            queueMicrotask(() => activateSecretsRuntimeSnapshot(snapshot(initialConfig)));
          });
        }
        return snapshot(config);
      });
    const heartbeatRunner = { stop: vi.fn(), updateConfig: vi.fn() };
    const acceptTerminalConfig = vi.fn();
    const commitTerminalConfig = vi.fn();
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () => createValidConfigSnapshot(nextConfig, "hash-next")) as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef),
      getState: () =>
        createDefaultGatewayReloadState({
          heartbeatRunner: heartbeatRunner as never,
          cronState: createTestCronState(),
        }),
      activateRuntimeSecrets,
      commitTerminalConfig,
      acceptTerminalConfig,
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener(
      createConfigWriteNotification(
        nextConfig,
        "hash-next",
        1,
        "runtime-hash-next",
        "source-hash-next",
      ),
    );
    await vi.runAllTimersAsync();

    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(3);
    expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledWith({
      config: nextConfig,
      allowUnavailableSecretOwners: true,
      includeAuthStoreRefs: undefined,
      forceColdRefKeys: undefined,
      manifestRegistry: undefined,
    });
    expect(emitStateEvent).not.toHaveBeenCalled();
    expect(logSecrets.warn).not.toHaveBeenCalled();
    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(nextConfig);
    expect(acceptTerminalConfig).toHaveBeenCalledWith({
      retireRejectedRestart: true,
    });
    expect(heartbeatRunner.updateConfig).not.toHaveBeenCalled();
    expect(commitTerminalConfig).toHaveBeenCalledWith(nextConfig);
    await reloader.stop();
  });

  it("refreshes owner refs when only the resolved source snapshot changes", async () => {
    vi.useFakeTimers();
    const authAgentDir = "/tmp/openclaw-source-only-auth-owner";
    const authProfileId = "openai:source-only";
    const authOwnerId = resolveAuthProfileSecretOwnerId({
      agentDir: authAgentDir,
      profileId: authProfileId,
    });
    const firstRef = { source: "env" as const, provider: "default", id: "TTS_FIRST" };
    const secondRef = { source: "env" as const, provider: "default", id: "TTS_SECOND" };
    const thirdRef = { source: "env" as const, provider: "default", id: "TTS_THIRD" };
    const fourthRef = { source: "env" as const, provider: "default", id: "TTS_FOURTH" };
    const sourceConfig = (ref: typeof firstRef): OpenClawConfig => ({
      gateway: { reload: {} },
      tts: { providers: { elevenlabs: { apiKey: ref } } },
    });
    const runtimeConfig: OpenClawConfig = {
      gateway: { reload: {} },
      tts: { providers: { elevenlabs: { apiKey: String(42) } } },
    };
    const ttsContractDigest = "tts-source-only-contract";
    const initialSourceConfig = sourceConfig(firstRef);
    const nextSourceConfig = sourceConfig(secondRef);
    const activeWarning = {
      code: "SECRETS_OWNER_UNAVAILABLE" as const,
      path: "tts.providers.elevenlabs.apiKey",
      message: "Text-to-speech remains unavailable.",
    };
    activateSecretsRuntimeSnapshot(
      makePreparedSecretsSnapshot(initialSourceConfig, {
        config: runtimeConfig,
        authStores: [
          {
            agentDir: authAgentDir,
            store: {
              version: 1,
              profiles: {
                [authProfileId]: {
                  type: "api_key",
                  provider: "openai",
                  key: String(42),
                  keyRef: { source: "env", provider: "default", id: "AUTH_FIRST" },
                },
              },
            },
          },
        ],
        warnings: [activeWarning],
        degradedOwners: [
          {
            ownerKind: "capability",
            ownerId: "tts",
            state: "unavailable",
            paths: ["tts.providers.elevenlabs.apiKey"],
            refKeys: ["env:default:TTS_FIRST"],
            reason: "secret reference was not found",
          },
          {
            ownerKind: "account",
            ownerId: authOwnerId,
            state: "unavailable",
            paths: [`${authAgentDir}.auth-profiles.${authProfileId}.key`],
            refKeys: ["env:default:AUTH_FIRST"],
            reason: "secret provider failed",
          },
        ],
        secretOwners: [
          {
            ownerKind: "capability",
            ownerId: "tts",
            refKeys: ["env:default:TTS_FIRST"],
            contractDigest: ttsContractDigest,
          },
          {
            ownerKind: "account",
            ownerId: authOwnerId,
            refKeys: ["env:default:AUTH_FIRST"],
          },
        ],
      }),
    );
    const writeListenerRef = createConfigWriteListenerRef();
    const { activateRuntimeSecrets, prepareRuntimeSecretsSnapshot } =
      createTestRuntimeSecretsActivator(async ({ config }) =>
        makePreparedSecretsSnapshot(config, {
          config: runtimeConfig,
          authStores: [
            {
              agentDir: authAgentDir,
              store: {
                version: 1,
                profiles: {
                  [authProfileId]: {
                    type: "api_key" as const,
                    provider: "openai",
                    key: String(42),
                    keyRef: { source: "env" as const, provider: "default", id: "AUTH_SECOND" },
                  },
                },
              },
            },
          ],
          secretOwners: [
            {
              ownerKind: "capability" as const,
              ownerId: "tts",
              refKeys: ["env:default:TTS_SECOND"],
              contractDigest: ttsContractDigest,
            },
            {
              ownerKind: "account" as const,
              ownerId: authOwnerId,
              refKeys: ["env:default:AUTH_SECOND"],
            },
          ],
        }),
      );
    const reloader = startManagedGatewayConfigReloader({
      initialConfig: runtimeConfig,
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: nextSourceConfig,
        sourceConfig: nextSourceConfig,
        resolved: runtimeConfig,
        valid: true,
        runtimeConfig,
        config: runtimeConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "same-runtime-next-source",
      })) as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef),
      prepareConfigCandidate: ({ runtimeConfig: candidateRuntime }) => ({
        runtimeConfig: candidateRuntime,
        compareConfig: candidateRuntime,
      }),
      activateRuntimeSecrets,
    });

    try {
      const listener = writeListenerRef.current;
      if (!listener) {
        throw new Error("Expected config write listener to be registered");
      }
      const unrelatedSourceConfig = {
        ...initialSourceConfig,
        logging: { level: "info" as const },
      };
      listener(
        createConfigWriteNotification(
          unrelatedSourceConfig,
          "same-secrets-new-source",
          1,
          "same-runtime",
          "same-secrets-new-source",
          { runtimeConfig },
        ),
      );
      await vi.runAllTimersAsync();

      expect(prepareRuntimeSecretsSnapshot).not.toHaveBeenCalled();
      expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(unrelatedSourceConfig);
      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual([activeWarning]);
      expect(getActiveSecretsRuntimeSnapshot()?.secretOwners).toEqual([
        {
          ownerKind: "capability",
          ownerId: "tts",
          refKeys: ["env:default:TTS_FIRST"],
          contractDigest: ttsContractDigest,
        },
        {
          ownerKind: "account",
          ownerId: authOwnerId,
          refKeys: ["env:default:AUTH_FIRST"],
        },
      ]);

      listener(
        createConfigWriteNotification(
          nextSourceConfig,
          "same-runtime-next-source",
          2,
          "same-runtime",
          "next-source",
          { runtimeConfig },
        ),
      );
      await vi.runAllTimersAsync();

      expect(prepareRuntimeSecretsSnapshot.mock.calls[0]?.[0]).toMatchObject({
        config: nextSourceConfig,
        allowUnavailableSecretOwners: true,
        includeAuthStoreRefs: true,
      });
      expect(listActiveDegradedSecretOwners()).toEqual([]);
      expect(getActiveSecretsRuntimeSnapshot()?.secretOwners).toEqual([
        {
          ownerKind: "capability",
          ownerId: "tts",
          refKeys: ["env:default:TTS_SECOND"],
          contractDigest: ttsContractDigest,
        },
        {
          ownerKind: "account",
          ownerId: authOwnerId,
          refKeys: ["env:default:AUTH_SECOND"],
        },
      ]);
      expect(
        getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store.profiles[authProfileId],
      ).toMatchObject({
        key: String(42),
        keyRef: { source: "env", provider: "default", id: "AUTH_SECOND" },
      });
      expect(
        classifySecretOwnerDegradationState({
          ownerKind: "capability",
          ownerId: "tts",
          refs: [secondRef],
          config: nextSourceConfig,
          contractDigest: ttsContractDigest,
        }),
      ).toBe("stale");

      prepareRuntimeSecretsSnapshot.mockImplementationOnce(async ({ config }) =>
        makePreparedSecretsSnapshot(config, {
          config: { ...runtimeConfig, logging: { level: "debug" } },
          secretOwners: [
            {
              ownerKind: "capability" as const,
              ownerId: "tts",
              refKeys: ["env:default:TTS_THIRD"],
              contractDigest: ttsContractDigest,
            },
          ],
        }),
      );
      listener(
        createConfigWriteNotification(
          sourceConfig(thirdRef),
          "changed-second-resolution",
          2,
          "same-runtime",
          "changed-second-resolution",
          { runtimeConfig },
        ),
      );
      await vi.runAllTimersAsync();

      expect(getActiveSecretsRuntimeSnapshot()?.secretOwners).toEqual([
        {
          ownerKind: "capability",
          ownerId: "tts",
          refKeys: ["env:default:TTS_SECOND"],
          contractDigest: ttsContractDigest,
        },
        {
          ownerKind: "account",
          ownerId: authOwnerId,
          refKeys: ["env:default:AUTH_SECOND"],
        },
      ]);

      let releasePreparation = () => {};
      let markPreparationStarted: (() => void) | undefined;
      const preparationStarted = new Promise<void>((resolve) => {
        markPreparationStarted = resolve;
      });
      const preparationGate = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      prepareRuntimeSecretsSnapshot.mockImplementationOnce(async ({ config }) => {
        markPreparationStarted?.();
        await preparationGate;
        return makePreparedSecretsSnapshot(config, {
          config: runtimeConfig,
          secretOwners: [
            {
              ownerKind: "capability" as const,
              ownerId: "tts",
              refKeys: ["env:default:TTS_THIRD"],
              contractDigest: ttsContractDigest,
            },
          ],
        });
      });
      listener(
        createConfigWriteNotification(
          sourceConfig(thirdRef),
          "superseded-source-owner",
          3,
          "same-runtime",
          "superseded-source-owner",
          { runtimeConfig },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await preparationStarted;

      const concurrentSourceConfig = sourceConfig(fourthRef);
      activateSecretsRuntimeSnapshot(
        makePreparedSecretsSnapshot(concurrentSourceConfig, {
          config: runtimeConfig,
          secretOwners: [
            {
              ownerKind: "capability",
              ownerId: "tts",
              refKeys: ["env:default:TTS_FOURTH"],
            },
          ],
        }),
      );
      releasePreparation();
      await vi.runAllTimersAsync();

      expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(concurrentSourceConfig);
      expect(getActiveSecretsRuntimeSnapshot()?.secretOwners).toEqual([
        {
          ownerKind: "capability",
          ownerId: "tts",
          refKeys: ["env:default:TTS_FOURTH"],
        },
      ]);
      expect(hoisted.resetSkillSnapshotConfigFingerprintCache).not.toHaveBeenCalled();
      expect(hoisted.applyLoggingConfig).not.toHaveBeenCalled();
    } finally {
      await reloader.stop();
    }
  });

  it("rejects ownerless irreversible plans but applies safe hot plans", async () => {
    vi.useFakeTimers();
    const initialConfig: OpenClawConfig = {
      gateway: {
        port: 18789,
        reload: {},
        terminal: { enabled: true },
      },
      hooks: {
        enabled: true,
        token: "token-oversized",
        gmail: { account: "old@example.com" },
      },
      logging: { level: "info" },
    };
    const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
    const prepareTerminalConfig = vi.fn((plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
      terminalPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
    });
    const reconcileTerminalSessions = vi.fn();
    const setState = vi.fn();
    const promoteSnapshot = vi.fn(async () => true);
    const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const writeListenerRef = createConfigWriteListenerRef();
    let snapshotConfig = initialConfig;
    let snapshotHash = "initial";
    const { activateRuntimeSecrets, prepareRuntimeSecretsSnapshot } =
      createTestRuntimeSecretsActivator();
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () =>
        createValidConfigSnapshot(snapshotConfig, snapshotHash),
      ) as never,
      promoteSnapshot: promoteSnapshot as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef, false),
      setState,
      logReload,
      activateRuntimeSecrets,
      prepareTerminalConfig,
      reconcileTerminalSessions,
      commitTerminalConfig: terminalPolicy.commitConfig,
      acceptTerminalConfig: terminalPolicy.acceptConfig,
      restartRecoveryAvailable: false,
    });
    let revision = 0;
    const writeConfig = (config: OpenClawConfig, hash: string) => {
      const listener = writeListenerRef.current;
      if (!listener) {
        throw new Error("Expected config write listener to be registered");
      }
      snapshotConfig = config;
      snapshotHash = hash;
      revision += 1;
      listener(
        createConfigWriteNotification(config, hash, revision, `runtime-${hash}`, `source-${hash}`),
      );
    };

    try {
      const rejectedConfigs = [
        {
          label: "restart",
          config: {
            ...initialConfig,
            gateway: { ...initialConfig.gateway, port: 18790, terminal: { enabled: false } },
          },
          surface: "gateway restart",
        },
        {
          label: "plugin",
          config: { ...initialConfig, plugins: { enabled: true } },
          surface: "irreversible hot reload",
        },
        {
          label: "cron",
          config: { ...initialConfig, cron: { enabled: true } },
          surface: "irreversible hot reload",
        },
        {
          label: "gmail",
          config: {
            ...initialConfig,
            hooks: { ...initialConfig.hooks, gmail: { account: "test@example.com" } },
          },
          surface: "irreversible hot reload",
        },
      ] satisfies Array<{ label: string; config: OpenClawConfig; surface: string }>;

      for (const testCase of rejectedConfigs) {
        writeConfig(testCase.config, `${testCase.label}-unsupported`);
        await vi.runAllTimersAsync();

        expect(prepareTerminalConfig).not.toHaveBeenCalled();
        expect(reconcileTerminalSessions).not.toHaveBeenCalled();
        expect(prepareRuntimeSecretsSnapshot).not.toHaveBeenCalled();
        expect(setState).not.toHaveBeenCalled();
        expect(promoteSnapshot).not.toHaveBeenCalled();
        expect(logReload.error).toHaveBeenCalledWith(
          expect.stringContaining(
            `config reload requires a managed gateway restart owner for ${testCase.surface}`,
          ),
        );
        expect(terminalPolicy.isEnabled()).toBe(true);
        logReload.error.mockClear();
      }

      const safeConfig: OpenClawConfig = {
        ...initialConfig,
        logging: { level: "debug" },
      };
      writeConfig(safeConfig, "safe-reload");
      await vi.runAllTimersAsync();

      expect(prepareTerminalConfig).toHaveBeenCalledOnce();
      expect(reconcileTerminalSessions).toHaveBeenCalledOnce();
      expect(promoteSnapshot).toHaveBeenCalledOnce();
      expect(logReload.error).not.toHaveBeenCalled();
      expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(safeConfig);
      expect(terminalPolicy.isEnabled()).toBe(true);
    } finally {
      await reloader.stop();
    }
  });

  it("retires terminal restrictions after restart secrets preflight rejects and config reverts", async () => {
    vi.useFakeTimers();
    const writeListenerRef = createConfigWriteListenerRef();
    const initialConfig = {
      gateway: {
        port: 18789,
        reload: {},
        terminal: { enabled: true },
      },
    } as OpenClawConfig;
    const rejectedConfig = {
      gateway: {
        port: 18790,
        reload: {},
        terminal: { enabled: false },
      },
    } as OpenClawConfig;
    const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
    const expectedReloadError =
      "config reload failed: SecretRefResolutionError: restart secrets preflight failed";
    let recordReloadFailure: (() => void) | undefined;
    const reloadFailed = new Promise<void>((resolve) => {
      recordReloadFailure = resolve;
    });
    let recordRestartRetired: (() => void) | undefined;
    const restartRetired = new Promise<void>((resolve) => {
      recordRestartRetired = resolve;
    });
    const logReload = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((message: string) => {
        if (message === expectedReloadError) {
          recordReloadFailure?.();
        }
      }),
    };
    const acceptTerminalConfig = (options: { retireRejectedRestart: boolean }) => {
      terminalPolicy.acceptConfig(options);
      if (options.retireRejectedRestart) {
        recordRestartRetired?.();
      }
    };
    const { activateRuntimeSecrets, emitStateEvent } = createTestRuntimeSecretsActivator(
      async ({ config }) => {
        if (config.gateway?.port === rejectedConfig.gateway?.port) {
          throw refResolutionError({
            code: "SECRET_REF_NOT_FOUND",
            source: "env",
            provider: "default",
            refId: "RESTART_PREFLIGHT_REF",
            message: "restart secrets preflight failed",
          });
        }
        return makePreparedSecretsSnapshot(config);
      },
    );
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () =>
        createValidConfigSnapshot(initialConfig, "accepted-revert"),
      ) as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef),
      logReload,
      activateRuntimeSecrets,
      prepareTerminalConfig: (plan, nextConfig) => {
        terminalPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
      },
      commitTerminalConfig: terminalPolicy.commitConfig,
      acceptTerminalConfig,
      requestRecoveryRestart,
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    try {
      registeredWriteListener(
        createConfigWriteNotification(
          rejectedConfig,
          "rejected-restart",
          1,
          "runtime-rejected-restart",
          "source-rejected-restart",
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await reloadFailed;

      expect(terminalPolicy.isEnabled()).toBe(false);
      expect(logReload.error).toHaveBeenCalledWith(expectedReloadError);
      expect(emitStateEvent).toHaveBeenCalledExactlyOnceWith(
        "SECRETS_RELOADER_DEGRADED",
        "Secret resolution failed; runtime remains on the last-known-good snapshot.",
        rejectedConfig,
      );
      expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(initialConfig);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();

      registeredWriteListener(
        createConfigWriteNotification(
          initialConfig,
          "accepted-revert",
          2,
          "runtime-accepted-revert",
          "source-accepted-revert",
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await restartRetired;

      expect(terminalPolicy.isEnabled()).toBe(true);
    } finally {
      await reloader.stop();
    }
  });

  it("does not emit a restart after shared-generation ownership rejects the candidate", async () => {
    vi.useFakeTimers();
    const harness = createManagedRestartSequenceHarness({
      invalidateGenerationOnReconcile: true,
    });

    try {
      const reloadError = harness.nextReloadError();
      harness.writeConfig(harness.deferredConfig, "stale-generation-restart", 1);
      await vi.runAllTimersAsync();

      await expect(reloadError).resolves.toBe(
        "config restart failed: GatewayHotReloadStaleSecretsError: runtime secrets changed while config hot reload was deferred",
      );
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(harness.sharedGatewaySessionGenerationState).toEqual({
        current: "concurrent-generation",
        required: null,
      });
    } finally {
      await harness.reloader.stop();
    }
  });

  it("cancels a deferred restart when a newer config fails required SecretRef preflight", async () => {
    vi.useFakeTimers();
    const harness = createManagedRestartSequenceHarness();
    hoisted.activeTaskBlockers.push(makeActiveTaskBlocker({ taskId: "restart-sequence-blocker" }));

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-a", 1);
      await vi.advanceTimersByTimeAsync(0);
      await expect(deferredPromotion).resolves.toBe("deferred-a");
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

      const reloadError = harness.nextReloadError();
      harness.writeConfig(harness.invalidConfig, "invalid-b", 2);
      await vi.advanceTimersByTimeAsync(0);
      await expect(reloadError).resolves.toBe(
        "config restart failed: Error: required SecretRef MISSING_RESTART_TOKEN is unavailable",
      );

      expect(harness.prepareRuntimeSecretsSnapshot).toHaveBeenNthCalledWith(1, {
        config: harness.deferredConfig,
        allowUnavailableSecretOwners: true,
        includeAuthStoreRefs: undefined,
        forceColdRefKeys: undefined,
        manifestRegistry: undefined,
        loadAuthStore: expect.any(Function),
      });
      expect(harness.prepareRuntimeSecretsSnapshot).toHaveBeenNthCalledWith(2, {
        config: harness.invalidConfig,
        allowUnavailableSecretOwners: true,
        includeAuthStoreRefs: undefined,
        forceColdRefKeys: undefined,
        manifestRegistry: undefined,
        loadAuthStore: expect.any(Function),
      });
      expect(harness.terminalPolicy.isEnabled()).toBe(false);
      expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(harness.initialConfig);
      expect(harness.promoteSnapshot.mock.calls.map(([snapshot]) => snapshot.hash)).not.toContain(
        "invalid-b",
      );

      hoisted.activeTaskBlockers.length = 0;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

      const acceptedWithLogging = {
        ...harness.deferredConfig,
        logging: { level: "debug" },
      } as OpenClawConfig;
      const revertPromotion = harness.nextPromotion();
      harness.writeConfig(acceptedWithLogging, "accepted-a-plus-logging", 3);
      await vi.advanceTimersByTimeAsync(0);
      await expect(revertPromotion).resolves.toBe("accepted-a-plus-logging");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.terminalPolicy.isEnabled()).toBe(false);
      expect(harness.prepareRuntimeSecretsSnapshot).toHaveBeenNthCalledWith(3, {
        config: acceptedWithLogging,
        allowUnavailableSecretOwners: true,
        includeAuthStoreRefs: undefined,
        forceColdRefKeys: undefined,
        manifestRegistry: undefined,
      });
      expect(harness.prepareRuntimeSecretsSnapshot).toHaveBeenNthCalledWith(4, {
        config: acceptedWithLogging,
        allowUnavailableSecretOwners: true,
        includeAuthStoreRefs: undefined,
        forceColdRefKeys: undefined,
        manifestRegistry: undefined,
        loadAuthStore: expect.any(Function),
      });
      const deferredPlan = buildGatewayReloadPlan(
        diffConfigPaths(harness.initialConfig, harness.deferredConfig),
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(harness.requestRecoveryRestart.mock.calls).toEqual([
        [`config reload: ${deferredPlan.restartReasons.join(", ")}`, undefined],
      ]);
    } finally {
      hoisted.activeTaskBlockers.length = 0;
      await harness.reloader.stop();
    }
  });

  it("does not emit a prepared config restart after managed shutdown starts", async () => {
    vi.useFakeTimers();
    const harness = createManagedRestartSequenceHarness();
    let markPreflightStarted: (() => void) | undefined;
    const preflightStarted = new Promise<void>((resolve) => {
      markPreflightStarted = resolve;
    });
    let releasePreflight: (() => void) | undefined;
    const preflightBlocked = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    harness.prepareRuntimeSecretsSnapshot.mockImplementationOnce(async ({ config }) => {
      markPreflightStarted?.();
      await preflightBlocked;
      return makePreparedSecretsSnapshot(config);
    });

    harness.writeConfig(harness.deferredConfig, "shutdown-restart", 1);
    await vi.advanceTimersByTimeAsync(0);
    await preflightStarted;

    const stopPromise = harness.reloader.stop();
    releasePreflight?.();
    await stopPromise;

    expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
    expect(harness.promoteSnapshot).not.toHaveBeenCalled();
    expect(harness.logReload.info).toHaveBeenCalledWith(
      "config restart superseded: GatewayConfigReloadSupersededError: config reload superseded by a newer runtime config source",
    );
  });

  it.each([
    [
      "hot",
      (harness: ReturnType<typeof createManagedRestartSequenceHarness>) => harness.invalidHotConfig,
    ],
    [
      "noop",
      (harness: ReturnType<typeof createManagedRestartSequenceHarness>) =>
        harness.invalidNoopConfig,
    ],
  ] as const)(
    "pauses deferred restart A before external %s config B fails required SecretRef preflight",
    async (_kind, selectInvalidConfig) => {
      vi.useFakeTimers();
      const harness = createManagedRestartSequenceHarness();
      const invalidConfig = selectInvalidConfig(harness);
      const invalidPlan = buildGatewayReloadPlan(
        diffConfigPaths(harness.deferredConfig, invalidConfig),
      );
      expect(invalidPlan.restartGateway).toBe(false);
      hoisted.activeTaskBlockers.push(makeActiveTaskBlocker({ taskId: "hot-noop-secret-blocker" }));

      try {
        const deferredPromotion = harness.nextPromotion();
        harness.writeConfig(harness.deferredConfig, "deferred-hot-noop-a", 1);
        await vi.advanceTimersByTimeAsync(0);
        await deferredPromotion;

        const reloadError = harness.nextReloadError();
        harness.writeConfig(invalidConfig, `invalid-${_kind}-b`, 2);
        await vi.advanceTimersByTimeAsync(0);
        await expect(reloadError).resolves.toBe(
          "config reload failed: Error: required SecretRef MISSING_HOT_TOKEN is unavailable",
        );

        hoisted.activeTaskBlockers.length = 0;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

        const acceptedConfig = {
          ...harness.deferredConfig,
          logging: { level: "debug" },
        } as OpenClawConfig;
        const acceptedPromotion = harness.nextPromotion();
        harness.writeConfig(acceptedConfig, `accepted-after-${_kind}`, 3);
        await vi.advanceTimersByTimeAsync(0);
        await acceptedPromotion;
        await vi.advanceTimersByTimeAsync(500);

        expect(harness.requestRecoveryRestart).toHaveBeenCalledOnce();
      } finally {
        hoisted.activeTaskBlockers.length = 0;
        await harness.reloader.stop();
      }
    },
  );

  it("revalidates canonical SecretRefs instead of trusting direct-write runtime literals", async () => {
    vi.useFakeTimers();
    const harness = createManagedRestartSequenceHarness();
    const resolvedRuntimeConfig = {
      ...harness.deferredConfig,
      logging: { level: "info" },
      gateway: {
        ...harness.deferredConfig.gateway,
        auth: { mode: "token" as const, token: "resolved-restart-token" },
      },
    } as OpenClawConfig;
    harness.setSecretUnavailable("RESTART_A_TOKEN");

    try {
      const reloadError = harness.nextReloadError();
      harness.writeConfig(
        harness.deferredConfig,
        "direct-runtime-literal",
        1,
        resolvedRuntimeConfig,
      );
      await vi.advanceTimersByTimeAsync(0);

      await expect(reloadError).resolves.toBe(
        "config restart failed: Error: required SecretRef RESTART_A_TOKEN is unavailable",
      );
      expect(harness.prepareRuntimeSecretsSnapshot).toHaveBeenCalledWith({
        config: {
          ...resolvedRuntimeConfig,
          gateway: harness.deferredConfig.gateway,
        },
        allowUnavailableSecretOwners: true,
        includeAuthStoreRefs: undefined,
        forceColdRefKeys: undefined,
        manifestRegistry: undefined,
        loadAuthStore: expect.any(Function),
      });
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
    } finally {
      await harness.reloader.stop();
    }
  });

  it("revalidates deferred restart SecretRefs again before emission and retry", async () => {
    vi.useFakeTimers();
    const harness = createManagedRestartSequenceHarness();
    hoisted.activeTaskBlockers.push(
      makeActiveTaskBlocker({ taskId: "restart-emission-preflight-blocker" }),
    );

    try {
      const promotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-emission-preflight", 1);
      await vi.advanceTimersByTimeAsync(0);
      await promotion;

      harness.setSecretUnavailable("RESTART_A_TOKEN");
      hoisted.activeTaskBlockers.length = 0;
      await vi.advanceTimersByTimeAsync(500);
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(harness.assertRestartReady).toHaveBeenCalledOnce();
      expect(harness.logReload.warn).toHaveBeenCalledWith(
        expect.stringContaining("gateway restart preflight failed"),
      );

      harness.setSecretAvailable("RESTART_A_TOKEN");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.requestRecoveryRestart).toHaveBeenCalledOnce();
      expect(harness.assertRestartReady).toHaveBeenCalledTimes(2);
      expect(harness.prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      hoisted.activeTaskBlockers.length = 0;
      await harness.reloader.stop();
    }
  });

  it("supersedes a blocked emission preflight without marking sessions or signaling", async () => {
    vi.useFakeTimers();
    const harness = createManagedRestartSequenceHarness();
    let releaseEmissionPreflight = () => {};
    let recordEmissionPreflightStarted: (() => void) | undefined;
    const emissionPreflightStarted = new Promise<void>((resolve) => {
      recordEmissionPreflightStarted = resolve;
    });
    const emissionPreflightGate = new Promise<void>((resolve) => {
      releaseEmissionPreflight = resolve;
    });
    const originalPrepareRuntimeSecretsSnapshot =
      harness.prepareRuntimeSecretsSnapshot.getMockImplementation();
    if (!originalPrepareRuntimeSecretsSnapshot) {
      throw new Error("Expected managed secrets preparation implementation");
    }
    let restartCheckCount = 0;
    harness.prepareRuntimeSecretsSnapshot.mockImplementation(async (params) => {
      // Restart preflight supplies the read-only auth-store loader; reload does not.
      if (params.loadAuthStore && ++restartCheckCount === 2) {
        recordEmissionPreflightStarted?.();
        await emissionPreflightGate;
      }
      return await originalPrepareRuntimeSecretsSnapshot(params);
    });
    hoisted.activeTaskBlockers.push(makeActiveTaskBlocker({ taskId: "restart-pre-emit-blocker" }));

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-a", 1);
      const deferredAdvance = vi.advanceTimersByTimeAsync(0);
      await expect(deferredPromotion).resolves.toBe("deferred-a");
      await deferredAdvance;

      hoisted.activeTaskBlockers.length = 0;
      const emissionAdvance = vi.advanceTimersByTimeAsync(500);
      await emissionPreflightStarted;

      harness.writeConfig(harness.invalidConfig, "invalid-b", 2);
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

      // The write listener supersedes the blocked preflight synchronously. Release it before
      // draining fake timers so Vitest does not need to nest timer advances around the gate.
      releaseEmissionPreflight();
      await emissionAdvance;
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(hoisted.markRestartAbortedMainSessions).not.toHaveBeenCalled();
    } finally {
      releaseEmissionPreflight();
      hoisted.activeTaskBlockers.length = 0;
      await harness.reloader.stop();
    }
  });

  it("revalidates paused restart secrets before rearming an exact config revert", async () => {
    vi.useFakeTimers();
    const harness = createManagedRestartSequenceHarness();
    hoisted.activeTaskBlockers.push(makeActiveTaskBlocker({ taskId: "restart-sequence-blocker" }));

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-a", 1);
      await vi.advanceTimersByTimeAsync(0);
      await expect(deferredPromotion).resolves.toBe("deferred-a");

      const replacementError = harness.nextReloadError();
      harness.writeConfig(harness.invalidConfig, "invalid-b", 2);
      await vi.advanceTimersByTimeAsync(0);
      await replacementError;
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

      hoisted.activeTaskBlockers.length = 0;
      await vi.advanceTimersByTimeAsync(5_000);
      harness.setSecretUnavailable("RESTART_A_TOKEN");

      const revalidationError = harness.nextReloadError();
      harness.writeConfig(harness.deferredConfig, "unavailable-revert-a", 3);
      await vi.advanceTimersByTimeAsync(0);
      await expect(revalidationError).resolves.toBe(
        "config reload failed: Error: required SecretRef RESTART_A_TOKEN is unavailable",
      );

      expect(harness.prepareRuntimeSecretsSnapshot).toHaveBeenNthCalledWith(3, {
        config: harness.deferredConfig,
        allowUnavailableSecretOwners: true,
        includeAuthStoreRefs: undefined,
        forceColdRefKeys: undefined,
        manifestRegistry: undefined,
        loadAuthStore: expect.any(Function),
      });
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(harness.promoteSnapshot.mock.calls.map(([snapshot]) => snapshot.hash)).not.toContain(
        "unavailable-revert-a",
      );
      expect(harness.terminalPolicy.isEnabled()).toBe(false);
    } finally {
      hoisted.activeTaskBlockers.length = 0;
      await harness.reloader.stop();
    }
  });

  it("lets a newer valid restart config replace the deferred restart owner", async () => {
    vi.useFakeTimers();
    const harness = createManagedRestartSequenceHarness();
    hoisted.activeTaskBlockers.push(makeActiveTaskBlocker({ taskId: "restart-sequence-blocker" }));

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-a", 1);
      await vi.advanceTimersByTimeAsync(0);
      await expect(deferredPromotion).resolves.toBe("deferred-a");

      const replacementPromotion = harness.nextPromotion();
      harness.writeConfig(harness.replacementConfig, "replacement-b", 2);
      await vi.advanceTimersByTimeAsync(0);
      await expect(replacementPromotion).resolves.toBe("replacement-b");
      expect(harness.prepareRuntimeSecretsSnapshot).toHaveBeenNthCalledWith(2, {
        config: harness.replacementConfig,
        allowUnavailableSecretOwners: true,
        includeAuthStoreRefs: undefined,
        forceColdRefKeys: undefined,
        manifestRegistry: undefined,
        loadAuthStore: expect.any(Function),
      });
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();

      hoisted.activeTaskBlockers.length = 0;
      await vi.advanceTimersByTimeAsync(500);

      expect(harness.requestRecoveryRestart.mock.calls).toEqual([
        ["config reload: gateway.bind", undefined],
      ]);
    } finally {
      hoisted.activeTaskBlockers.length = 0;
      await harness.reloader.stop();
    }
  });

  it("retries managed hot reload when secrets change before publication", async () => {
    vi.useFakeTimers();
    const writeListenerRef = createConfigWriteListenerRef();
    const initialConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    } as OpenClawConfig;
    const nextConfig = {
      gateway: { reload: {} },
      hooks: { enabled: true, token: "test-token", path: "/next" },
    } as OpenClawConfig;
    const initialSnapshot = makePreparedSecretsSnapshot(initialConfig);
    const refreshedSnapshot: PreparedSecretsRuntimeSnapshot = {
      ...initialSnapshot,
      authStores: prepareRuntimeAuthProfileStoreSnapshots([
        {
          agentDir: "/tmp/refreshed-agent",
          store: { version: 1, profiles: {} },
        },
      ]),
    };
    activateSecretsRuntimeSnapshot(initialSnapshot);
    const initialSnapshotRevision = getActiveSecretsRuntimeSnapshotRevision();
    let preparationCount = 0;
    const { activateRuntimeSecrets, prepareRuntimeSecretsSnapshot } =
      createTestRuntimeSecretsActivator(async ({ config }) => {
        preparationCount += 1;
        if (preparationCount === 1) {
          expect(
            activateSecretsRuntimeSnapshotIfCurrent(
              refreshedSnapshot,
              getActiveSecretsRuntimeSnapshotRevision(),
              { preserveActivationLineage: true },
            ),
          ).toBe(true);
        }
        return makePreparedSecretsSnapshot(config);
      });
    const activatePreparedSnapshotIfCurrent = vi.spyOn(
      activateRuntimeSecrets,
      "activatePreparedSnapshotIfCurrent",
    );
    const commitTerminalConfig = vi.fn();
    type ReloadOutcome = { status: "promoted" } | { status: "failed"; message: string };
    let settleReload: ((outcome: ReloadOutcome) => void) | undefined;
    const reloadOutcome = new Promise<ReloadOutcome>((resolve) => {
      settleReload = resolve;
    });
    const promoteSnapshot = vi.fn(async () => {
      settleReload?.({ status: "promoted" });
      return true;
    });
    const logReload = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((message: string) => settleReload?.({ status: "failed", message })),
    };
    const setState = vi.fn();
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () =>
        createValidConfigSnapshot(nextConfig, "hot-reload-next"),
      ) as never,
      promoteSnapshot: promoteSnapshot as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef),
      setState,
      logReload,
      activateRuntimeSecrets,
      commitTerminalConfig,
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener(
      createConfigWriteNotification(
        nextConfig,
        "hot-reload-next",
        1,
        "runtime-hot-reload-next",
        "source-hot-reload-next",
      ),
    );
    await vi.runAllTimersAsync();
    expect(await reloadOutcome).toEqual({ status: "promoted" });

    try {
      expect(prepareRuntimeSecretsSnapshot).toHaveBeenCalledTimes(2);
      expect(activatePreparedSnapshotIfCurrent).toHaveBeenCalledOnce();
      expect(activatePreparedSnapshotIfCurrent.mock.calls[0]?.[1]).toBeGreaterThan(
        initialSnapshotRevision,
      );
      expect(setState).toHaveBeenCalledOnce();
      expect(commitTerminalConfig).toHaveBeenCalledOnce();
      expect(promoteSnapshot).toHaveBeenCalledOnce();
      expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(nextConfig);
    } finally {
      await reloader.stop();
    }
  });

  it("aborts an in-flight managed Gmail restart when the reloader stops", async () => {
    const writeListenerRef = createConfigWriteListenerRef();
    let restartSignal: AbortSignal | undefined;
    type GmailRestartOutcome = { status: "started" } | { status: "failed"; message: string };
    let settleRestart: ((outcome: GmailRestartOutcome) => void) | undefined;
    const restartOutcome = new Promise<GmailRestartOutcome>((resolve) => {
      settleRestart = resolve;
    });
    hoisted.startGmailWatcherWithLogs.mockImplementationOnce(
      async (params: GmailWatcherRestartParams) => {
        restartSignal = params.signal;
        settleRestart?.({ status: "started" });
        await new Promise<void>((resolve) => {
          params.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const logReload = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((message: string) => settleRestart?.({ status: "failed", message })),
    };
    const initialConfig = createGmailConfig("old@example.com");
    const nextConfig = createGmailConfig("next@example.com");
    const readSnapshot = vi.fn(async () => createValidConfigSnapshot(nextConfig, "hash-next"));
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: readSnapshot as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef),
      logReload,
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener(
      createConfigWriteNotification(
        nextConfig,
        "hash-next",
        1,
        "runtime-hash-next",
        "source-hash-next",
      ),
    );
    expect(await restartOutcome).toEqual({ status: "started" });
    expect(restartSignal?.aborted).toBe(false);

    await reloader.stop();

    expect(restartSignal?.aborted).toBe(true);
  });

  it("keeps committed config after a Gmail watcher follow-up fails", async () => {
    await withGatewayRestartSignal(async (signalSpy) => {
      vi.useFakeTimers();
      const writeListenerRef = createConfigWriteListenerRef();
      const initialConfig = createGmailConfig("old@example.com");
      const nextConfig: OpenClawConfig = {
        ...createGmailConfig("next@example.com"),
        models: { providers: {} },
      };
      const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
      hoisted.startGmailWatcherWithLogs.mockRejectedValueOnce(new Error("start failed"));
      const reloader = startManagedGatewayConfigReloader({
        initialConfig,
        readSnapshot: vi.fn(async () =>
          createValidConfigSnapshot(nextConfig, "hash-next"),
        ) as never,
        subscribeToWrites: captureConfigWriteListener(writeListenerRef),
        logReload,
      });
      try {
        const registeredWriteListener = writeListenerRef.current;
        if (!registeredWriteListener) {
          throw new Error("Expected config write listener to be registered");
        }

        registeredWriteListener(
          createConfigWriteNotification(
            nextConfig,
            "hash-next",
            1,
            "runtime-hash-next",
            "source-hash-next",
          ),
        );
        await vi.runAllTimersAsync();

        expect(hoisted.refreshContextWindowCache).toHaveBeenCalledTimes(1);
        expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
        expect(logReload.warn).toHaveBeenCalledWith(
          "gmail watcher reload failed after config commit: start failed; restarting gateway",
        );
        expect(logReload.error).not.toHaveBeenCalled();
        expect(signalSpy).toHaveBeenCalledOnce();
      } finally {
        await reloader.stop();
      }
    });
  });

  it("does not start a Gmail restart after the managed reloader stops before hot reload applies", async () => {
    const writeListenerRef = createConfigWriteListenerRef();
    let releaseSecrets: (() => void) | undefined;
    let secretsEntered: (() => void) | undefined;
    const secretsStarted = new Promise<void>((resolve) => {
      secretsEntered = resolve;
    });
    const releaseSecretsPromise = new Promise<void>((resolve) => {
      releaseSecrets = resolve;
    });
    const initialConfig = createGmailConfig("old@example.com");
    const nextConfig = createGmailConfig("next@example.com");
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () => createValidConfigSnapshot(nextConfig, "hash-next")) as never,
      subscribeToWrites: captureConfigWriteListener(writeListenerRef),
      activateRuntimeSecrets: createTestRuntimeSecretsActivator(async ({ config }) => {
        secretsEntered?.();
        await releaseSecretsPromise;
        return makePreparedSecretsSnapshot(config);
      }).activateRuntimeSecrets,
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener(
      createConfigWriteNotification(
        nextConfig,
        "hash-next",
        1,
        "runtime-hash-next",
        "source-hash-next",
      ),
    );
    await secretsStarted;

    const stopPromise = reloader.stop();
    releaseSecrets?.();
    await stopPromise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(hoisted.stopGmailWatcher).not.toHaveBeenCalled();
    expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
  });
});

describe("gateway plugin hot reload handlers", () => {
  it("restarts channels when the candidate env removes an active skip flag", async () => {
    const envKey = "OPENCLAW_SKIP_CHANNELS";
    const previousValue = process.env[envKey];
    process.env[envKey] = "1";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "1" };
    const previousConfig = { env: { vars: { [envKey]: "1" } } } satisfies OpenClawConfig;
    const runtimeEnv = prepareConfigRuntimeEnv({
      previousConfig,
      nextConfig: {},
      env: targetEnv,
      previousOwnedEnv: { [envKey]: "1" },
    });
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const handlers = createReloadHandlersForTest(undefined, {
      start: startChannel,
      stop: stopChannel,
    });

    try {
      await handlers.applyHotReload(
        createHotTailPlan({
          changedPaths: [`env.vars.${envKey}`, "channels.discord.token"],
          hotReasons: [`env.vars.${envKey}`, "channels.discord.token"],
          restartChannels: new Set(["discord"]),
        }),
        {},
        {
          sourceConfig: {},
          runtimeEnv: runtimeEnv.env,
          isCurrent: () => true,
          publish: async (commit) => {
            const publication = runtimeEnv.publish();
            try {
              await commit();
              publication.commit();
            } catch (error) {
              publication();
              throw error;
            }
          },
        },
      );
    } finally {
      if (previousValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousValue;
      }
    }

    expect(runtimeEnv.env[envKey]).toBeUndefined();
    expect(targetEnv[envKey]).toBeUndefined();
    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord", undefined, {
      preserveManualStop: true,
      skipUnavailableAccounts: true,
    });
  });

  it("skips channel work when the candidate env adds a skip flag", async () => {
    const envKey = "OPENCLAW_SKIP_PROVIDERS";
    const previousValue = process.env[envKey];
    delete process.env[envKey];
    const targetEnv: NodeJS.ProcessEnv = {};
    const nextConfig = { env: { vars: { [envKey]: "1" } } } satisfies OpenClawConfig;
    const runtimeEnv = prepareConfigRuntimeEnv({
      previousConfig: {},
      nextConfig,
      env: targetEnv,
    });
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const handlers = createGatewayReloadHandlers({
      startChannel,
      stopChannel,
      logChannels,
    });

    try {
      await handlers.applyHotReload(
        createHotTailPlan({
          changedPaths: [`env.vars.${envKey}`, "channels.discord.token"],
          hotReasons: [`env.vars.${envKey}`, "channels.discord.token"],
          restartChannels: new Set(["discord"]),
        }),
        nextConfig,
        {
          sourceConfig: nextConfig,
          runtimeEnv: runtimeEnv.env,
          isCurrent: () => true,
          publish: async (commit) => {
            const publication = runtimeEnv.publish();
            try {
              await commit();
              publication.commit();
            } catch (error) {
              publication();
              throw error;
            }
          },
        },
      );
    } finally {
      if (previousValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousValue;
      }
    }

    expect(runtimeEnv.env[envKey]).toBe("1");
    expect(targetEnv[envKey]).toBe("1");
    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(logChannels.info).toHaveBeenCalledWith(
      "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
  });

  it("publishes candidate env before cron, plugin, and channel replacements start", async () => {
    const envKey = "OPENCLAW_TEST_HOT_RELOAD_SERVICE_ENV";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "old" };
    const initialConfig = {
      gateway: { reload: {} },
      cron: { enabled: false },
      plugins: { enabled: false },
      env: { vars: { [envKey]: "old" } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      ...initialConfig,
      cron: { enabled: true },
      plugins: { enabled: true },
      env: { vars: { [envKey]: "candidate" } },
    } satisfies OpenClawConfig;
    const compareConfig = {
      ...nextConfig,
      env: initialConfig.env,
    } satisfies OpenClawConfig;
    const runtimeEnv = prepareConfigRuntimeEnv({
      previousConfig: initialConfig,
      nextConfig,
      env: targetEnv,
      previousOwnedEnv: { [envKey]: "old" },
    });
    const events: string[] = [];
    const rebuiltCronState = {
      cron: {
        start: vi.fn(async () => {
          events.push(`cron:${targetEnv[envKey]}`);
        }),
        stop: vi.fn(),
      },
      storePath: "/tmp/rebuilt-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
      reconcileHeartbeatJobs: vi.fn(async () => "converged" as const),
    };
    hoisted.buildGatewayCronService.mockImplementationOnce((params) => {
      events.push(`cron-build:${params?.env?.[envKey]}:${targetEnv[envKey]}`);
      return rebuiltCronState;
    });
    const writeListenerRef = createConfigWriteListenerRef();
    const reloadPlugins = vi.fn(
      async (params: {
        commitRuntime: () => Promise<void>;
        env: NodeJS.ProcessEnv;
      }): Promise<GatewayPluginReloadResult> => {
        events.push(`lookup:${params.env[envKey]}:${targetEnv[envKey]}`);
        await params.commitRuntime();
        events.push(`plugin:${targetEnv[envKey]}`);
        return makePluginReloadResult({
          restartChannels: new Set(["discord"]),
          activeChannels: new Set(["discord"]),
        });
      },
    );
    const reloader = startManagedGatewayConfigReloader({
      initialConfig,
      readSnapshot: vi.fn(async () => createValidConfigSnapshot(nextConfig, "hot-env")),
      subscribeToWrites: captureConfigWriteListener(writeListenerRef, false),
      startChannel: vi.fn(async () => {
        events.push(`channel:${targetEnv[envKey]}`);
      }),
      reloadPlugins,
    });
    try {
      const listener = writeListenerRef.current;
      if (!listener) {
        throw new Error("Expected config write listener to be registered");
      }
      const application = createRuntimeConfigWriteApplication();
      listener(
        attachRuntimeConfigWriteApplication(
          createConfigWriteNotification(
            nextConfig,
            "hot-env",
            1,
            "runtime-hot-env",
            "source-hot-env",
            {
              preparedCandidate: { runtimeConfig: nextConfig, compareConfig, runtimeEnv },
            },
          ),
          application,
        ),
      );
      await expect(application.result).resolves.toBe("applied");

      expect(events).toEqual([
        "cron-build:candidate:old",
        "lookup:candidate:old",
        "cron:candidate",
        "plugin:candidate",
        "channel:candidate",
      ]);
      expect(targetEnv[envKey]).toBe("candidate");
    } finally {
      await reloader.stop();
    }
  });

  it("publishes the committed generation before awaiting cron teardown", async () => {
    const state = createDefaultGatewayReloadState();
    const drainStarted = createDeferred();
    const releaseDrain = createDeferred();
    state.cronState.cron.stopAndDrain = async () => {
      drainStarted.resolve();
      await releaseDrain.promise;
    };
    const onCommitted = vi.fn();
    const handlers = createGatewayReloadHandlers({ getState: () => state });
    const reload = handlers.applyHotReload(
      createHotTailPlan({ restartCron: true }),
      { cron: { enabled: true } },
      {
        sourceConfig: { cron: { enabled: true } },
        isCurrent: () => true,
        onCommitted,
        publish: async (commit) => await commit(),
      },
    );
    try {
      await drainStarted.promise;
      expect(onCommitted).toHaveBeenCalledOnce();
    } finally {
      releaseDrain.resolve();
      await reload;
    }
  });

  it("keeps mixed reload state old until the plugin replacement commit", async () => {
    const events: string[] = [];
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
        commitRuntime: () => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["discord"]));
        await params.commitRuntime();
        events.push("registry:replace");
        return makePluginReloadResult();
      },
    );
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        start: vi.fn(async () => {}),
        stop: vi.fn(async (channel) => {
          events.push(`stop:${channel}`);
        }),
      },
      reloadPlugins,
    );
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();

    const reload = handlers.applyHotReload(
      createHotTailPlan({
        changedPaths: ["hooks.path", "plugins.enabled"],
        hotReasons: ["hooks.path", "plugins.enabled"],
        reloadHooks: true,
        reloadPlugins: true,
      }),
      { hooks: { enabled: true, token: "token", path: "/next" } },
      {
        sourceConfig: { hooks: { enabled: true, token: "token", path: "/next" } },
        isCurrent: () => true,
        publish: async (commit) => {
          events.push("runtime:publish");
          await commit();
        },
        onCommitted: () => {
          events.push("runtime:committed");
        },
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual(["reload:start"]);
    expect(handlers.setState).not.toHaveBeenCalled();

    hoisted.activeEmbeddedRunCount.value = 0;
    await vi.advanceTimersByTimeAsync(500);
    await reload;

    expect(events).toEqual([
      "reload:start",
      "stop:discord",
      "runtime:publish",
      "runtime:committed",
      "registry:replace",
    ]);
    expect(handlers.setState).toHaveBeenCalledTimes(1);
  });

  it("passes authored plugin config separately from synthesized runtime trust to replacement planning", async () => {
    const sourceConfig = {
      plugins: { enabled: true },
    } satisfies OpenClawConfig;
    const runtimeConfig = {
      plugins: {
        enabled: true,
        allow: ["external-plugin"],
        entries: { "external-plugin": { enabled: true } },
      },
    } satisfies OpenClawConfig;
    const reloadPlugins = vi.fn(
      async (params: {
        commitRuntime: () => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        await params.commitRuntime();
        return makePluginReloadResult();
      },
    );
    const handlers = createReloadHandlersForTest(undefined, undefined, reloadPlugins);

    await handlers.applyHotReload(createPluginReloadPlan(), runtimeConfig, {
      sourceConfig,
      isCurrent: () => true,
      publish: async (commit) => await commit(),
    });

    const reloadParams = reloadPlugins.mock.calls[0]?.[0] as
      | { nextConfig: OpenClawConfig; sourceConfig?: OpenClawConfig }
      | undefined;
    expect(reloadParams?.nextConfig).toBe(runtimeConfig);
    expect(reloadParams?.sourceConfig).toBe(sourceConfig);
  });

  it("requests recovery when runtime publication rejects after successful service teardown", async () => {
    const events: string[] = [];
    const publicationFailure = new Error("runtime publication rejected");
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const activateCandidate = vi.fn();
    const startCandidateServices = vi.fn();
    const publish = vi.fn(async () => {
      events.push("runtime:publish");
      throw publicationFailure;
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
        commitRuntime: () => Promise<void>;
        onReplacementTeardownFailure: (error: unknown) => void;
      }): Promise<GatewayPluginReloadResult> => {
        await params.beforeReplace(new Set(["discord"]));
        events.push("services:strict-stop");
        try {
          await params.commitRuntime();
        } catch (error) {
          params.onReplacementTeardownFailure(error);
          throw error;
        }
        activateCandidate();
        startCandidateServices();
        return makePluginReloadResult();
      },
    );
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        stop: vi.fn(async (channel) => {
          events.push(`channel:stop:${channel}`);
        }),
        start: vi.fn(async (channel) => {
          events.push(`channel:start:${channel}`);
        }),
      },
      reloadPlugins,
      undefined,
      requestRecoveryRestart,
    );

    await expect(
      handlers.applyHotReload(
        createPluginReloadPlan(),
        { plugins: { enabled: true } },
        {
          sourceConfig: { plugins: { enabled: true } },
          publish,
          isCurrent: () => true,
        },
      ),
    ).rejects.toBe(publicationFailure);

    expect(events).toEqual(["channel:stop:discord", "services:strict-stop", "runtime:publish"]);
    expect(requestRecoveryRestart).toHaveBeenCalledOnce();
    expect(activateCandidate).not.toHaveBeenCalled();
    expect(startCandidateServices).not.toHaveBeenCalled();
    expect(handlers.setState).not.toHaveBeenCalled();
  });

  it.each([
    { label: "service rejection", failure: "service rejected cleanup" },
    { label: "service timeout", failure: "service cleanup timed out" },
  ])(
    "requests recovery without committing replacement after strict $label",
    async ({ failure }) => {
      await withGatewayRestartSignal(async (signalSpy) => {
        const events: string[] = [];
        const cleanupFailure = new AggregateError(
          [new Error(failure)],
          "plugin service stop failed",
        );
        const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
        const reloadPlugins = vi.fn(
          async (params: {
            beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
            commitRuntime: () => Promise<void>;
            onReplacementTeardownFailure: (error: unknown) => void;
          }): Promise<GatewayPluginReloadResult> => {
            await params.beforeReplace(new Set(["discord"]));
            events.push("services:strict-stop");
            params.onReplacementTeardownFailure(cleanupFailure);
            throw cleanupFailure;
          },
        );
        const handlers = createReloadHandlersForTest(
          undefined,
          {
            stop: vi.fn(async (channel) => {
              events.push(`channel:stop:${channel}`);
            }),
            start: vi.fn(async (channel) => {
              events.push(`channel:start:${channel}`);
            }),
          },
          reloadPlugins,
        );

        await expect(
          handlers.applyHotReload(
            createPluginReloadPlan(),
            { plugins: { enabled: true } },
            {
              sourceConfig: { plugins: { enabled: true } },
              publish,
              isCurrent: () => true,
            },
          ),
        ).rejects.toBe(cleanupFailure);

        expect(events).toEqual(["channel:stop:discord", "services:strict-stop"]);
        expect(publish).not.toHaveBeenCalled();
        expect(handlers.setState).not.toHaveBeenCalled();
        expect(signalSpy).toHaveBeenCalledOnce();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        markGatewaySigusr1RestartHandled();
      });
    },
  );

  it("rolls back unrelated aggregate plugin failures without requesting cleanup recovery", async () => {
    const events: string[] = [];
    const planningFailure = new AggregateError(
      [new Error("candidate rejected")],
      "plugin planning failed",
    );
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        await params.beforeReplace(new Set(["discord"]));
        throw planningFailure;
      },
    );
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        stop: vi.fn(async (channel) => {
          events.push(`stop:${channel}`);
        }),
        start: vi.fn(async (channel) => {
          events.push(`start:${channel}`);
        }),
      },
      reloadPlugins,
      undefined,
      requestRecoveryRestart,
    );

    await expect(
      handlers.applyHotReload(createPluginReloadPlan(), { plugins: { enabled: true } }),
    ).rejects.toBe(planningFailure);

    expect(events).toEqual(["stop:discord", "start:discord"]);
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
    expect(handlers.setState).not.toHaveBeenCalled();
  });

  it("restarts only the account retaining a command catalog on plugin replacement", async () => {
    const discordPlugin = createChannelTestPluginBase({
      id: "discord",
      config: {
        listAccountIds: () => ["catalog-account", "disabled-account"],
        resolveAccount: (_cfg, accountId) => ({ accountId }),
      },
    });
    const createDiscordRegistry = () =>
      createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]);
    const oldRegistry = createDiscordRegistry();
    const nextRegistry = createDiscordRegistry();
    const oldHandler = vi.fn(async () => ({ text: "old" }));
    const nextHandler = vi.fn(async () => ({ text: "next" }));
    for (const [registry, handler] of [
      [oldRegistry, oldHandler],
      [nextRegistry, nextHandler],
    ] as const) {
      expect(
        registerPluginCommandInRegistry(registry, "command-owner", {
          name: "refresh",
          description: "Refresh",
          channels: ["discord"],
          handler,
        }),
      ).toEqual({ ok: true });
    }
    setActivePluginRegistry(oldRegistry);
    const staleDispatch = createPluginCommandRuntime()
      .listNativeCandidates("discord")[0]!
      .prepareDispatch();
    expect(staleDispatch.kind).toBe("plugin");

    const events: string[] = [];
    let restartedDispatch: PluginCommandCatalogDecision | undefined;
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        stop: vi.fn(async (channel, accountId) => {
          events.push(`stop:${channel}:${accountId ?? "all"}`);
        }),
        start: vi.fn(async (channel, accountId) => {
          events.push(`start:${channel}:${accountId ?? "all"}`);
          restartedDispatch = createPluginCommandRuntime()
            .listNativeCandidates("discord")[0]!
            .prepareDispatch();
        }),
      },
      vi.fn(async (params): Promise<GatewayPluginReloadResult> => {
        const beforeReplace = params.beforeReplace as (
          channels: ReadonlySet<ChannelKind>,
          accounts?: ReadonlyMap<ChannelKind, ReadonlySet<string>>,
        ) => Promise<void>;
        await beforeReplace(new Set(), new Map([["discord", new Set(["catalog-account"])]]));
        await params.commitRuntime();
        setActivePluginRegistry(nextRegistry);
        events.push("registry:next");
        return makePluginReloadResult({ activeChannels: new Set(["discord"]) });
      }),
    );

    await withPluginRuntimeGatewayRequestScope(
      {
        isWebchatConnect: () => false,
        pluginRegistry: oldRegistry,
      },
      () =>
        handlers.applyHotReload(
          createPluginReloadPlan(),
          { plugins: { enabled: true } },
          {
            sourceConfig: { plugins: { enabled: true } },
            publish: async (commit) => await commit(),
            isCurrent: () => true,
          },
        ),
    );

    expect(events).toEqual([
      "stop:discord:catalog-account",
      "registry:next",
      "start:discord:catalog-account",
    ]);
    if (staleDispatch.kind === "plugin") {
      await expect(
        staleDispatch.execute({
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: "/refresh",
          config: {},
        }),
      ).resolves.toMatchObject({ text: expect.stringContaining("registry changed") });
    }
    expect(restartedDispatch?.kind).toBe("plugin");
    if (restartedDispatch?.kind === "plugin") {
      await expect(
        restartedDispatch.execute({
          channel: "discord",
          isAuthorizedSender: true,
          commandBody: "/refresh",
          config: {},
        }),
      ).resolves.toEqual({ text: "next" });
    }
    expect(oldHandler).not.toHaveBeenCalled();
    expect(nextHandler).toHaveBeenCalledOnce();
  });

  it("keeps a committed plugin generation when a later channel restart fails", async () => {
    await withGatewayRestartSignal(async (signalSpy) => {
      const logReload = { info: vi.fn(), warn: vi.fn() };
      const reloadPlugins = vi.fn(
        async (params: {
          commitRuntime: () => Promise<void>;
        }): Promise<GatewayPluginReloadResult> => {
          await params.commitRuntime();
          return makePluginReloadResult({
            restartChannels: new Set(["discord"]),
            activeChannels: new Set(["discord"]),
          });
        },
      );
      const handlers = createReloadHandlersForTest(
        logReload,
        {
          start: vi.fn(async () => {
            throw new Error("start failed");
          }),
          stop: vi.fn(async () => {}),
        },
        reloadPlugins,
      );

      await expect(
        handlers.applyHotReload(
          createPluginReloadPlan(),
          { plugins: { enabled: true } },
          {
            sourceConfig: { plugins: { enabled: true } },
            publish: async (commit) => await commit(),
            isCurrent: () => true,
          },
        ),
      ).resolves.toBe("applied-restart-required");

      expect(handlers.setState).toHaveBeenCalledTimes(1);
      expect(logReload.warn).toHaveBeenCalledWith(
        "channel restart (discord) failed after config commit; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    });
  });

  it("restarts instead of rolling back when plugin swap throws after runtime commit", async () => {
    await withGatewayRestartSignal(async (signalSpy) => {
      const logReload = { info: vi.fn(), warn: vi.fn() };
      const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
      const handlers = createReloadHandlersForTest(
        logReload,
        undefined,
        vi.fn(async (params: { commitRuntime: () => Promise<void> }) => {
          await params.commitRuntime();
          throw new Error("swap failed");
        }),
      );

      await expect(
        handlers.applyHotReload(
          createPluginReloadPlan(),
          { plugins: { enabled: true } },
          { sourceConfig: { plugins: { enabled: true } }, publish, isCurrent: () => true },
        ),
      ).resolves.toBe("applied-restart-required");

      expect(publish).toHaveBeenCalledOnce();
      expect(handlers.setState).toHaveBeenCalledTimes(1);
      expect(logReload.warn).toHaveBeenCalledWith(
        "plugin runtime reload failed after config commit: swap failed; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    });
  });

  it.each([
    {
      label: "cron replacement",
      plan: createCronRestartPlan(),
    },
    {
      label: "health monitor replacement",
      plan: createHotTailPlan({ restartHealthMonitor: true }),
    },
    {
      label: "Gmail watcher replacement",
      plan: createHotTailPlan({ reloadHooks: true, restartGmailWatcher: true }),
    },
    {
      label: "plugin replacement",
      plan: {
        ...createHotTailPlan(),
        changedPaths: ["plugins.enabled"],
        hotReasons: ["plugins.enabled"],
        reloadPlugins: true,
      },
    },
    {
      label: "channel restart",
      plan: {
        ...createHotTailPlan(),
        changedPaths: ["channels.discord"],
        hotReasons: ["channels.discord"],
        restartChannels: new Set<ChannelKind>(["discord"]),
      },
    },
  ])(
    "rejects ownerless $label before service mutation or runtime publication",
    async ({ plan }) => {
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
      const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
      const startChannel = vi.fn(async () => {});
      const stopChannel = vi.fn(async () => {});
      const reloadPlugins = vi.fn(
        async (params: {
          beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
          commitRuntime: () => Promise<void>;
        }) => {
          await params.beforeReplace(new Set(["discord"]));
          await params.commitRuntime();
          throw new Error("swap failed");
        },
      );
      const handlers = createReloadHandlersForTest(
        logReload,
        { start: startChannel, stop: stopChannel },
        reloadPlugins,
        vi.fn(),
        false,
      );

      await expect(
        handlers.applyHotReload(
          plan,
          { plugins: { enabled: true } },
          { sourceConfig: { plugins: { enabled: true } }, publish, isCurrent: () => true },
        ),
      ).rejects.toThrow(
        "config reload requires a managed gateway restart owner for irreversible hot reload",
      );

      expect(reloadPlugins).not.toHaveBeenCalled();
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();
      expect(handlers.cron.stop).not.toHaveBeenCalled();
      expect(hoisted.stopGmailWatcher).not.toHaveBeenCalled();
      expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(handlers.setState).not.toHaveBeenCalled();
    },
  );

  it("restarts pre-stopped channel targets when runtime publication fails", async () => {
    const events: string[] = [];
    const pruneInactiveChannelAccountState = vi.fn();
    const publish = vi.fn(async () => {
      throw new Error("publication failed");
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (
          channels: ReadonlySet<ChannelKind>,
          accounts?: ReadonlyMap<ChannelKind, ReadonlySet<string>>,
        ) => Promise<void>;
        commitRuntime: () => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        await params.beforeReplace(
          new Set(["discord"]),
          new Map([["slack", new Set(["catalog-account"])]]),
        );
        await params.commitRuntime();
        return makePluginReloadResult({ activeChannels: new Set(["discord"]) });
      },
    );
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        stop: vi.fn(async (channel, accountId) => {
          events.push(`stop:${channel}:${accountId ?? "all"}`);
        }),
        start: vi.fn(async (channel, accountId) => {
          events.push(`start:${channel}:${accountId ?? "all"}`);
        }),
        pruneInactiveChannelAccountState,
      },
      reloadPlugins,
    );

    await expect(
      handlers.applyHotReload(
        createPluginReloadPlan(),
        { plugins: { enabled: true } },
        { sourceConfig: { plugins: { enabled: true } }, publish, isCurrent: () => true },
      ),
    ).rejects.toThrow("publication failed");

    expect(events).toEqual([
      "stop:slack:catalog-account",
      "stop:discord:all",
      "start:slack:catalog-account",
      "start:discord:all",
    ]);
    expect(pruneInactiveChannelAccountState).not.toHaveBeenCalled();
    expect(handlers.setState).not.toHaveBeenCalled();
  });

  it("restarts pre-stopped account targets when plugin replacement is cancelled", async () => {
    const events: string[] = [];
    const pruneInactiveChannelAccountState = vi.fn();
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (
          channels: ReadonlySet<ChannelKind>,
          accounts?: ReadonlyMap<ChannelKind, ReadonlySet<string>>,
        ) => Promise<void>;
        isAborted?: () => boolean;
      }): Promise<GatewayPluginReloadResult> => {
        await params.beforeReplace(new Set(), new Map([["discord", new Set(["catalog-account"])]]));
        expect(params.isAborted?.()).toBe(false);
        return makePluginReloadResult({ cancelled: true });
      },
    );
    const handlers = createReloadHandlersForTest(
      undefined,
      {
        stop: vi.fn(async (channel, accountId) => {
          events.push(`stop:${channel}:${accountId ?? "all"}`);
        }),
        start: vi.fn(async (channel, accountId) => {
          events.push(`start:${channel}:${accountId ?? "all"}`);
        }),
        pruneInactiveChannelAccountState,
      },
      reloadPlugins,
    );

    await expect(
      handlers.applyHotReload(createPluginReloadPlan(), { plugins: { enabled: true } }),
    ).rejects.toThrow("config hot reload cancelled by config supersession or in-process restart");

    expect(events).toEqual(["stop:discord:catalog-account", "start:discord:catalog-account"]);
    expect(pruneInactiveChannelAccountState).not.toHaveBeenCalled();
    expect(handlers.setState).not.toHaveBeenCalled();
  });

  it("rolls back stopped channels when plugin pre-replace stop fails", async () => {
    const restoreChannelReloadEnv = enableChannelReloadsForTest();
    const gatewayState = createDefaultGatewayReloadState();
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const events: string[] = [];
    const startRootCounts: number[] = [];
    const pruneInactiveChannelAccountState = vi.fn();
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
      startRootCounts.push(getActiveGatewayRootWorkCount({ excludeCurrent: true }));
    });
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
      if (channel === "discord") {
        throw new Error("stop failed");
      }
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["telegram", "discord"]));
        events.push("registry:replace");
        return makePluginReloadResult();
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      getState: () => gatewayState,
      setState,
      startChannel,
      stopChannel,
      pruneInactiveChannelAccountState,
      reloadPlugins,
      logChannels,
    });

    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    try {
      await expect(
        root?.run(async () => {
          await applyHotReload(createPluginReloadPlan(), {
            plugins: {
              enabled: false,
            },
          });
        }),
      ).rejects.toThrow("failed to stop channels before plugin reload: discord");
    } finally {
      root?.release();
      restoreChannelReloadEnv();
    }

    expect(events).toEqual([
      "reload:start",
      "stop:telegram",
      "stop:discord",
      "start:telegram",
      "start:discord",
    ]);
    expect(logChannels.error).toHaveBeenCalledWith(
      "failed to stop discord channel before plugin reload: stop failed",
    );
    expect(startChannel).toHaveBeenCalledWith("telegram", undefined, { preserveManualStop: true });
    expect(startChannel).toHaveBeenCalledWith("discord", undefined, { preserveManualStop: true });
    expect(startRootCounts).toEqual([1, 1]);
    expect(pruneInactiveChannelAccountState).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it("stops removed channel plugins from broad activation before swapping plugin runtime", async () => {
    const restoreChannelReloadEnv = enableChannelReloadsForTest();
    const gatewayState = createDefaultGatewayReloadState();
    const setState = vi.fn();
    const startChannel = vi.fn(async () => {});
    const events: string[] = [];
    const activeChannels = new Set<ChannelKind>(["slack"]);
    const pruneInactiveChannelAccountState = vi.fn(() => {
      events.push("prune");
    });
    const stopChannel = vi.fn(async () => {
      events.push("stop");
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["discord"]));
        events.push("registry:replace");
        return makePluginReloadResult({ activeChannels });
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      getState: () => gatewayState,
      setState,
      startChannel,
      stopChannel,
      pruneInactiveChannelAccountState,
      reloadPlugins,
    });
    const sourceConfig: OpenClawConfig = {
      plugins: { enabled: false, allow: ["discord"] },
    };

    try {
      await applyHotReload(
        createPluginReloadPlan(),
        {
          plugins: {
            enabled: false,
          },
        },
        {
          sourceConfig,
          isCurrent: () => true,
          publish: async (commit) => await commit(),
        },
      );
    } finally {
      restoreChannelReloadEnv();
    }

    const [reloadParams] = reloadPlugins.mock.calls.at(-1) ?? [];
    const reloadParamsRecord = reloadParams as
      | { nextConfig?: unknown; sourceConfig?: unknown; changedPaths?: unknown }
      | undefined;
    expect(reloadParamsRecord?.nextConfig).toEqual({
      plugins: {
        enabled: false,
      },
    });
    expect(reloadParamsRecord?.sourceConfig).toBe(sourceConfig);
    expect(reloadParamsRecord?.changedPaths).toEqual(["plugins.enabled"]);
    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).not.toHaveBeenCalled();
    expect(pruneInactiveChannelAccountState).toHaveBeenCalledExactlyOnceWith(activeChannels);
    expect(events).toEqual(["reload:start", "stop", "registry:replace", "prune"]);
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("stops manually started channels before plugin replacement while autostart is suppressed", async () => {
    const restoreChannelReloadEnv = enableChannelReloadsForTest();
    const gatewayState = createDefaultGatewayReloadState();
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const events: string[] = [];
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
    });
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["discord"]));
        events.push("registry:replace");
        return makePluginReloadResult({
          restartChannels: new Set(["discord"]),
          activeChannels: new Set(["discord"]),
        });
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      getState: () => gatewayState,
      setState,
      startChannel,
      stopChannel,
      reloadPlugins,
      getChannelAutostartSuppression: () => ({
        reason: "crash-loop-breaker",
        message: "safe mode",
      }),
      logChannels,
    });

    try {
      await applyHotReload(createPluginReloadPlan(), {
        plugins: {
          enabled: false,
        },
      });
    } finally {
      restoreChannelReloadEnv();
    }

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).not.toHaveBeenCalled();
    expect(events).toEqual(["reload:start", "stop:discord", "registry:replace"]);
    expect(logChannels.info).toHaveBeenCalledWith(
      "channel restart during hot reload suppressed by crash-loop breaker for channels: discord",
    );
    expect(setState).toHaveBeenCalledTimes(1);
  });
});

describe("deferred channel reload abort generation", () => {
  const abortChannelReloadPlan: GatewayReloadPlan = createHotTailPlan({
    changedPaths: ["channels.whatsapp.enabled"],
    hotReasons: ["channels"],
    restartChannels: new Set(["whatsapp"]),
  });

  afterEach(() => {
    hoisted.activeTaskCount.value = 0;
    vi.useRealTimers();
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
  });

  const createTestHandlers = (
    logChannels: any,
    channels: any,
    options?: {
      reloadPlugins?: ReloadHandlerParams["reloadPlugins"];
      requestRecoveryRestart?: ReloadHandlerParams["requestRecoveryRestart"];
    },
  ) =>
    createGatewayReloadHandlers({
      startChannel: channels.start,
      stopChannel: channels.stop,
      ...(options?.reloadPlugins ? { reloadPlugins: options.reloadPlugins } : {}),
      requestRecoveryRestart: options?.requestRecoveryRestart,
      logChannels,
    });

  it("abortPendingChannelReloads cancels a waiting deferred channel reload", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const { applyHotReload } = createTestHandlers(logChannels, channels);

    hoisted.activeTaskBlockers.push(makeActiveTaskBlocker());
    vi.useFakeTimers();

    try {
      const reloadPromise = applyHotReload(abortChannelReloadPlan, {});
      const reloadRejected = expect(reloadPromise).rejects.toBeInstanceOf(
        GatewayHotReloadCancelledError,
      );
      await vi.advanceTimersByTimeAsync(10); // enter wait loop (before 500ms sleep)

      abortPendingChannelReloads();
      await vi.advanceTimersByTimeAsync(500); // wake from poll sleep → abort check
      await reloadRejected;

      expect(channels.start).not.toHaveBeenCalled();
      expect(channels.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      hoisted.activeTaskBlockers.length = 0;
    }
  });

  it("leaves plugin-prestopped channels down when lifecycle restart aborts", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => abortPendingChannelReloads()),
    };
    const reloadPlugins: NonNullable<ReloadHandlerParams["reloadPlugins"]> = async (params) => {
      await params.beforeReplace(new Set(["whatsapp"]));
      return makePluginReloadResult({
        cancelled: params.isAborted?.() === true,
      });
    };
    const { applyHotReload } = createTestHandlers(logChannels, channels, { reloadPlugins });

    await expect(applyHotReload(createPluginReloadPlan(), {})).rejects.toThrow(
      "config hot reload cancelled by config supersession or in-process restart",
    );

    expect(channels.stop).toHaveBeenCalledWith("whatsapp", undefined, { manual: false });
    expect(channels.start).not.toHaveBeenCalled();
  });

  it("does not roll back a failed plugin pre-stop after lifecycle restart aborts", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {
        abortPendingChannelReloads();
        throw new Error("stop failed during drain");
      }),
    };
    const reloadPlugins: NonNullable<ReloadHandlerParams["reloadPlugins"]> = async (params) => {
      await params.beforeReplace(new Set(["whatsapp"]));
      return makePluginReloadResult({
        cancelled: params.isAborted?.() === true,
      });
    };
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const { applyHotReload } = createTestHandlers(logChannels, channels, {
      reloadPlugins,
      requestRecoveryRestart,
    });

    await expect(applyHotReload(createPluginReloadPlan(), {})).rejects.toThrow(
      "config hot reload cancelled by config supersession or in-process restart",
    );

    expect(channels.stop).toHaveBeenCalledWith("whatsapp", undefined, { manual: false });
    expect(channels.start).not.toHaveBeenCalled();
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
  });

  it("schedules recovery when plugin cancellation rollback cannot restart a channel", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {
        throw new Error("channel restart failed");
      }),
      stop: vi.fn(async () => {}),
    };
    const reloadPlugins: NonNullable<ReloadHandlerParams["reloadPlugins"]> = async (params) => {
      await params.beforeReplace(new Set(["whatsapp"]));
      return makePluginReloadResult({
        cancelled: true,
      });
    };
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const { applyHotReload } = createTestHandlers(logChannels, channels, {
      reloadPlugins,
      requestRecoveryRestart,
    });

    await expect(applyHotReload(createPluginReloadPlan(), {})).rejects.toThrow(
      "plugin reload cancellation rollback failed for: whatsapp",
    );

    expect(requestRecoveryRestart).toHaveBeenCalledWith(
      expect.stringContaining("hot reload recovery: plugin channel rollback"),
    );
  });

  it.each([
    [false, "config"],
    [true, "config"],
    [false, "lifecycle"],
    [true, "lifecycle"],
  ] as const)(
    "settles active-work deferral (runtime committed: %s, cancellation: %s)",
    async (committed, cancellationKind) => {
      const logChannels = { info: vi.fn(), error: vi.fn() };
      const channels = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
      const reloadPlugins: ReloadHandlerParams["reloadPlugins"] = async (params) => {
        await params.commitRuntime();
        return makePluginReloadResult({
          restartChannels: new Set(["whatsapp"]),
          activeChannels: new Set(["whatsapp"]),
        });
      };
      const { applyHotReload } = createTestHandlers(logChannels, channels, { reloadPlugins });
      hoisted.activeTaskBlockers.push(
        makeActiveTaskBlocker({ taskId: "task-blocking-superseded-reload" }),
      );
      let transactionCurrent = true;
      vi.useFakeTimers();

      try {
        const reloadPromise = applyHotReload(
          committed ? createPluginReloadPlan() : abortChannelReloadPlan,
          {},
          {
            sourceConfig: {},
            isCurrent: () => transactionCurrent,
            publish: async (commit) => await commit(),
          },
        );
        const cancellation =
          committed || cancellationKind === "lifecycle"
            ? GatewayHotReloadCancelledError
            : GatewayConfigReloadSupersededError;
        const reloadError = reloadPromise.then(
          () => null,
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(10);

        if (cancellationKind === "lifecycle") {
          abortPendingChannelReloads();
        } else {
          transactionCurrent = false;
        }
        await vi.advanceTimersByTimeAsync(500);
        const error = await reloadError;
        if (committed && cancellationKind === "config") {
          expect(error).toBeNull();
          expect(channels.stop).toHaveBeenCalledOnce();
          expect(channels.start).toHaveBeenCalledOnce();
          expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledOnce();
          expect(hoisted.rejectPendingPreparedModelRuntimeReplacement).not.toHaveBeenCalled();
          return;
        }
        expect(error).toBeInstanceOf(cancellation);

        expect(channels.stop).not.toHaveBeenCalled();
        expect(channels.start).not.toHaveBeenCalled();
        if (committed) {
          const gate = hoisted.markPreparedModelRuntimeSnapshotsStale.mock.results[0]?.value;
          expect(gate).toBeDefined();
          expect(hoisted.rejectPendingPreparedModelRuntimeReplacement).toHaveBeenCalledWith(
            gate,
            error,
          );
        } else {
          expect(hoisted.rejectPendingPreparedModelRuntimeReplacement).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers();
        hoisted.activeTaskBlockers.length = 0;
      }
    },
  );

  it.each(
    (["channel", "plugin"] as const).flatMap((surface) =>
      (["same write", "newer content", "lifecycle stop", "publication failure"] as const).map(
        (outcome) => ({ surface, outcome }),
      ),
    ),
  )(
    "settles a deferred $surface receipt after watcher handoff: $outcome",
    async ({ surface, outcome }) => {
      const initialConfig = {
        gateway: { reload: {} },
        channels: { whatsapp: { enabled: true, selfChatMode: false } },
        plugins: { entries: { fixture: { config: { value: "before" } } } },
      } satisfies OpenClawConfig;
      const nextConfig = {
        ...initialConfig,
        ...(surface === "channel"
          ? { channels: { whatsapp: { enabled: true, selfChatMode: true } } }
          : { plugins: { entries: { fixture: { config: { value: "after" } } } } }),
      } satisfies OpenClawConfig;
      const whatsappPlugin = {
        ...createChannelTestPluginBase({ id: "whatsapp" }),
        reload: {
          configPrefixes: ["channels.whatsapp.selfChatMode"],
          noopPrefixes: ["channels.whatsapp"],
        },
      };
      const registry = createTestRegistry([
        { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      ]);
      const writeListenerRef = createConfigWriteListenerRef();
      const commitTerminalConfig = vi.fn();
      const setState = vi.fn();
      const startChannel = vi.fn(async () => {});
      const stopChannel = vi.fn(async () => {});
      const snapshotGate = createDeferred();
      const snapshotStarted = createDeferred();
      const readSnapshot = vi.fn(async () => {
        snapshotStarted.resolve();
        await snapshotGate.promise;
        return createValidConfigSnapshot(
          outcome === "newer content" ? initialConfig : nextConfig,
          outcome === "newer content" ? "newer-content" : "receipt-write",
        );
      });
      const reloadPlugins = vi.fn<ReloadHandlerParams["reloadPlugins"]>(async (params) => {
        await params.beforeReplace(new Set(["whatsapp"]));
        if (params.isAborted?.()) {
          return makePluginReloadResult({ cancelled: true });
        }
        await params.commitRuntime();
        return makePluginReloadResult({ activeChannels: new Set(["whatsapp"]) });
      });
      const application = createRuntimeConfigWriteApplication();
      const settled = vi.fn();
      void application.result.then(settled);
      const logReload = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const watch = vi.spyOn(chokidar, "watch");
      setActivePluginRegistry(registry);
      const reloader = startManagedGatewayConfigReloader({
        initialConfig,
        readSnapshot,
        subscribeToWrites: captureConfigWriteListener(writeListenerRef),
        logReload,
        commitTerminalConfig,
        setState,
        startChannel,
        stopChannel,
        reloadPlugins,
      });
      const registeredWriteListener = writeListenerRef.current;
      if (!registeredWriteListener) {
        throw new Error("Expected config write listener to be registered");
      }
      const unrelatedRequest = tryBeginGatewayRootWorkAdmission();
      if (!unrelatedRequest) {
        throw new Error("Expected unrelated gateway request admission");
      }
      vi.useFakeTimers();

      try {
        registeredWriteListener(
          attachRuntimeConfigWriteApplication(
            createConfigWriteNotification(nextConfig, "receipt-write", 1, "runtime", "source"),
            application,
          ),
        );
        await vi.advanceTimersByTimeAsync(10);
        expect(logReload.warn).toHaveBeenCalledWith(
          expect.stringContaining("deferring until 1 gateway request(s) complete"),
        );
        expect(application.claimed).toBe(true);
        expect(settled).not.toHaveBeenCalled();

        // Revoke the write epoch while real hot reload is waiting on unrelated work.
        // Hold the disk reread so cancellation settles before exact-candidate replay.
        const watcher = watch.mock.results[0]?.value;
        expect(watcher).toBeDefined();
        watcher.emit("change", "/tmp/openclaw.json");
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(300);
        await snapshotStarted.promise;
        expect(settled).not.toHaveBeenCalled();
        expect(setState).not.toHaveBeenCalled();
        expect(stopChannel).not.toHaveBeenCalled();
        expect(startChannel).not.toHaveBeenCalled();
        expect(commitTerminalConfig).not.toHaveBeenCalled();

        if (outcome === "lifecycle stop") {
          const stopping = reloader.stop();
          await expect(application.result).resolves.toBe("stopped");
          snapshotGate.resolve();
          await stopping;
          expect(setState).not.toHaveBeenCalled();
          expect(startChannel).not.toHaveBeenCalled();
        } else {
          if (outcome === "publication failure") {
            setState.mockImplementation(() => {
              throw new Error("runtime publication refused");
            });
          }
          snapshotGate.resolve();
          await vi.advanceTimersByTimeAsync(0);
          if (outcome !== "newer content") {
            expect(settled).not.toHaveBeenCalled();
            expect(setState).not.toHaveBeenCalled();
            expect(logReload.warn).toHaveBeenCalledTimes(2);
          }
          unrelatedRequest.release();
          await vi.advanceTimersByTimeAsync(500);
          await expect(application.result).resolves.toBe(
            outcome === "newer content"
              ? "superseded"
              : outcome === "publication failure"
                ? "failed"
                : "applied",
          );
          if (outcome === "same write") {
            expect(setState).toHaveBeenCalledOnce();
            expect(commitTerminalConfig).toHaveBeenCalledWith(nextConfig);
            expect(stopChannel).toHaveBeenCalledOnce();
            expect(startChannel).toHaveBeenCalledOnce();
            expect(logReload.error).not.toHaveBeenCalled();
          } else {
            expect(commitTerminalConfig).not.toHaveBeenCalled();
          }
        }
      } finally {
        snapshotGate.resolve();
        unrelatedRequest.release();
        const stopping = reloader.stop();
        await vi.advanceTimersByTimeAsync(500);
        await stopping;
        watch.mockRestore();
        resetPluginRuntimeStateForTest();
      }
    },
  );

  it.each(["same watcher echo", "newer admitted write", "prepared refresh failure"] as const)(
    "finishes committed runtime work before settling its receipt: %s",
    async (successor) => {
      const initialConfig: OpenClawConfig = {
        gateway: { reload: {} },
        channels: { whatsapp: { enabled: true, selfChatMode: false } },
      };
      const nextConfig: OpenClawConfig = {
        ...initialConfig,
        plugins: { entries: { fixture: { enabled: true } } },
      };
      activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "whatsapp",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "whatsapp" }),
              reload: {
                configPrefixes: ["channels.whatsapp.selfChatMode"],
                noopPrefixes: ["channels.whatsapp"],
              },
            },
          },
        ]),
      );
      const watcher = new chokidar.FSWatcher();
      const watch = vi.spyOn(chokidar, "watch").mockReturnValue(watcher);
      const writeListenerRef = createConfigWriteListenerRef();
      const channels = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
      const commitTerminalConfig = vi.fn();
      const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const watchedConfig = successor === "newer admitted write" ? initialConfig : nextConfig;
      const continuePlugin = createDeferred();
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      let blocker: ReturnType<typeof tryBeginGatewayRootWorkAdmission> = null;
      let successorRequest: Promise<RuntimeConfigWriteApplicationStatus> | undefined;
      const submitWrite = (config: OpenClawConfig, hash: string, revision: number) =>
        runWithGatewayIndependentRootWorkAdmission(async () => {
          const application = createRuntimeConfigWriteApplication(
            captureGatewayRootWorkAdmissionContinuationScope()?.run,
          );
          writeListenerRef.current!(
            attachRuntimeConfigWriteApplication(
              createConfigWriteNotification(config, hash, revision, "runtime", "source"),
              application,
            ),
          );
          return await application.result;
        });
      const reloader = startManagedGatewayConfigReloader({
        initialConfig,
        readSnapshot: vi.fn(async () => createValidConfigSnapshot(watchedConfig, "same-write")),
        subscribeToWrites: captureConfigWriteListener(writeListenerRef),
        startChannel: channels.start,
        stopChannel: channels.stop,
        reloadPlugins: async (params) => {
          await params.beforeReplace(new Set(), new Map([["whatsapp", new Set(["default"])]]));
          if (params.isAborted?.()) {
            return makePluginReloadResult({ cancelled: true });
          }
          await params.commitRuntime();
          if (params.sourceConfig === nextConfig) {
            await continuePlugin.promise;
          }
          return makePluginReloadResult({ activeChannels: new Set(["whatsapp"]) });
        },
        commitTerminalConfig,
        logReload,
        requestRecoveryRestart,
      });
      if (successor === "prepared refresh failure") {
        hoisted.refreshPreparedModelRuntimeSnapshots.mockRejectedValueOnce(
          new Error("prepared runtime refresh failed"),
        );
      }
      vi.useFakeTimers();
      const request = submitWrite(nextConfig, "same-write", 1);

      try {
        await vi.advanceTimersByTimeAsync(10);
        expect(channels.stop).toHaveBeenCalledOnce();
        blocker = tryBeginGatewayRootWorkAdmission();
        if (!blocker) {
          throw new Error("Expected unrelated gateway request admission");
        }
        continuePlugin.resolve();
        await vi.advanceTimersByTimeAsync(10);
        expect(logReload.warn).toHaveBeenCalledWith(expect.stringContaining("deferring until"));
        // A newer RPC remains admitted while waiting for the queued successor reload.
        // The committed tail must not wait for that request to finish first.
        if (successor === "newer admitted write") {
          successorRequest = submitWrite(initialConfig, "newer-write", 2);
        } else {
          watcher.emit("change", "/tmp/openclaw.json");
        }
        await vi.advanceTimersByTimeAsync(500);
        blocker.release();
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(request).resolves.toBe(
          successor === "prepared refresh failure"
            ? "applied-restart-required"
            : successor === "newer admitted write"
              ? "superseded"
              : "applied",
        );
        if (successor === "prepared refresh failure") {
          expect(channels.stop).toHaveBeenCalledOnce();
          expect(channels.start).not.toHaveBeenCalled();
          expect(requestRecoveryRestart).toHaveBeenCalledOnce();
          expect(hoisted.rejectPendingPreparedModelRuntimeReplacement).toHaveBeenCalledOnce();
        } else {
          const reloadCount = successorRequest ? 2 : 1;
          expect(channels.stop).toHaveBeenCalledTimes(reloadCount);
          expect(channels.start).toHaveBeenCalledTimes(reloadCount);
          expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledWith(
            nextConfig,
            expect.anything(),
          );
          expect(hoisted.rejectPendingPreparedModelRuntimeReplacement).not.toHaveBeenCalled();
          expect(commitTerminalConfig).toHaveBeenCalledWith(nextConfig);
          if (successorRequest) {
            await expect(successorRequest).resolves.toBe("applied");
            expect(commitTerminalConfig).toHaveBeenLastCalledWith(initialConfig);
          }
        }
        expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(watchedConfig);
        expect(logReload.error).not.toHaveBeenCalled();
      } finally {
        continuePlugin.resolve();
        blocker?.release();
        await reloader.stop();
        await request;
        await successorRequest;
        watch.mockRestore();
      }
    },
  );

  it("new reload lifecycle is not affected by a previous lifecycle abort", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    // Create gen 1 and register abort for it
    createTestHandlers(logChannels, channels);
    abortPendingChannelReloads();

    // Create gen 2 — should not carry over the abort from gen 1
    const h2 = createTestHandlers(logChannels, channels);

    hoisted.activeTaskBlockers.push(makeActiveTaskBlocker({ taskId: "task-blocking-reload-g2" }));
    vi.useFakeTimers();

    try {
      const reloadPromise = h2.applyHotReload(abortChannelReloadPlan, {});
      await vi.advanceTimersByTimeAsync(600); // past first poll interval — still waiting
      await Promise.resolve();

      // Gen 2's generation > abort generation, so it should NOT abort
      expect(logChannels.info).not.toHaveBeenCalledWith(
        "channel restart cancelled by in-process restart",
      );

      // Drain active work → should proceed to stop/start channels normally
      hoisted.activeTaskBlockers.length = 0;
      await vi.advanceTimersByTimeAsync(500); // wake up, see active=0, drain complete
      await expect(reloadPromise).resolves.toBe("applied");

      expect(channels.stop).toHaveBeenCalledWith("whatsapp", undefined, { manual: false });
      expect(channels.start).toHaveBeenCalledWith("whatsapp", undefined, {
        preserveManualStop: true,
        skipUnavailableAccounts: true,
      });
    } finally {
      vi.useRealTimers();
      hoisted.activeTaskBlockers.length = 0;
    }
  });

  it("abort inside beforeReplace prevents plugin metadata/runtime replacement and channel restart", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const pruneInactiveChannelAccountState = vi.fn();
    let receivedIsAborted = false;
    let reloadWasCancelled = false;
    const reloadPlugins = vi.fn(
      async (params: {
        nextConfig: OpenClawConfig;
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
        isAborted?: () => boolean;
      }): Promise<GatewayPluginReloadResult> => {
        if (params.isAborted) {
          receivedIsAborted = true;
        }
        await params.beforeReplace(new Set(["whatsapp"]));
        if (params.isAborted?.()) {
          reloadWasCancelled = true;
          return makePluginReloadResult({ cancelled: true });
        }
        return makePluginReloadResult();
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      startChannel: channels.start,
      stopChannel: channels.stop,
      pruneInactiveChannelAccountState,
      reloadPlugins,
      logChannels,
    });

    const pluginReloadPlan: GatewayReloadPlan = createPluginReloadPlan();

    hoisted.activeTaskBlockers.push(makeActiveTaskBlocker());
    vi.useFakeTimers();

    try {
      const reloadPromise = applyHotReload(pluginReloadPlan, {});
      const reloadRejected = expect(reloadPromise).rejects.toThrow(
        "config hot reload cancelled by config supersession or in-process restart",
      );
      // Advance into the waitForActiveWorkBeforeChannelReload poll loop
      await vi.advanceTimersByTimeAsync(100);
      abortPendingChannelReloads();
      // Advance past the 500ms sleep → abort check fires
      await vi.advanceTimersByTimeAsync(500);
      await reloadRejected;

      // reloadPlugins should receive the isAborted callback
      expect(receivedIsAborted).toBe(true);
      // reloadPlugins should detect abort and return cancelled
      expect(reloadWasCancelled).toBe(true);
      // beforeReplace cancellation log
      expect(logChannels.info).toHaveBeenCalledWith(
        "channel reload before plugin replace cancelled by config supersession or restart",
      );
      // No channel should be started — cancelledByRestart = pluginReloadAborted = true
      expect(channels.start).not.toHaveBeenCalled();
      expect(channels.stop).not.toHaveBeenCalled();
      expect(pruneInactiveChannelAccountState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      hoisted.activeTaskBlockers.length = 0;
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
