/**
 * Gateway config reload handler tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../agents/auth-profiles/runtime-snapshots.js";
import { addSession, markBackgrounded, markExited } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { prepareConfigRuntimeEnv } from "../config/config-env-vars.js";
import type { ConfigWriteNotification } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  consumeGatewaySigusr1RestartIntent,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  setGatewaySigusr1RestartPolicy,
  setPreRestartDeferralCheck,
} from "../infra/restart.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
} from "../plugins/runtime.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { CommandLane } from "../process/lanes.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import { listActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import { classifySecretOwnerDegradationState } from "../secrets/runtime-owner-assignments.js";
import {
  activateSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshotIfCurrent,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  type ChannelKind,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import type { GatewayPluginReloadResult } from "./server-reload-handlers.js";
import {
  abortPendingChannelReloads,
  createGatewayReloadHandlers as createGatewayReloadHandlersImpl,
  startManagedGatewayConfigReloader as startManagedGatewayConfigReloaderImpl,
} from "./server-reload-handlers.js";
import { enforceSharedGatewaySessionGenerationForConfigWrite } from "./server-shared-auth-generation.js";
import { createTerminalLaunchPolicy } from "./terminal/launch.js";

type ReloadHandlerParams = Parameters<typeof createGatewayReloadHandlersImpl>[0];
type ManagedReloaderParams = Parameters<typeof startManagedGatewayConfigReloaderImpl>[0];

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

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
  params: Omit<ReloadHandlerParams, "cronReconciliation" | "requestRecoveryRestart"> & {
    cronReconciliation?: ReloadHandlerParams["cronReconciliation"];
    requestRecoveryRestart?: NonNullable<ReloadHandlerParams["requestRecoveryRestart"]> | null;
  },
) {
  const { requestRecoveryRestart, ...handlerParams } = params;
  return createGatewayReloadHandlersImpl({
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

function startManagedGatewayConfigReloader(
  params: Omit<ManagedReloaderParams, "cronReconciliation" | "prepareTerminalConfig"> & {
    cronReconciliation?: ManagedReloaderParams["cronReconciliation"];
    prepareTerminalConfig?: ManagedReloaderParams["prepareTerminalConfig"];
  },
) {
  return startManagedGatewayConfigReloaderImpl({
    ...params,
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
  isCancelled?: () => boolean;
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
  reloadEvents: [] as string[],
  loadModelCatalog: vi.fn(async (_params: { config: OpenClawConfig }) => []),
  resetModelCatalogCache: vi.fn(() => {}),
  refreshContextWindowCache: vi.fn(async (_cfg: OpenClawConfig) => {}),
  clearCurrentProviderAuthState: vi.fn(() => {}),
  warmCurrentProviderAuthStateOffMainThread: vi.fn(async (_cfg: OpenClawConfig) => {}),
  disposeAllSessionMcpRuntimes: vi.fn(async () => {}),
  buildGatewayCronService: vi.fn((_params?: { env?: NodeJS.ProcessEnv }) => ({
    cron: { start: vi.fn(async () => {}), stop: vi.fn() },
    storePath: "/tmp/rebuilt-cron.json",
    cronEnabled: true,
    reconcileExitWatchers: vi.fn(async () => {}),
    stopExitWatchers: vi.fn(),
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

vi.mock("../agents/embedded-agent-runner/run-state.js", () => ({
  getActiveEmbeddedRunCount: () => hoisted.activeEmbeddedRunCount.value,
  listActiveEmbeddedRunSessionIds: () => hoisted.activeEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys: () => hoisted.activeEmbeddedRunSessionKeys,
}));

vi.mock("../agents/main-session-restart-recovery.js", () => ({
  markRestartAbortedMainSessions: hoisted.markRestartAbortedMainSessions,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => hoisted.runtimeConfig.value,
  };
});

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

function createTestCronReconciliation() {
  const complete = vi.fn<() => Promise<void>>(async () => {});
  return {
    arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete })),
    complete,
    invalidate: vi.fn(),
  };
}

function createCronRestartPlan(): GatewayReloadPlan {
  return {
    changedPaths: ["cron"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: ["cron"],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: true,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    noopPaths: [],
  };
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

function createDeferredVoid() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: () => resolve?.() };
}

function createReloadHandlersForTest(
  logReload = { info: vi.fn(), warn: vi.fn() },
  channels?: {
    start: ReloadHandlerParams["startChannel"];
    stop: ReloadHandlerParams["stopChannel"];
  },
  reloadPlugins?: Parameters<typeof createGatewayReloadHandlers>[0]["reloadPlugins"],
  stopPostReadySidecars = vi.fn(),
  recovery: boolean | NonNullable<ReloadHandlerParams["requestRecoveryRestart"]> = true,
  options?: {
    getChannelAutostartSuppression?: ReloadHandlerParams["getChannelAutostartSuppression"];
  },
) {
  const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
  const stopExitWatchers = vi.fn();
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  let state: Parameters<ReloadHandlerParams["setState"]>[0] = {
    hooksConfig: {} as never,
    hookClientIpConfig: {} as never,
    heartbeatRunner: heartbeatRunner as never,
    cronState: {
      cron,
      storePath: "/tmp/cron.json",
      cronEnabled: false,
      stopExitWatchers,
    } as never,
    channelHealthMonitor: null,
  };
  const setState = vi.fn((nextState: typeof state) => {
    state = nextState;
  });
  const cronReconciliation = createTestCronReconciliation();
  const logCron = { error: vi.fn() };
  const logChannels = { info: vi.fn(), error: vi.fn() };
  const handlers = createGatewayReloadHandlers({
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => state,
    setState,
    startChannel: channels?.start ?? vi.fn(async () => {}),
    stopChannel: channels?.stop ?? vi.fn(async () => {}),
    getChannelAutostartSuppression: options?.getChannelAutostartSuppression,
    stopPostReadySidecars,
    reloadPlugins:
      reloadPlugins ??
      vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    createHealthMonitor: () => null,
  });
  return {
    ...handlers,
    cron,
    cronReconciliation,
    heartbeatRunner,
    logChannels,
    logCron,
    setState,
    stopExitWatchers,
  };
}

function createManagedRestartSequenceHarness(
  options: { invalidateGenerationOnReconcile?: boolean } = {},
) {
  const initialConfig = {
    gateway: {
      port: 18789,
      reload: { debounceMs: 0 },
      terminal: { enabled: true },
    },
  } as OpenClawConfig;
  setRuntimeConfigSnapshot(initialConfig, initialConfig);
  activateSecretsRuntimeSnapshot({
    sourceConfig: initialConfig,
    config: initialConfig,
    authStores: [],
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    warnings: [],
    webTools: createEmptyRuntimeWebToolsMetadata(),
  });
  const deferredConfig = {
    gateway: {
      port: 18790,
      reload: { debounceMs: 0 },
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
    tools: {
      web: {
        search: { apiKey: missingHotSecret },
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
  const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
    current: null,
  };
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
  const activateRuntimeSecrets = vi.fn(async (config: OpenClawConfig, _params: unknown) => {
    const secretInputs = [
      config.gateway?.auth?.token,
      config.models?.providers?.test?.apiKey,
      config.tools?.web?.search?.apiKey,
    ];
    for (const secretInput of secretInputs) {
      if (
        typeof secretInput === "object" &&
        secretInput !== null &&
        "id" in secretInput &&
        unavailableSecretIds.has(secretInput.id)
      ) {
        throw new Error(`required SecretRef ${secretInput.id} is unavailable`);
      }
    }
    return {
      sourceConfig: config,
      config,
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    };
  });
  const requestRecoveryRestart = vi.fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>(
    () => ({ status: "emitted" }),
  );
  const sharedGatewaySessionGenerationState = { current: undefined, required: null };
  let generationInvalidated = false;
  const reloader = startManagedGatewayConfigReloader({
    minimalTestGateway: false,
    initialConfig,
    initialCompareConfig: initialConfig,
    initialInternalWriteHash: null,
    watchPath: "/tmp/openclaw.json",
    readSnapshot: vi.fn(async () => ({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: snapshotConfig,
      sourceConfig: snapshotConfig,
      resolved: snapshotConfig,
      valid: true,
      runtimeConfig: snapshotConfig,
      config: snapshotConfig,
      issues: [],
      warnings: [],
      legacyIssues: [],
      hash: snapshotHash,
    })) as never,
    promoteSnapshot: promoteSnapshot as never,
    subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
      writeListenerRef.current = listener;
      return () => {
        if (writeListenerRef.current === listener) {
          writeListenerRef.current = null;
        }
      };
    }) as never,
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => ({
      hooksConfig: {} as never,
      hookClientIpConfig: {} as never,
      heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
      cronState: {
        cron: { start: vi.fn(async () => {}), stop: vi.fn() },
        storePath: "/tmp/cron.json",
        cronEnabled: false,
      } as never,
      channelHealthMonitor: null,
    }),
    setState: vi.fn(),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    reloadPlugins: vi.fn(
      async (): Promise<GatewayPluginReloadResult> => ({
        restartChannels: new Set(),
        activeChannels: new Set(),
      }),
    ),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload,
    channelManager: {} as never,
    activateRuntimeSecrets: activateRuntimeSecrets as never,
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState,
    clients: [],
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
    listener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: config,
      runtimeConfig,
      persistedHash: hash,
      revision,
      fingerprint: `runtime-${hash}`,
      sourceFingerprint: `source-${hash}`,
      writtenAtMs: Date.now(),
    });
  };

  return {
    activateRuntimeSecrets,
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

beforeEach(() => {
  process.on("SIGUSR1", testGatewayRestartListener);
  resetGatewayWorkAdmission();
  resetProcessRegistryForTests();
  delete process.env.OPENCLAW_SKIP_CHANNELS;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
});

afterEach(() => {
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
  hoisted.reloadEvents.length = 0;
  hoisted.loadModelCatalog.mockClear();
  hoisted.resetModelCatalogCache.mockClear();
  hoisted.refreshContextWindowCache.mockClear();
  hoisted.clearCurrentProviderAuthState.mockClear();
  hoisted.warmCurrentProviderAuthStateOffMainThread.mockClear();
  hoisted.disposeAllSessionMcpRuntimes.mockClear();
  hoisted.disposeAllSessionMcpRuntimes.mockResolvedValue(undefined);
  hoisted.buildGatewayCronService.mockClear();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
});

async function runManagedOwnershipScenario(params: {
  kind: "noop" | "hot" | "restart";
  queueRevert: boolean;
}) {
  const initialConfig = {
    gateway: { reload: { mode: "off" as const, debounceMs: 0 } },
    hooks: { enabled: true, token: "test-token", path: "/old" },
  } satisfies OpenClawConfig;
  const configA = {
    gateway: {
      reload: {
        mode: params.kind === "restart" ? ("restart" as const) : ("hot" as const),
        debounceMs: 0,
      },
    },
    hooks: {
      enabled: true,
      token: "test-token",
      path: params.kind === "noop" ? "/old" : "/a",
    },
  } satisfies OpenClawConfig;
  const configB = structuredClone(initialConfig);
  const snapshot = (config: OpenClawConfig): PreparedSecretsRuntimeSnapshot => ({
    sourceConfig: config,
    config,
    authStores: [],
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    warnings: [],
    webTools: createEmptyRuntimeWebToolsMetadata(),
  });
  const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
    current: null,
  };
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
  const activateRuntimeSecrets = vi.fn(async (config: OpenClawConfig) => {
    if (params.queueRevert && !queuedB) {
      queuedB = true;
      writeListenerRef.current?.({
        configPath: "/tmp/openclaw.json",
        sourceConfig: configB,
        runtimeConfig: configB,
        persistedHash: "hash-b",
        revision: 2,
        fingerprint: "runtime-b",
        sourceFingerprint: "source-b",
        writtenAtMs: Date.now(),
      });
    }
    return snapshot(config);
  });
  activateSecretsRuntimeSnapshot(snapshot(initialConfig));
  const reloader = startManagedGatewayConfigReloader({
    minimalTestGateway: false,
    initialConfig,
    initialCompareConfig: initialConfig,
    initialInternalWriteHash: null,
    watchPath: "/tmp/openclaw.json",
    readSnapshot: vi.fn(async () => ({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      sourceConfig: configB,
      resolved: configB,
      valid: true,
      runtimeConfig: configB,
      config: configB,
      issues: [],
      warnings: [],
      legacyIssues: [],
      hash: "hash-b",
    })) as never,
    promoteSnapshot: vi.fn(async () => true) as never,
    subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
      writeListenerRef.current = listener;
      return () => {
        writeListenerRef.current = null;
      };
    }) as never,
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => ({
      hooksConfig: {} as never,
      hookClientIpConfig: {} as never,
      heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
      cronState: {
        cron: { start: vi.fn(async () => {}), stop: vi.fn() },
        storePath: "/tmp/cron.json",
        cronEnabled: false,
      } as never,
      channelHealthMonitor: null,
    }),
    setState: vi.fn(),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    reloadPlugins: vi.fn(async () => ({
      restartChannels: new Set<ChannelKind>(),
      activeChannels: new Set<ChannelKind>(),
    })),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    channelManager: {} as never,
    activateRuntimeSecrets: activateRuntimeSecrets as never,
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: { current: undefined, required: null },
    clients: [],
    prepareTerminalConfig,
    reconcileTerminalSessions,
    commitTerminalConfig,
    acceptTerminalConfig,
    requestRecoveryRestart,
  });
  writeListenerRef.current?.({
    configPath: "/tmp/openclaw.json",
    sourceConfig: configA,
    runtimeConfig: configA,
    persistedHash: "hash-a",
    revision: 1,
    fingerprint: "runtime-a",
    sourceFingerprint: "source-a",
    writtenAtMs: Date.now(),
  });
  try {
    await accepted;
    return {
      acceptTerminalConfig,
      activateRuntimeSecrets,
      commitTerminalConfig,
      configA,
      configB,
      prepareTerminalConfig,
      reconcileTerminalSessions,
      requestRecoveryRestart,
    };
  } finally {
    await reloader.stop();
  }
}

describe("managed reload transaction ownership", () => {
  it("applies a current in-process hot config", async () => {
    const result = await runManagedOwnershipScenario({ kind: "hot", queueRevert: false });

    expect(result.activateRuntimeSecrets).toHaveBeenCalledOnce();
    expect(result.commitTerminalConfig).toHaveBeenCalledOnce();
    expect(result.acceptTerminalConfig).toHaveBeenCalledOnce();
    expect(result.prepareTerminalConfig).toHaveBeenCalledOnce();
    expect(result.reconcileTerminalSessions).toHaveBeenCalledOnce();
    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(result.configA);
  });

  it.each(["noop", "hot", "restart"] as const)(
    "yields stale config A when queued %s config B reverts to the old source",
    async (kind) => {
      const result = await runManagedOwnershipScenario({ kind, queueRevert: true });

      expect(result.activateRuntimeSecrets).toHaveBeenCalledOnce();
      expect(result.commitTerminalConfig).not.toHaveBeenCalled();
      expect(result.acceptTerminalConfig).toHaveBeenCalledOnce();
      expect(result.prepareTerminalConfig).toHaveBeenCalledOnce();
      expect(result.reconcileTerminalSessions).not.toHaveBeenCalled();
      expect(result.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig).toEqual(result.configB);
    },
  );
});

describe("gateway hot reload model state", () => {
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
      stopExitWatchers: vi.fn(),
    };
    hoisted.buildGatewayCronService.mockImplementationOnce(() => {
      order.push("build-new");
      return rebuiltCronState;
    });
    const { applyHotReload, cron, cronReconciliation, setState, stopExitWatchers } =
      createReloadHandlersForTest();
    cron.stop.mockImplementation(() => {
      order.push("stop-old");
    });
    stopExitWatchers.mockImplementation(() => {
      order.push("stop-old-watchers");
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
    expect(stopExitWatchers).toHaveBeenCalledTimes(1);
    expect(newCron.start).toHaveBeenCalledTimes(1);
    await waitForFast(() => expect(newReconcileExitWatchers).toHaveBeenCalledTimes(1));
    await waitForFast(() => expect(order.at(-1)).toBe("hook"));
    expect(order).toEqual([
      "build-new",
      "invalidate-old",
      "stop-old",
      "stop-old-watchers",
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

  it("completes reload reconciliation when the replacement scheduler is disabled", async () => {
    const rebuiltCronState = {
      cron: { start: vi.fn(async () => {}), stop: vi.fn() },
      storePath: "/tmp/rebuilt-cron.json",
      cronEnabled: false,
      reconcileExitWatchers: vi.fn(async () => {}),
      stopExitWatchers: vi.fn(),
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

  it("applies an in-place heartbeat update without a recovery restart owner", async () => {
    const { applyHotReload, heartbeatRunner, setState } = createReloadHandlersForTest(
      undefined,
      undefined,
      undefined,
      vi.fn(),
      false,
    );
    const nextConfig = { agents: { defaults: { heartbeat: { every: "1h" } } } } as OpenClawConfig;

    await expect(
      applyHotReload(createHotTailPlan({ restartHeartbeat: true }), nextConfig),
    ).resolves.toBeUndefined();

    expect(heartbeatRunner.updateConfig).toHaveBeenCalledWith(nextConfig);
    expect(setState).toHaveBeenCalledOnce();
  });

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
          { publish, isCurrent: () => true },
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
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
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
      stopExitWatchers: vi.fn(),
    });
    const { applyHotReload, setState } = createReloadHandlersForTest(logReload);

    try {
      await expect(
        applyHotReload(createCronRestartPlan(), { cron: { enabled: true } }),
      ).resolves.toBeUndefined();

      expect(setState).toHaveBeenCalledOnce();
      await waitForFast(() => expect(signalSpy).toHaveBeenCalledOnce());
      expect(logReload.warn).toHaveBeenCalledWith(
        "cron reload failed after config commit: cron start failed; restarting gateway",
      );
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
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
      stopExitWatchers: vi.fn(),
    };
    const secondCronState = {
      cron: { start: vi.fn(async () => {}), stop: vi.fn() },
      storePath: "/tmp/second-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      stopExitWatchers: vi.fn(),
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
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const publish = vi.fn(async (commit: () => Promise<void>) => await commit());
    const { applyHotReload, cron, setState } = createReloadHandlersForTest(logReload);
    cron.stop.mockImplementation(() => {
      throw new Error("cron stop failed");
    });

    try {
      await expect(
        applyHotReload(
          createCronRestartPlan(),
          { cron: { enabled: true } },
          {
            publish,
            isCurrent: () => true,
          },
        ),
      ).resolves.toBeUndefined();

      expect(publish).toHaveBeenCalledOnce();
      expect(setState).toHaveBeenCalledOnce();
      expect(logReload.warn).toHaveBeenCalledWith(
        "runtime commit failed after config commit: cron stop failed; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("resets prepared model runtime state for every hot reload and rewarms after plugin reload", async () => {
    const reloadPlugins = vi.fn(async (): Promise<GatewayPluginReloadResult> => {
      hoisted.reloadEvents.push("reload-plugins");
      return {
        restartChannels: new Set(),
        activeChannels: new Set(),
      };
    });
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });

    const nextConfig = { plugins: { enabled: true } } as OpenClawConfig;
    await applyHotReload(
      {
        changedPaths: ["plugins.enabled"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["plugins.enabled"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: true,
        restartChannels: new Set(),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      nextConfig,
    );

    const firstResetIndex = hoisted.reloadEvents.indexOf("reset-model-catalog");
    expect(firstResetIndex).toBeGreaterThanOrEqual(0);
    expect(hoisted.reloadEvents.slice(firstResetIndex)).toEqual([
      "reset-model-catalog",
      "clear-provider-auth",
      "reload-plugins",
      "reset-model-catalog",
      "clear-provider-auth",
      "refresh-context-window",
      "load-model-catalog",
      "warm-provider-auth",
    ]);
    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
    expect(hoisted.loadModelCatalog).toHaveBeenCalledWith({ config: nextConfig });
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
      {
        changedPaths: ["mcp.servers.context7.command"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["mcp.servers.context7.command"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(),
        disposeMcpRuntimes: true,
        noopPaths: [],
      },
      nextConfig,
    );

    expect(hoisted.disposeAllSessionMcpRuntimes).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledOnce();
    expect(logReload.warn).toHaveBeenCalledWith(
      "bundle-mcp runtime disposal during config reload failed: Error: dispose failed",
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
      {
        changedPaths: ["agents.defaults.workspace"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["agents.defaults.workspace"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
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
      const entered = createDeferredVoid();
      const release = createDeferredVoid();
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
        isCurrent,
        publish: async (commit) => await commit(),
      });

      await entered.promise;
      pendingConfig = invalidConfigB;
      release.resolve();
      await expect(reloadA).resolves.toBeUndefined();

      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        expect.stringContaining("recovery deferred to the newer config"),
      );
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();

      const configC = { logging: { level: "debug" as const } } satisfies OpenClawConfig;
      pendingConfig = configC;
      await handlers.applyHotReload(createHotTailPlan(), configC, {
        isCurrent: () => pendingConfig === configC,
        publish: async (commit) => await commit(),
      });

      expect(handlers.setState).toHaveBeenCalledTimes(2);
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
    },
  );

  it("finishes a channel restart after config B revokes A between stop and start", async () => {
    const stopped = createDeferredVoid();
    const releaseStop = createDeferredVoid();
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
        isCurrent: () => current,
        publish: async (commit) => await commit(),
      },
    );

    await stopped.promise;
    current = false;
    releaseStop.resolve();
    await reloadA;

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord");
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
      cronState: {
        cron: { start: vi.fn(async () => {}), stop: vi.fn() },
        storePath: "/tmp/cron.json",
        cronEnabled: false,
      } as never,
      channelHealthMonitor: oldMonitor as never,
    };
    const setState = vi.fn((nextState: typeof state) => {
      events.push("setState");
      state = nextState;
    });
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => state,
      setState,
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(async () => ({
        restartChannels: new Set<ChannelKind>(),
        activeChannels: new Set<ChannelKind>(),
      })),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      requestRecoveryRestart: vi.fn(() => ({ status: "emitted" as const })),
      createHealthMonitor: vi.fn(() => {
        events.push("create");
        return nextMonitor as never;
      }),
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
        {
          changedPaths: ["commands.restart", "hooks.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["commands.restart", "hooks.enabled"],
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
        { commands: { restart: true }, hooks: { enabled: true } },
      ),
    ).rejects.toThrow("hooks.enabled requires hooks.token");

    expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(false);
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
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("recovery-pending");
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
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ),
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
    const restartPlan = {
      changedPaths: ["gateway.port"],
      restartGateway: true,
      restartReasons: ["gateway.port"],
      hotReasons: [],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: false,
      restartChannels: new Set<ChannelKind>(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    } satisfies GatewayReloadPlan;
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
        hoisted.activeTaskBlockers.push({
          taskId: "discord-recovery-blocker",
          status: "running",
          runtime: "subagent",
        });
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
    const plan = {
      changedPaths: ["channels.discord.token", "logging.level"],
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["channels.discord.token"],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: false,
      restartChannels: new Set<ChannelKind>(["discord"]),
      disposeMcpRuntimes: false,
      noopPaths: ["logging.level"],
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
        hoisted.activeTaskBlockers.push({
          taskId: "discord-recovery-clear-blocker",
          status: "running",
          runtime: "subagent",
        });
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
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          { gateway: { port: 18790 } },
        ).status,
      ).toBe("recovery-pending");

      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.auth"],
            restartGateway: true,
            restartReasons: ["gateway.auth"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          { gateway: { port: 18791 } },
        ).status,
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
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("accepted");

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
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("accepted");

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
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("accepted");

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

  it("retries a timed-out deferral with its original force intent", async () => {
    const requestRecoveryRestart = vi
      .fn<NonNullable<ReloadHandlerParams["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockReturnValueOnce({ status: "emitted" });
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart, stopRestartRetries } = createReloadHandlersForTest(
      logReload,
      undefined,
      undefined,
      undefined,
      requestRecoveryRestart,
    );
    hoisted.activeTaskBlockers.push({
      taskId: "force-intent-blocker",
      status: "running",
      runtime: "subagent",
    });
    vi.useFakeTimers();

    try {
      const transaction = requestGatewayRestart(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { gateway: { reload: { deferralTimeoutMs: 500 } } },
      );
      transaction.settle("committed");

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(requestRecoveryRestart.mock.calls).toEqual([
        ["config reload: gateway.port", { force: true, reason: "config reload forced restart" }],
        ["config reload: gateway.port", { force: true, reason: "config reload forced restart" }],
      ]);
      expect(
        logReload.warn.mock.calls.filter(([message]) =>
          message.includes("deferring until 1 background task run(s) complete"),
        ),
      ).toHaveLength(1);
    } finally {
      stopRestartRetries();
      hoisted.activeTaskBlockers.length = 0;
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
      expect(
        requestGatewayRestart(
          {
            changedPaths: ["gateway.port"],
            restartGateway: true,
            restartReasons: ["gateway.port"],
            hotReasons: [],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: false,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          {},
        ).status,
      ).toBe("accepted");
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
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const setState = vi.fn();
    let runtimePublished = false;
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      {
        changedPaths: ["channels.discord.token"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["channels.discord.token"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(["discord"]),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      {
        gateway: { reload: { deferralTimeoutMs: 60_000 } },
        channels: { discord: { token: "token" } },
      },
      {
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
    }

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord");
    expect(runtimePublished).toBe(true);
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("forces channel hot reload after the configured deferral timeout", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      {
        changedPaths: ["channels.discord.token"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["channels.discord.token"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(["discord"]),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      {
        gateway: { reload: { deferralTimeoutMs: 1_000 } },
        channels: { discord: { token: "token" } },
      },
    );
    try {
      await Promise.resolve();
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await reloadPromise;
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reloadPromise.catch(() => {});
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
    }

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord");
    expect(logReload.warn).toHaveBeenCalledWith(
      expect.stringContaining("channel reload timeout after"),
    );
  });

  it("uses the default channel reload deferral timeout when config omits deferralTimeoutMs", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      {
        changedPaths: ["channels.telegram.botToken"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["channels.telegram.botToken"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(["telegram"]),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
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
    }

    expect(stopChannel).toHaveBeenCalledWith("telegram", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("telegram");
    expect(logReload.warn).toHaveBeenCalledWith(
      expect.stringContaining("channel reload timeout after"),
    );
  });

  it("waits indefinitely for channel hot reload when deferral timeout is 0", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const startChannel = vi.fn(async () => {});
    const stopChannel = vi.fn(async () => {});
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });
    hoisted.activeEmbeddedRunCount.value = 1;
    vi.useFakeTimers();
    const reloadPromise = applyHotReload(
      {
        changedPaths: ["channels.discord.token"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["channels.discord.token"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(["discord"]),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      {
        gateway: { reload: { deferralTimeoutMs: 0 } },
        channels: { discord: { token: "token" } },
      },
    );
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();
      expect(logReload.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("channel reload timeout after"),
      );

      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500);
      await reloadPromise;
    } finally {
      hoisted.activeEmbeddedRunCount.value = 0;
      await vi.advanceTimersByTimeAsync(500).catch(() => {});
      vi.useRealTimers();
      await reloadPromise.catch(() => {});
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
    }

    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).toHaveBeenCalledWith("discord");
  });

  it("logs active task run ids before waiting and when forcing after timeout", async () => {
    restartTesting.resetSigusr1State();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { requestGatewayRestart } = createReloadHandlersForTest(logReload);
    hoisted.activeTaskCount.value = 1;
    hoisted.activeEmbeddedRunSessionIds.push("session-issue-82433");
    hoisted.activeEmbeddedRunSessionKeys.push("agent:main:issue-82433");
    hoisted.activeTaskBlockers.push({
      taskId: "task-nightly",
      runId: "run-nightly",
      status: "running",
      runtime: "cron",
      label: "nightly sync",
      title: "refresh all accounts",
    });
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      requestGatewayRestart(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {
          gateway: { reload: { deferralTimeoutMs: 1_000 } },
        },
      );

      expect(logReload.warn.mock.calls).toEqual([
        [
          "config change requires gateway restart (gateway.port) — deferring until 1 background task run(s) complete",
        ],
        [
          "restart blocked by active background task run(s): taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts",
        ],
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(signalSpy).toHaveBeenCalledTimes(1);
      expect(consumeGatewaySigusr1RestartIntent()).toEqual({
        force: true,
        reason: "config reload forced restart",
      });
      expect(hoisted.markRestartAbortedMainSessions).not.toHaveBeenCalled();
      expect(logReload.warn.mock.calls).toEqual([
        [
          "config change requires gateway restart (gateway.port) — deferring until 1 background task run(s) complete",
        ],
        [
          "restart blocked by active background task run(s): taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts",
        ],
        [
          "restart timeout after 1000ms with 1 background task run(s) still active (taskId=task-nightly runId=run-nightly status=running runtime=cron label=nightly sync title=refresh all accounts); forcing restart",
        ],
      ]);
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
    hoisted.activeTaskBlockers.push({
      taskId: "task-running-1",
      status: "running",
      runtime: "subagent",
    });
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    vi.useFakeTimers();

    try {
      requestGatewayRestart(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {},
      );

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
    return {
      changedPaths: channels.map((channel) => `channels.${channel}.enabled`),
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["channels"],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: false,
      restartChannels: new Set(channels),
      disposeMcpRuntimes: false,
      noopPaths: [],
    };
  }

  async function withChannelReloadsEnabled(run: () => Promise<void>) {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    try {
      await run();
    } finally {
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
    pinActivePluginChannelRegistry(registry);
    try {
      await run();
    } finally {
      releasePinnedPluginChannelRegistry(registry);
    }
  }

  async function withDiscordAccounts(accountIds: string[], run: () => Promise<void>) {
    await withDiscordAccountResolver(() => accountIds, run);
  }

  it("restarts only the changed account", async () => {
    const events: string[] = [];
    const startRootCounts: number[] = [];
    const accountStopSettled = createDeferredVoid();
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
    let reload: Promise<void> | undefined;

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
    const channels = {
      stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`stop:${channel}:${accountId}`);
      }),
      start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`start:${channel}:${accountId}`);
      }),
    };
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
    const channels = {
      stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`stop:${channel}:${accountId}`);
      }),
      start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`start:${channel}:${accountId}`);
      }),
    };
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
    const channels = {
      stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`stop:${channel}:${accountId}`);
      }),
      start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`start:${channel}:${accountId}`);
      }),
    };
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
    const channels = {
      stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`stop:${channel}:${accountId}`);
      }),
      start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`start:${channel}:${accountId}`);
      }),
    };
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
    const channels = {
      stop: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`stop:${channel}:${accountId}`);
      }),
      start: vi.fn(async (channel: ChannelKind, accountId?: string) => {
        events.push(`start:${channel}:${accountId}`);
      }),
    };
    const reloadPlugins = vi.fn(async (params): Promise<GatewayPluginReloadResult> => {
      await params.beforeReplace(new Set());
      hoisted.activeEmbeddedRunCount.value = 1;
      return {
        restartChannels: new Set(),
        activeChannels: new Set(["discord"]),
      };
    });
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const { applyHotReload } = createReloadHandlersForTest(logReload, channels, reloadPlugins);
    vi.useFakeTimers();
    let reload: Promise<void> | undefined;

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
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: channels.start,
      stopChannel: channels.stop,
      getChannelAutostartSuppression: () => ({
        reason: "crash-loop-breaker",
        message: "safe mode",
      }),
      stopPostReadySidecars: vi.fn(),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
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

    pinActivePluginChannelRegistry(registry);
    try {
      const plan = buildGatewayReloadPlan(["channels.whatsapp.selfChatMode"]);
      const { applyHotReload } = createReloadHandlersForTest(undefined, channels);

      expect(plan.restartGateway).toBe(false);
      expect(plan.restartChannels).toEqual(new Set(["whatsapp"]));
      await withChannelReloadsEnabled(() => applyHotReload(plan, {}));

      expect(events).toEqual(["stop:whatsapp", "start:whatsapp"]);
    } finally {
      releasePinnedPluginChannelRegistry(registry);
    }
  });

  it("continues restarting later channels after a hot-reload stop failure", async () => {
    const events: string[] = [];
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
      if (channel === "telegram") {
        throw new Error("stop failed");
      }
    });
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
    });
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });

    await withGatewayRestartSignal(async (signalSpy) => {
      await withChannelReloadsEnabled(async () => {
        await expect(
          applyHotReload(createChannelReloadPlan(["telegram", "discord"]), {}),
        ).resolves.toBeUndefined();
      });
      expect(signalSpy).toHaveBeenCalledOnce();
    });

    expect(events).toEqual(["stop:telegram", "stop:discord", "start:discord"]);
    expect(logChannels.error).toHaveBeenCalledWith(
      "failed to restart telegram channel during hot reload: stop failed",
    );
    expect(setState).toHaveBeenCalledTimes(1);
    expect(logReload.warn).toHaveBeenCalledWith(
      "channel restart (telegram) failed after config commit; restarting gateway",
    );
  });

  it("continues restarting later channels after a hot-reload start failure", async () => {
    const events: string[] = [];
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const stopChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`stop:${channel}`);
    });
    const startChannel = vi.fn(async (channel: ChannelKind) => {
      events.push(`start:${channel}`);
      if (channel === "telegram") {
        throw new Error("start failed");
      }
    });
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: () => null,
    });

    await withGatewayRestartSignal(async (signalSpy) => {
      await withChannelReloadsEnabled(async () => {
        await expect(
          applyHotReload(createChannelReloadPlan(["telegram", "discord"]), {}),
        ).resolves.toBeUndefined();
      });
      expect(signalSpy).toHaveBeenCalledOnce();
    });

    expect(events).toEqual(["stop:telegram", "start:telegram", "stop:discord", "start:discord"]);
    expect(logChannels.error).toHaveBeenCalledWith(
      "failed to restart telegram channel during hot reload: start failed",
    );
    expect(setState).toHaveBeenCalledTimes(1);
    expect(logReload.warn).toHaveBeenCalledWith(
      "channel restart (telegram) failed after config commit; restarting gateway",
    );
  });
});

describe("gateway Gmail hot reload handlers", () => {
  function createGmailReloadPlan(): GatewayReloadPlan {
    return {
      changedPaths: ["hooks.gmail.account"],
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["hooks.gmail.account"],
      reloadHooks: false,
      restartGmailWatcher: true,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: false,
      restartChannels: new Set<ChannelKind>(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    };
  }

  function createGmailConfig(account: string): OpenClawConfig {
    return {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true, token: "test-token", gmail: { account } },
    };
  }

  it("stops queued post-ready sidecars before restarting Gmail watcher", async () => {
    const stopPostReadySidecars = vi.fn();
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      stopPostReadySidecars,
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });
    const nextConfig = {
      hooks: { enabled: true, gmail: { account: "next@example.com" } },
    } as never;

    await applyHotReload(
      {
        changedPaths: ["hooks.gmail.account"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["hooks.gmail.account"],
        reloadHooks: false,
        restartGmailWatcher: true,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: false,
        restartChannels: new Set(),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      nextConfig,
    );

    expect(hoisted.refreshContextWindowCache).not.toHaveBeenCalled();
    expect(stopPostReadySidecars).toHaveBeenCalledBefore(hoisted.stopGmailWatcher);
    expect(hoisted.startGmailWatcherWithLogs).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: nextConfig }),
    );
  });

  it("restarts when post-ready sidecar teardown fails after runtime commit", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
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

    try {
      await expect(
        applyHotReload(createGmailReloadPlan(), createGmailConfig("next@example.com")),
      ).resolves.toBeUndefined();

      expect(stopPostReadySidecars).toHaveBeenCalledOnce();
      expect(setState).toHaveBeenCalledOnce();
      expect(logReload.warn).toHaveBeenCalledWith(
        "gmail watcher reload failed after config commit: sidecar stop failed; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("passes a cancellable signal to Gmail watcher restarts", async () => {
    const abortController = new AbortController();
    const clearGmailRestartAbortController = vi.fn();
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
      createGmailRestartAbortController: () => abortController,
      clearGmailRestartAbortController,
    });
    const nextConfig = createGmailConfig("next@example.com");

    await applyHotReload(createGmailReloadPlan(), nextConfig);

    const [restartParams] = hoisted.startGmailWatcherWithLogs.mock.calls[0] ?? [];
    expect(restartParams).toMatchObject({ cfg: nextConfig });
    expect(restartParams?.signal).toBe(abortController.signal);
    expect(restartParams?.isCancelled?.()).toBe(false);
    abortController.abort();
    expect(restartParams?.isCancelled?.()).toBe(true);
    expect(clearGmailRestartAbortController).toHaveBeenCalledWith(abortController);
  });

  it("retries managed no-op reloads without publishing superseded secret failures", async () => {
    vi.useFakeTimers();
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      messages: { visibleReplies: "automatic" },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      messages: { visibleReplies: "message_tool" },
    };
    const snapshot = (config: OpenClawConfig): PreparedSecretsRuntimeSnapshot => ({
      sourceConfig: config,
      config,
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    });
    const failurePublicationEligibility: boolean[] = [];
    let preparationAttempt = 0;
    const activateRuntimeSecrets = vi.fn(
      async (
        config: OpenClawConfig,
        activation: { canPublishFailureAsDegraded?: () => boolean },
      ) => {
        const attempt = preparationAttempt++;
        if (attempt === 0) {
          failurePublicationEligibility.push(activation.canPublishFailureAsDegraded?.() ?? false);
          activateSecretsRuntimeSnapshot(snapshot(initialConfig));
          failurePublicationEligibility.push(activation.canPublishFailureAsDegraded?.() ?? true);
          throw new Error("superseded secret preparation failure");
        }
        if (attempt === 1) {
          queueMicrotask(() => {
            queueMicrotask(() => activateSecretsRuntimeSnapshot(snapshot(initialConfig)));
          });
        }
        return snapshot(config);
      },
    );
    const heartbeatRunner = { stop: vi.fn(), updateConfig: vi.fn() };
    const acceptTerminalConfig = vi.fn();
    const commitTerminalConfig = vi.fn();
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: nextConfig,
        resolved: nextConfig,
        valid: true,
        runtimeConfig: nextConfig,
        config: nextConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "hash-next",
      })) as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: activateRuntimeSecrets as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig,
      acceptTerminalConfig,
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(activateRuntimeSecrets).toHaveBeenCalledTimes(3);
    expect(activateRuntimeSecrets).toHaveBeenCalledWith(nextConfig, {
      reason: "reload",
      activate: false,
      publishFailureAsDegraded: true,
      canPublishFailureAsDegraded: expect.any(Function),
      includeAuthStoreRefs: undefined,
    });
    expect(failurePublicationEligibility).toEqual([true, false]);
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
      gateway: { reload: { debounceMs: 0 } },
      messages: { tts: { providers: { elevenlabs: { apiKey: ref } } } },
    });
    const runtimeConfig: OpenClawConfig = {
      gateway: { reload: { debounceMs: 0 } },
      messages: { tts: { providers: { elevenlabs: { apiKey: String(42) } } } },
    };
    const ttsContractDigest = "tts-source-only-contract";
    const initialSourceConfig = sourceConfig(firstRef);
    const nextSourceConfig = sourceConfig(secondRef);
    const activeWarning = {
      code: "SECRETS_OWNER_UNAVAILABLE" as const,
      path: "messages.tts.providers.elevenlabs.apiKey",
      message: "Text-to-speech remains unavailable.",
    };
    activateSecretsRuntimeSnapshot({
      sourceConfig: initialSourceConfig,
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
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [activeWarning],
      degradedOwners: [
        {
          ownerKind: "capability",
          ownerId: "tts",
          state: "unavailable",
          paths: ["messages.tts.providers.elevenlabs.apiKey"],
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
      webTools: createEmptyRuntimeWebToolsMetadata(),
    });
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const activateRuntimeSecrets = vi.fn(async (config: OpenClawConfig, _params: unknown) => ({
      sourceConfig: config,
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
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
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
      webTools: createEmptyRuntimeWebToolsMetadata(),
    }));
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig: runtimeConfig,
      initialCompareConfig: runtimeConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
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
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      prepareConfigCandidate: ({ runtimeConfig: candidateRuntime }) => ({
        runtimeConfig: candidateRuntime,
        compareConfig: candidateRuntime,
      }),
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(async () => ({
        restartChannels: new Set<ChannelKind>(),
        activeChannels: new Set<ChannelKind>(),
      })),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: activateRuntimeSecrets as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      acceptTerminalConfig: vi.fn(),
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
      listener({
        configPath: "/tmp/openclaw.json",
        sourceConfig: unrelatedSourceConfig,
        runtimeConfig,
        persistedHash: "same-secrets-new-source",
        revision: 1,
        fingerprint: "same-runtime",
        sourceFingerprint: "same-secrets-new-source",
        writtenAtMs: Date.now(),
      });
      await vi.runAllTimersAsync();

      expect(activateRuntimeSecrets).not.toHaveBeenCalled();
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

      listener({
        configPath: "/tmp/openclaw.json",
        sourceConfig: nextSourceConfig,
        runtimeConfig,
        persistedHash: "same-runtime-next-source",
        revision: 2,
        fingerprint: "same-runtime",
        sourceFingerprint: "next-source",
        writtenAtMs: Date.now(),
      });
      await vi.runAllTimersAsync();

      expect(activateRuntimeSecrets.mock.calls[0]?.[1]).toMatchObject({
        activate: false,
        includeAuthStoreRefs: true,
        publishFailureAsDegraded: true,
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

      activateRuntimeSecrets.mockImplementationOnce(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config: { ...runtimeConfig, logging: { level: "debug" } },
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        secretOwners: [
          {
            ownerKind: "capability" as const,
            ownerId: "tts",
            refKeys: ["env:default:TTS_THIRD"],
            contractDigest: ttsContractDigest,
          },
        ],
        webTools: createEmptyRuntimeWebToolsMetadata(),
      }));
      listener({
        configPath: "/tmp/openclaw.json",
        sourceConfig: sourceConfig(thirdRef),
        runtimeConfig,
        persistedHash: "changed-second-resolution",
        revision: 2,
        fingerprint: "same-runtime",
        sourceFingerprint: "changed-second-resolution",
        writtenAtMs: Date.now(),
      });
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
      activateRuntimeSecrets.mockImplementationOnce(async (config: OpenClawConfig) => {
        markPreparationStarted?.();
        await preparationGate;
        return {
          sourceConfig: config,
          config: runtimeConfig,
          authStores: [],
          authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
          warnings: [],
          secretOwners: [
            {
              ownerKind: "capability" as const,
              ownerId: "tts",
              refKeys: ["env:default:TTS_THIRD"],
              contractDigest: ttsContractDigest,
            },
          ],
          webTools: createEmptyRuntimeWebToolsMetadata(),
        };
      });
      listener({
        configPath: "/tmp/openclaw.json",
        sourceConfig: sourceConfig(thirdRef),
        runtimeConfig,
        persistedHash: "superseded-source-owner",
        revision: 3,
        fingerprint: "same-runtime",
        sourceFingerprint: "superseded-source-owner",
        writtenAtMs: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);
      await preparationStarted;

      const concurrentSourceConfig = sourceConfig(fourthRef);
      activateSecretsRuntimeSnapshot({
        sourceConfig: concurrentSourceConfig,
        config: runtimeConfig,
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        secretOwners: [
          {
            ownerKind: "capability",
            ownerId: "tts",
            refKeys: ["env:default:TTS_FOURTH"],
          },
        ],
        webTools: createEmptyRuntimeWebToolsMetadata(),
      });
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
    } finally {
      await reloader.stop();
    }
  });

  it("rejects ownerless irreversible plans but applies safe hot plans", async () => {
    vi.useFakeTimers();
    const initialConfig: OpenClawConfig = {
      gateway: {
        port: 18789,
        reload: { debounceMs: 0 },
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
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    let snapshotConfig = initialConfig;
    let snapshotHash = "initial";
    const activateRuntimeSecrets = vi.fn(async (config: OpenClawConfig) => ({
      sourceConfig: config,
      config,
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    }));
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: snapshotConfig,
        sourceConfig: snapshotConfig,
        resolved: snapshotConfig,
        valid: true,
        runtimeConfig: snapshotConfig,
        config: snapshotConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: snapshotHash,
      })) as never,
      promoteSnapshot: promoteSnapshot as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          writeListenerRef.current = null;
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(async () => ({
        restartChannels: new Set<ChannelKind>(),
        activeChannels: new Set<ChannelKind>(),
      })),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      channelManager: {} as never,
      activateRuntimeSecrets: activateRuntimeSecrets as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
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
      listener({
        configPath: "/tmp/openclaw.json",
        sourceConfig: config,
        runtimeConfig: config,
        persistedHash: hash,
        revision,
        fingerprint: `runtime-${hash}`,
        sourceFingerprint: `source-${hash}`,
        writtenAtMs: Date.now(),
      });
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
          label: "health-monitor",
          config: {
            ...initialConfig,
            gateway: { ...initialConfig.gateway, channelHealthCheckMinutes: 10 },
          },
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
        expect(activateRuntimeSecrets).not.toHaveBeenCalled();
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
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const initialConfig = {
      gateway: {
        port: 18789,
        reload: { debounceMs: 0 },
        terminal: { enabled: true },
      },
    } as OpenClawConfig;
    const rejectedConfig = {
      gateway: {
        port: 18790,
        reload: { debounceMs: 0 },
        terminal: { enabled: false },
      },
    } as OpenClawConfig;
    const terminalPolicy = createTerminalLaunchPolicy(initialConfig);
    const expectedReloadError = "config reload failed: Error: restart secrets preflight failed";
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
    const activateRuntimeSecrets = vi.fn(async (config: OpenClawConfig) => {
      if (config.gateway?.port === rejectedConfig.gateway?.port) {
        throw new Error("restart secrets preflight failed");
      }
      return {
        sourceConfig: config,
        config,
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: createEmptyRuntimeWebToolsMetadata(),
      };
    });
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    activateSecretsRuntimeSnapshot({
      sourceConfig: initialConfig,
      config: initialConfig,
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    });
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: initialConfig,
        sourceConfig: initialConfig,
        resolved: initialConfig,
        valid: true,
        runtimeConfig: initialConfig,
        config: initialConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "accepted-revert",
      })) as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      channelManager: {} as never,
      activateRuntimeSecrets: activateRuntimeSecrets as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      prepareTerminalConfig: (plan, nextConfig) => {
        terminalPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
      },
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: terminalPolicy.commitConfig,
      acceptTerminalConfig,
      requestRecoveryRestart,
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    try {
      registeredWriteListener({
        configPath: "/tmp/openclaw.json",
        sourceConfig: rejectedConfig,
        runtimeConfig: rejectedConfig,
        persistedHash: "rejected-restart",
        revision: 1,
        fingerprint: "runtime-rejected-restart",
        sourceFingerprint: "source-rejected-restart",
        writtenAtMs: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);
      await reloadFailed;

      expect(terminalPolicy.isEnabled()).toBe(false);
      expect(logReload.error).toHaveBeenCalledWith(expectedReloadError);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();

      registeredWriteListener({
        configPath: "/tmp/openclaw.json",
        sourceConfig: initialConfig,
        runtimeConfig: initialConfig,
        persistedHash: "accepted-revert",
        revision: 2,
        fingerprint: "runtime-accepted-revert",
        sourceFingerprint: "source-accepted-revert",
        writtenAtMs: Date.now(),
      });
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
    hoisted.activeTaskBlockers.push({
      taskId: "restart-sequence-blocker",
      status: "running",
      runtime: "subagent",
    });

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

      expect(harness.activateRuntimeSecrets).toHaveBeenNthCalledWith(1, harness.deferredConfig, {
        reason: "restart-check",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: expect.any(Function),
      });
      expect(harness.activateRuntimeSecrets).toHaveBeenNthCalledWith(2, harness.invalidConfig, {
        reason: "restart-check",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: expect.any(Function),
      });
      expect(harness.terminalPolicy.isEnabled()).toBe(false);
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
      expect(harness.activateRuntimeSecrets).toHaveBeenNthCalledWith(3, acceptedWithLogging, {
        reason: "reload",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: expect.any(Function),
        includeAuthStoreRefs: undefined,
      });
      expect(harness.activateRuntimeSecrets).toHaveBeenNthCalledWith(4, acceptedWithLogging, {
        reason: "restart-check",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: expect.any(Function),
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
    harness.activateRuntimeSecrets.mockImplementationOnce(async (config: OpenClawConfig) => {
      markPreflightStarted?.();
      await preflightBlocked;
      return {
        sourceConfig: config,
        config,
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: createEmptyRuntimeWebToolsMetadata(),
      };
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
      hoisted.activeTaskBlockers.push({
        taskId: "hot-noop-secret-blocker",
        status: "running",
        runtime: "subagent",
      });

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
      expect(harness.activateRuntimeSecrets).toHaveBeenCalledWith(
        {
          ...resolvedRuntimeConfig,
          gateway: harness.deferredConfig.gateway,
        },
        {
          reason: "restart-check",
          activate: false,
          publishFailureAsDegraded: true,
          canPublishFailureAsDegraded: expect.any(Function),
        },
      );
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
    } finally {
      await harness.reloader.stop();
    }
  });

  it("revalidates deferred restart SecretRefs again before emission and retry", async () => {
    vi.useFakeTimers();
    const harness = createManagedRestartSequenceHarness();
    hoisted.activeTaskBlockers.push({
      taskId: "restart-emission-preflight-blocker",
      status: "running",
      runtime: "subagent",
    });

    try {
      const promotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-emission-preflight", 1);
      await vi.advanceTimersByTimeAsync(0);
      await promotion;

      harness.setSecretUnavailable("RESTART_A_TOKEN");
      hoisted.activeTaskBlockers.length = 0;
      await vi.advanceTimersByTimeAsync(500);
      expect(harness.requestRecoveryRestart).not.toHaveBeenCalled();
      expect(harness.logReload.warn).toHaveBeenCalledWith(
        expect.stringContaining("gateway restart secrets preflight failed"),
      );

      harness.setSecretAvailable("RESTART_A_TOKEN");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.requestRecoveryRestart).toHaveBeenCalledOnce();
      expect(harness.activateRuntimeSecrets).toHaveBeenCalledTimes(3);
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
    const originalActivateRuntimeSecrets = harness.activateRuntimeSecrets.getMockImplementation();
    if (!originalActivateRuntimeSecrets) {
      throw new Error("Expected managed secrets activation implementation");
    }
    let restartCheckCount = 0;
    harness.activateRuntimeSecrets.mockImplementation(async (...args) => {
      const activationParams = args[1] as { reason?: string } | undefined;
      if (activationParams?.reason === "restart-check" && ++restartCheckCount === 2) {
        recordEmissionPreflightStarted?.();
        await emissionPreflightGate;
      }
      return await originalActivateRuntimeSecrets(...args);
    });
    hoisted.activeTaskBlockers.push({
      taskId: "restart-pre-emit-blocker",
      status: "running",
      runtime: "subagent",
    });

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
    hoisted.activeTaskBlockers.push({
      taskId: "restart-sequence-blocker",
      status: "running",
      runtime: "subagent",
    });

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

      expect(harness.activateRuntimeSecrets).toHaveBeenNthCalledWith(3, harness.deferredConfig, {
        reason: "restart-check",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: expect.any(Function),
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
    hoisted.activeTaskBlockers.push({
      taskId: "restart-sequence-blocker",
      status: "running",
      runtime: "subagent",
    });

    try {
      const deferredPromotion = harness.nextPromotion();
      harness.writeConfig(harness.deferredConfig, "deferred-a", 1);
      await vi.advanceTimersByTimeAsync(0);
      await expect(deferredPromotion).resolves.toBe("deferred-a");

      const replacementPromotion = harness.nextPromotion();
      harness.writeConfig(harness.replacementConfig, "replacement-b", 2);
      await vi.advanceTimersByTimeAsync(0);
      await expect(replacementPromotion).resolves.toBe("replacement-b");
      expect(harness.activateRuntimeSecrets).toHaveBeenNthCalledWith(2, harness.replacementConfig, {
        reason: "restart-check",
        activate: false,
        publishFailureAsDegraded: true,
        canPublishFailureAsDegraded: expect.any(Function),
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
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const initialConfig = {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true, token: "test-token", path: "/old" },
    } as OpenClawConfig;
    const nextConfig = {
      gateway: { reload: { debounceMs: 0 } },
      hooks: { enabled: true, token: "test-token", path: "/next" },
    } as OpenClawConfig;
    const initialSnapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: initialConfig,
      config: initialConfig,
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    };
    const refreshedSnapshot: PreparedSecretsRuntimeSnapshot = {
      ...initialSnapshot,
      authStores: [
        {
          agentDir: "/tmp/refreshed-agent",
          store: { version: 1, profiles: {} },
        },
      ],
    };
    activateSecretsRuntimeSnapshot(initialSnapshot);
    const initialSnapshotRevision = getActiveSecretsRuntimeSnapshotRevision();
    const activatePreparedSnapshotIfCurrent = vi.fn(
      async (
        snapshot: PreparedSecretsRuntimeSnapshot,
        expectedRevision: number,
        _params: unknown,
        onActivated?: () => Promise<void>,
      ) => {
        if (getActiveSecretsRuntimeSnapshotRevision() !== expectedRevision) {
          return null;
        }
        activateSecretsRuntimeSnapshot(snapshot);
        await onActivated?.();
        return snapshot;
      },
    );
    let preparationCount = 0;
    const activateRuntimeSecrets = Object.assign(
      vi.fn(async (config: OpenClawConfig) => {
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
        return {
          sourceConfig: config,
          config,
          authStores: [],
          authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
          warnings: [],
          webTools: createEmptyRuntimeWebToolsMetadata(),
        };
      }),
      { activatePreparedSnapshotIfCurrent },
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
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: nextConfig,
        resolved: nextConfig,
        valid: true,
        runtimeConfig: nextConfig,
        config: nextConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "hot-reload-next",
      })) as never,
      promoteSnapshot: promoteSnapshot as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      channelManager: {} as never,
      activateRuntimeSecrets: activateRuntimeSecrets as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig,
      acceptTerminalConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hot-reload-next",
      revision: 1,
      fingerprint: "runtime-hot-reload-next",
      sourceFingerprint: "source-hot-reload-next",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();
    expect(await reloadOutcome).toEqual({ status: "promoted" });

    try {
      expect(activateRuntimeSecrets).toHaveBeenCalledTimes(2);
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
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
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
    const readSnapshot = vi.fn(async () => ({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      sourceConfig: nextConfig,
      resolved: nextConfig,
      valid: true,
      runtimeConfig: nextConfig,
      config: nextConfig,
      issues: [],
      warnings: [],
      legacyIssues: [],
      hash: "hash-next",
    }));
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: readSnapshot as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config,
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {},
      })) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      acceptTerminalConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
    expect(await restartOutcome).toEqual({ status: "started" });
    expect(restartSignal?.aborted).toBe(false);

    await reloader.stop();

    expect(restartSignal?.aborted).toBe(true);
  });

  it("keeps committed config after a Gmail watcher follow-up fails", async () => {
    vi.useFakeTimers();
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const initialConfig = createGmailConfig("old@example.com");
    const nextConfig: OpenClawConfig = {
      ...createGmailConfig("next@example.com"),
      models: { providers: {} },
    };
    const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    activateSecretsRuntimeSnapshot({
      sourceConfig: initialConfig,
      config: initialConfig,
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    });
    hoisted.startGmailWatcherWithLogs.mockRejectedValueOnce(new Error("start failed"));
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: nextConfig,
        resolved: nextConfig,
        valid: true,
        runtimeConfig: nextConfig,
        config: nextConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "hash-next",
      })) as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config,
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: {},
      })) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      acceptTerminalConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledTimes(1);
    expect(hoisted.refreshContextWindowCache).toHaveBeenCalledWith(nextConfig);
    expect(logReload.warn).toHaveBeenCalledWith(
      "gmail watcher reload failed after config commit: start failed; restarting gateway",
    );
    expect(logReload.error).not.toHaveBeenCalled();
    await reloader.stop();
  });

  it("does not start a Gmail restart after the managed reloader stops before hot reload applies", async () => {
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
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
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn(async () => ({
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        sourceConfig: nextConfig,
        resolved: nextConfig,
        valid: true,
        runtimeConfig: nextConfig,
        config: nextConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
        hash: "hash-next",
      })) as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => {
        secretsEntered?.();
        await releaseSecretsPromise;
        return {
          sourceConfig: config,
          config,
          authStores: [],
          authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
          warnings: [],
          webTools: {},
        };
      }) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      acceptTerminalConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }

    registeredWriteListener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hash-next",
      revision: 1,
      fingerprint: "runtime-hash-next",
      sourceFingerprint: "source-hash-next",
      writtenAtMs: Date.now(),
    });
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
        {
          changedPaths: [`env.vars.${envKey}`, "channels.discord.token"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: [`env.vars.${envKey}`, "channels.discord.token"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(["discord"]),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {},
        {
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
    expect(startChannel).toHaveBeenCalledWith("discord");
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
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel,
      stopChannel,
      reloadPlugins: vi.fn(async () => ({
        restartChannels: new Set<ChannelKind>(),
        activeChannels: new Set<ChannelKind>(),
      })),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    try {
      await handlers.applyHotReload(
        {
          changedPaths: [`env.vars.${envKey}`, "channels.discord.token"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: [`env.vars.${envKey}`, "channels.discord.token"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: false,
          restartChannels: new Set(["discord"]),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        nextConfig,
        {
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
    vi.useFakeTimers();
    const envKey = "OPENCLAW_TEST_HOT_RELOAD_SERVICE_ENV";
    const targetEnv: NodeJS.ProcessEnv = { [envKey]: "old" };
    const initialConfig = {
      gateway: { reload: { debounceMs: 0 } },
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
      stopExitWatchers: vi.fn(),
    };
    hoisted.buildGatewayCronService.mockImplementationOnce((params) => {
      events.push(`cron-build:${params?.env?.[envKey]}:${targetEnv[envKey]}`);
      return rebuiltCronState;
    });
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const reloadPlugins = vi.fn(
      async (params: {
        commitRuntime: () => Promise<void>;
        env: NodeJS.ProcessEnv;
      }): Promise<GatewayPluginReloadResult> => {
        events.push(`lookup:${params.env[envKey]}:${targetEnv[envKey]}`);
        await params.commitRuntime();
        events.push(`plugin:${targetEnv[envKey]}`);
        return {
          restartChannels: new Set(["discord"]),
          activeChannels: new Set(["discord"]),
        };
      },
    );
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn() as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          writeListenerRef.current = null;
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {
        events.push(`channel:${targetEnv[envKey]}`);
      }),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config,
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: createEmptyRuntimeWebToolsMetadata(),
      })) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig: vi.fn(),
      acceptTerminalConfig: vi.fn(),
    });
    const listener = writeListenerRef.current;
    if (!listener) {
      throw new Error("Expected config write listener to be registered");
    }

    listener({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      preparedCandidate: { runtimeConfig: nextConfig, compareConfig, runtimeEnv },
      persistedHash: "hot-env",
      revision: 1,
      fingerprint: "runtime-hot-env",
      sourceFingerprint: "source-hot-env",
      writtenAtMs: Date.now(),
    });
    await vi.runAllTimersAsync();

    expect(events).toEqual([
      "cron-build:candidate:old",
      "lookup:candidate:old",
      "cron:candidate",
      "plugin:candidate",
      "channel:candidate",
    ]);
    expect(targetEnv[envKey]).toBe("candidate");
    await reloader.stop();
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
        return { restartChannels: new Set(), activeChannels: new Set() };
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
      {
        changedPaths: ["hooks.path", "plugins.enabled"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["hooks.path", "plugins.enabled"],
        reloadHooks: true,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        reloadPlugins: true,
        restartChannels: new Set(),
        disposeMcpRuntimes: false,
        noopPaths: [],
      },
      { hooks: { enabled: true, token: "token", path: "/next" } },
      {
        isCurrent: () => true,
        publish: async (commit) => {
          events.push("runtime:publish");
          await commit();
        },
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual(["reload:start"]);
    expect(handlers.setState).not.toHaveBeenCalled();

    hoisted.activeEmbeddedRunCount.value = 0;
    await vi.advanceTimersByTimeAsync(500);
    await reload;

    expect(events).toEqual(["reload:start", "stop:discord", "runtime:publish", "registry:replace"]);
    expect(handlers.setState).toHaveBeenCalledTimes(1);
  });

  it("keeps a committed plugin generation when a later channel restart fails", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const reloadPlugins = vi.fn(
      async (params: {
        commitRuntime: () => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        await params.commitRuntime();
        return {
          restartChannels: new Set(["discord"]),
          activeChannels: new Set(["discord"]),
        };
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

    try {
      await expect(
        handlers.applyHotReload(
          {
            changedPaths: ["plugins.enabled"],
            restartGateway: false,
            restartReasons: [],
            hotReasons: ["plugins.enabled"],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: true,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          { plugins: { enabled: true } },
          { publish: async (commit) => await commit(), isCurrent: () => true },
        ),
      ).resolves.toBeUndefined();

      expect(handlers.setState).toHaveBeenCalledTimes(1);
      expect(logReload.warn).toHaveBeenCalledWith(
        "channel restart (discord) failed after config commit; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
  });

  it("restarts instead of rolling back when plugin swap throws after runtime commit", async () => {
    restartTesting.resetSigusr1State();
    resetGatewayWorkAdmission();
    const signalSpy = vi.fn();
    process.once("SIGUSR1", signalSpy);
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

    try {
      await expect(
        handlers.applyHotReload(
          {
            changedPaths: ["plugins.enabled"],
            restartGateway: false,
            restartReasons: [],
            hotReasons: ["plugins.enabled"],
            reloadHooks: false,
            restartGmailWatcher: false,
            restartCron: false,
            restartHeartbeat: false,
            restartHealthMonitor: false,
            reloadPlugins: true,
            restartChannels: new Set(),
            disposeMcpRuntimes: false,
            noopPaths: [],
          },
          { plugins: { enabled: true } },
          { publish, isCurrent: () => true },
        ),
      ).resolves.toBeUndefined();

      expect(publish).toHaveBeenCalledOnce();
      expect(handlers.setState).toHaveBeenCalledTimes(1);
      expect(logReload.warn).toHaveBeenCalledWith(
        "plugin runtime reload failed after config commit: swap failed; restarting gateway",
      );
      expect(signalSpy).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      markGatewaySigusr1RestartHandled();
    } finally {
      process.removeListener("SIGUSR1", signalSpy);
      restartTesting.resetSigusr1State();
      resetGatewayWorkAdmission();
    }
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
          { publish, isCurrent: () => true },
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

  it("restarts pre-stopped channels when runtime publication fails", async () => {
    const events: string[] = [];
    const publish = vi.fn(async () => {
      throw new Error("publication failed");
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
        commitRuntime: () => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        await params.beforeReplace(new Set(["discord"]));
        await params.commitRuntime();
        return { restartChannels: new Set(), activeChannels: new Set(["discord"]) };
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
    );

    await expect(
      handlers.applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { plugins: { enabled: true } },
        { publish, isCurrent: () => true },
      ),
    ).rejects.toThrow("publication failed");

    expect(events).toEqual(["stop:discord", "start:discord"]);
    expect(handlers.setState).not.toHaveBeenCalled();
  });

  it("restarts pre-stopped channels when plugin replacement is cancelled", async () => {
    const events: string[] = [];
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
        isAborted?: () => boolean;
      }): Promise<GatewayPluginReloadResult> => {
        await params.beforeReplace(new Set(["discord"]));
        expect(params.isAborted?.()).toBe(false);
        return { restartChannels: new Set(), activeChannels: new Set(), cancelled: true };
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
    );

    await expect(
      handlers.applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        { plugins: { enabled: true } },
      ),
    ).rejects.toThrow("config hot reload cancelled by config supersession or in-process restart");

    expect(events).toEqual(["stop:discord", "start:discord"]);
    expect(handlers.setState).not.toHaveBeenCalled();
  });

  it("rolls back stopped channels when plugin pre-replace stop fails", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
    const heartbeatRunner = {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    };
    const setState = vi.fn();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const events: string[] = [];
    const startRootCounts: number[] = [];
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
        return {
          restartChannels: new Set(),
          activeChannels: new Set(),
        };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: { cron, storePath: "/tmp/cron.json", cronEnabled: false } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    try {
      await expect(
        root?.run(async () => {
          await applyHotReload(
            {
              changedPaths: ["plugins.enabled"],
              restartGateway: false,
              restartReasons: [],
              hotReasons: ["plugins.enabled"],
              reloadHooks: false,
              restartGmailWatcher: false,
              restartCron: false,
              restartHeartbeat: false,
              restartHealthMonitor: false,
              reloadPlugins: true,
              restartChannels: new Set(),
              disposeMcpRuntimes: false,
              noopPaths: [],
            },
            {
              plugins: {
                enabled: false,
              },
            },
          );
        }),
      ).rejects.toThrow("failed to stop channels before plugin reload: discord");
    } finally {
      root?.release();
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
    expect(startChannel).toHaveBeenCalledWith("telegram");
    expect(startChannel).toHaveBeenCalledWith("discord");
    expect(startRootCounts).toEqual([1, 1]);
    expect(setState).not.toHaveBeenCalled();
  });

  it("stops removed channel plugins from broad activation before swapping plugin runtime", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
    const heartbeatRunner = {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    };
    const setState = vi.fn();
    const startChannel = vi.fn(async () => {});
    const events: string[] = [];
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
        return {
          restartChannels: new Set(),
          activeChannels: new Set(),
        };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: { cron, storePath: "/tmp/cron.json", cronEnabled: false } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    try {
      await applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {
          plugins: {
            enabled: false,
          },
        },
      );
    } finally {
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
    }

    const [reloadParams] = reloadPlugins.mock.calls.at(-1) ?? [];
    const reloadParamsRecord = reloadParams as
      | { nextConfig?: unknown; changedPaths?: unknown }
      | undefined;
    expect(reloadParamsRecord?.nextConfig).toEqual({
      plugins: {
        enabled: false,
      },
    });
    expect(reloadParamsRecord?.changedPaths).toEqual(["plugins.enabled"]);
    expect(stopChannel).toHaveBeenCalledWith("discord", undefined, { manual: false });
    expect(startChannel).not.toHaveBeenCalled();
    expect(events).toEqual(["reload:start", "stop", "registry:replace"]);
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("stops manually started channels before plugin replacement while autostart is suppressed", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
    const heartbeatRunner = {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    };
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
        return {
          restartChannels: new Set(["discord"]),
          activeChannels: new Set(["discord"]),
        };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: { cron, storePath: "/tmp/cron.json", cronEnabled: false } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins,
      getChannelAutostartSuppression: () => ({
        reason: "crash-loop-breaker",
        message: "safe mode",
      }),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    try {
      await applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {
          plugins: {
            enabled: false,
          },
        },
      );
    } finally {
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
  const abortChannelReloadPlan: GatewayReloadPlan = {
    changedPaths: ["channels.whatsapp.enabled"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: ["channels"],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: false,
    restartChannels: new Set(["whatsapp"]),
    disposeMcpRuntimes: false,
    noopPaths: [],
  };

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
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: channels.start,
      stopChannel: channels.stop,
      stopPostReadySidecars: vi.fn(),
      reloadPlugins:
        options?.reloadPlugins ??
        vi.fn(
          async (): Promise<GatewayPluginReloadResult> => ({
            restartChannels: new Set(),
            activeChannels: new Set(),
          }),
        ),
      requestRecoveryRestart: options?.requestRecoveryRestart,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

  const createPluginReloadPlan = (): GatewayReloadPlan => ({
    changedPaths: ["plugins.enabled"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: ["plugins.enabled"],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: true,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    noopPaths: [],
  });

  it("abortPendingChannelReloads cancels a waiting deferred channel reload", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const { applyHotReload } = createTestHandlers(logChannels, channels);

    hoisted.activeTaskBlockers.push({
      taskId: "task-blocking-reload",
      status: "running",
      runtime: "subagent",
    });
    vi.useFakeTimers();

    try {
      const reloadPromise = applyHotReload(abortChannelReloadPlan, {});
      const reloadRejected = expect(reloadPromise).rejects.toThrow(
        "config hot reload cancelled by config supersession or in-process restart",
      );
      await vi.advanceTimersByTimeAsync(10); // enter wait loop (before 500ms sleep)

      abortPendingChannelReloads();
      await vi.advanceTimersByTimeAsync(500); // wake from poll sleep → abort check
      await reloadRejected;

      expect(channels.start).not.toHaveBeenCalled();
      expect(logChannels.info).toHaveBeenCalledWith(
        "channel restart cancelled by config supersession or restart",
      );
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
      return {
        restartChannels: new Set(),
        activeChannels: new Set(),
        cancelled: params.isAborted?.() === true,
      };
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
      return {
        restartChannels: new Set(),
        activeChannels: new Set(),
        cancelled: params.isAborted?.() === true,
      };
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
      return {
        restartChannels: new Set(),
        activeChannels: new Set(),
        cancelled: true,
      };
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

  it("cancels active-work deferral when its config transaction is superseded", async () => {
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const channels = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const { applyHotReload } = createTestHandlers(logChannels, channels);
    hoisted.activeTaskBlockers.push({
      taskId: "task-blocking-superseded-reload",
      status: "running",
      runtime: "subagent",
    });
    let transactionCurrent = true;
    vi.useFakeTimers();

    try {
      const reloadPromise = applyHotReload(
        abortChannelReloadPlan,
        {},
        {
          isCurrent: () => transactionCurrent,
          publish: async (commit) => await commit(),
        },
      );
      const reloadRejected = expect(reloadPromise).rejects.toThrow(
        "config hot reload cancelled by config supersession or in-process restart",
      );
      await vi.advanceTimersByTimeAsync(10);

      transactionCurrent = false;
      await vi.advanceTimersByTimeAsync(500);
      await reloadRejected;

      expect(channels.stop).not.toHaveBeenCalled();
      expect(channels.start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      hoisted.activeTaskBlockers.length = 0;
    }
  });

  it("does not mark a managed reload applied when restart aborts its deferral", async () => {
    const initialConfig = {
      gateway: { reload: { debounceMs: 0 } },
      channels: { whatsapp: { enabled: true, selfChatMode: false } },
    } as OpenClawConfig;
    const nextConfig = {
      gateway: { reload: { debounceMs: 0 } },
      channels: { whatsapp: { enabled: true, selfChatMode: true } },
    } as OpenClawConfig;
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
    const writeListenerRef: { current: ((event: ConfigWriteNotification) => void) | null } = {
      current: null,
    };
    const commitTerminalConfig = vi.fn();
    const promoteSnapshot = vi.fn(async () => true);
    const logReload = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    pinActivePluginChannelRegistry(registry);
    const reloader = startManagedGatewayConfigReloader({
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialInternalWriteHash: null,
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn() as never,
      promoteSnapshot: promoteSnapshot as never,
      subscribeToWrites: ((listener: (event: ConfigWriteNotification) => void) => {
        writeListenerRef.current = listener;
        return () => {
          if (writeListenerRef.current === listener) {
            writeListenerRef.current = null;
          }
        };
      }) as never,
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => {}),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(
        async (): Promise<GatewayPluginReloadResult> => ({
          restartChannels: new Set(),
          activeChannels: new Set(),
        }),
      ),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      channelManager: {} as never,
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
        sourceConfig: config,
        config,
        authStores: [],
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        warnings: [],
        webTools: createEmptyRuntimeWebToolsMetadata(),
      })) as never,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      clients: [],
      reconcileTerminalSessions: vi.fn(),
      commitTerminalConfig,
      acceptTerminalConfig: vi.fn(),
    });
    const registeredWriteListener = writeListenerRef.current;
    if (!registeredWriteListener) {
      throw new Error("Expected config write listener to be registered");
    }
    hoisted.activeTaskBlockers.push({
      taskId: "managed-reload-blocker",
      status: "running",
      runtime: "subagent",
    });
    vi.useFakeTimers();
    let reloaderStopped = false;

    try {
      registeredWriteListener({
        configPath: "/tmp/openclaw.json",
        sourceConfig: nextConfig,
        runtimeConfig: nextConfig,
        persistedHash: "managed-abort-next",
        revision: 1,
        fingerprint: "runtime-managed-abort-next",
        sourceFingerprint: "source-managed-abort-next",
        writtenAtMs: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(10);
      abortPendingChannelReloads();
      await vi.advanceTimersByTimeAsync(500);
      await reloader.stop();
      reloaderStopped = true;

      const expectedError =
        "config reload failed: GatewayHotReloadCancelledError: config hot reload cancelled by config supersession or in-process restart";
      expect(commitTerminalConfig).not.toHaveBeenCalled();
      expect(promoteSnapshot).not.toHaveBeenCalled();
      expect(logReload.error).toHaveBeenCalledWith(expectedError);
    } finally {
      hoisted.activeTaskBlockers.length = 0;
      if (!reloaderStopped) {
        await reloader.stop();
      }
      releasePinnedPluginChannelRegistry(registry);
    }
  });

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

    hoisted.activeTaskBlockers.push({
      taskId: "task-blocking-reload-g2",
      status: "running",
      runtime: "subagent",
    });
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
      await expect(reloadPromise).resolves.toBeUndefined();

      expect(channels.stop).toHaveBeenCalledWith("whatsapp", undefined, { manual: false });
      expect(channels.start).toHaveBeenCalledWith("whatsapp");
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
          return { restartChannels: new Set(), activeChannels: new Set(), cancelled: true };
        }
        return { restartChannels: new Set(), activeChannels: new Set() };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
        } as never,
        channelHealthMonitor: null,
      }),
      setState: vi.fn(),
      startChannel: channels.start,
      stopChannel: channels.stop,
      stopPostReadySidecars: vi.fn(),
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    const pluginReloadPlan: GatewayReloadPlan = {
      changedPaths: ["plugins.enabled"],
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["plugins.enabled"],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      reloadPlugins: true,
      restartChannels: new Set(),
      disposeMcpRuntimes: false,
      noopPaths: [],
    };

    hoisted.activeTaskBlockers.push({
      taskId: "task-blocking-reload",
      status: "running",
      runtime: "subagent",
    });
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
    } finally {
      vi.useRealTimers();
      hoisted.activeTaskBlockers.length = 0;
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
