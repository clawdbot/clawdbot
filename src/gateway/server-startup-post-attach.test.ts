/**
 * Gateway post-attach startup task tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeRestartSentinel } from "../infra/restart-sentinel.js";
import type { PluginHookGatewayContext, PluginHookHandlerMap } from "../plugins/hook-types.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import type { OpenClawPluginServiceContext } from "../plugins/types.js";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import "./server-startup-outcomes.test-support.js";

type PluginHookGatewayStartEvent = Parameters<PluginHookHandlerMap["gateway_start"]>[0];

const hoisted = vi.hoisted(() => {
  const startPluginServices = vi.fn<typeof import("../plugins/services.js").startPluginServices>(
    async () => ({ reload: async () => {}, stop: async () => {} }),
  );
  const startGmailWatcherWithLogs = vi.fn(async () => {});
  const commitInternalHooks = vi.fn(() => true);
  const prepareInternalHooks = vi.fn(async () => ({ loadedCount: 0, commit: commitInternalHooks }));
  const hasInternalHookListeners = vi.fn(() => false);
  const startupHookEvent = { type: "gateway", action: "startup", sessionKey: "gateway:startup" };
  const createInternalHookEvent = vi.fn(() => startupHookEvent);
  const triggerInternalHook = vi.fn(async () => {});
  const updateCheck = {
    initialize: vi.fn(async () => ({
      root: null,
      status: { root: null, installKind: "unknown" as const, packageManager: "unknown" as const },
      installReceipt: null,
    })),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const createGatewayUpdateCheck = vi.fn(() => updateCheck);
  const logGatewayStartup = vi.fn();
  const activateSubagentRegistry = vi.fn();
  const markStartupOrphanedMainSessionsForRecovery = vi.fn(async () => ({
    marked: 0,
    skipped: 0,
  }));
  const scheduleRestartAbortedMainSessionRecovery = vi.fn();
  const scheduleRestartSentinelWake =
    vi.fn<typeof import("./server-restart-sentinel.js").scheduleRestartSentinelWake>();
  const refreshLatestUpdateRestartSentinel = vi.fn<
    typeof import("./server-restart-sentinel.js").refreshLatestUpdateRestartSentinel
  >(async () => null);
  const getAcpRuntimeBackend = vi.fn<(id?: string) => unknown>(() => null);
  const reconcilePendingSessionIdentities = vi.fn(async () => ({
    checked: 0,
    resolved: 0,
    failed: 0,
  }));
  const isCliProvider = vi.fn(() => false);
  const resolveConfiguredModelRef = vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.4",
  }));
  const resolveHooksGmailModel = vi.fn<() => { provider: string; model: string } | null>(
    () => null,
  );
  const loadFullModelCatalog = vi.fn(async () => {
    throw new Error("full model catalog should not materialize");
  });
  const loadModelCatalog = vi.fn(async (_options?: unknown): Promise<unknown> => ({}));
  const getModelRefStatus = vi.fn(() => ({
    key: "openai/gpt-5.4",
    allowed: true,
    inCatalog: true,
  }));
  const prepareModelRuntimeSnapshot = vi.fn(async () => ({}));
  const refreshPreparedModelRuntimeSnapshots = vi.fn(
    async (_cfg?: unknown, _options?: unknown) => {},
  );
  const prewarmConfigDrivenReplyRuntime = vi.fn(async () => {});
  const prewarmContextWindowCacheAfterReady = vi.fn(async () => {});
  const scheduleGatewayHandlerPrewarm = vi.fn(() => ({ stop: vi.fn() }));
  const clearCurrentProviderAuthState = vi.fn();
  const warmCurrentProviderAuthStateOffMainThread = vi.fn(
    async (_cfg?: unknown, _options?: unknown) => {},
  );
  const setAuthProfileFailureHook = vi.fn();
  const transcriptsAutoStartService = {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const createTranscriptsAutoStartService = vi.fn(() => transcriptsAutoStartService);
  return {
    startPluginServices,
    startGmailWatcherWithLogs,
    prepareInternalHooks,
    commitInternalHooks,
    hasInternalHookListeners,
    startupHookEvent,
    createInternalHookEvent,
    triggerInternalHook,
    updateCheck,
    createGatewayUpdateCheck,
    logGatewayStartup,
    activateSubagentRegistry,
    markStartupOrphanedMainSessionsForRecovery,
    scheduleRestartAbortedMainSessionRecovery,
    scheduleRestartSentinelWake,
    refreshLatestUpdateRestartSentinel,
    getAcpRuntimeBackend,
    reconcilePendingSessionIdentities,
    isCliProvider,
    resolveConfiguredModelRef,
    resolveHooksGmailModel,
    loadFullModelCatalog,
    loadModelCatalog,
    getModelRefStatus,
    prepareModelRuntimeSnapshot,
    refreshPreparedModelRuntimeSnapshots,
    prewarmConfigDrivenReplyRuntime,
    prewarmContextWindowCacheAfterReady,
    scheduleGatewayHandlerPrewarm,
    clearCurrentProviderAuthState,
    warmCurrentProviderAuthStateOffMainThread,
    setAuthProfileFailureHook,
    transcriptsAutoStartService,
    createTranscriptsAutoStartService,
  };
});

vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: vi.fn(async () => []),
}));

vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
  activateSubagentRegistry: hoisted.activateSubagentRegistry,
}));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery-marking.js", () => ({
  markStartupOrphanedMainSessionsForRecovery: hoisted.markStartupOrphanedMainSessionsForRecovery,
}));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => ({
  scheduleRestartAbortedMainSessionRecovery: hoisted.scheduleRestartAbortedMainSessionRecovery,
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return {
    ...actual,
    STATE_DIR: "/tmp/openclaw-state",
    resolveConfigPath: vi.fn(() => "/tmp/openclaw-state/openclaw.json"),
    resolveGatewayPort: vi.fn(() => 18789),
    resolveStateDir: vi.fn((env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_STATE_DIR?.trim() ? actual.resolveStateDir(env) : "/tmp/openclaw-state",
    ),
  };
});

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: hoisted.createInternalHookEvent,
  hasInternalHookListeners: hoisted.hasInternalHookListeners,
  triggerInternalHook: hoisted.triggerInternalHook,
}));

vi.mock("../hooks/loader.js", () => ({
  prepareInternalHooks: hoisted.prepareInternalHooks,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../plugins/services.js", () => ({
  startPluginServices: hoisted.startPluginServices,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: vi.fn(() => ({
    reconcilePendingSessionIdentities: hoisted.reconcilePendingSessionIdentities,
  })),
}));

vi.mock("../acp/control-plane/manager.lifecycle.js", () => ({
  disposeAcpSessionManagerInstance: vi.fn(async () => undefined),
}));

vi.mock("../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend: hoisted.getAcpRuntimeBackend,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  refreshLatestUpdateRestartSentinel: hoisted.refreshLatestUpdateRestartSentinel,
  scheduleRestartSentinelWake: hoisted.scheduleRestartSentinelWake,
}));

vi.mock("./server-startup-log.js", () => ({
  logGatewayStartup: hoisted.logGatewayStartup,
}));

vi.mock("../infra/update-startup.js", () => ({
  createGatewayUpdateCheck: hoisted.createGatewayUpdateCheck,
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: hoisted.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: hoisted.getModelRefStatus,
  isCliProvider: hoisted.isCliProvider,
  resolveConfiguredModelRef: hoisted.resolveConfiguredModelRef,
  resolveHooksGmailModel: hoisted.resolveHooksGmailModel,
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: hoisted.prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots: hoisted.refreshPreparedModelRuntimeSnapshots,
}));

vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: vi.fn(),
  prewarmConfigDrivenReplyRuntime: hoisted.prewarmConfigDrivenReplyRuntime,
}));
vi.mock("../agents/context.js", () => ({
  prewarmContextWindowCacheAfterReady: hoisted.prewarmContextWindowCacheAfterReady,
}));

vi.mock("./server-startup-handler-prewarm.js", () => ({
  scheduleGatewayHandlerPrewarm: hoisted.scheduleGatewayHandlerPrewarm,
}));

vi.mock("../agents/model-provider-auth.js", () => ({
  warmCurrentProviderAuthStateOffMainThread: hoisted.warmCurrentProviderAuthStateOffMainThread,
}));

vi.mock("../agents/model-provider-auth-state.js", () => ({
  clearCurrentProviderAuthState: hoisted.clearCurrentProviderAuthState,
}));

vi.mock("../agents/auth-profiles/failure-hook.js", () => ({
  setAuthProfileFailureHook: hoisted.setAuthProfileFailureHook,
}));

vi.mock("../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/auth-profiles.js")>(
    "../agents/auth-profiles.js",
  );
  return {
    ...actual,
    setAuthProfileFailureHook: hoisted.setAuthProfileFailureHook,
  };
});

vi.mock("../agents/tools/transcripts-tool.js", () => ({
  createTranscriptsAutoStartService: hoisted.createTranscriptsAutoStartService,
}));

const {
  startGatewayPostAttachRuntime: startGatewayPostAttachRuntimeImpl,
  startGatewaySidecars: startGatewaySidecarsImpl,
  testing,
} = await import("./server-startup-post-attach.js");
const { scheduleContextCachePrewarm } = await import("./server-startup-context-cache-prewarm.js");
const { STARTUP_UNAVAILABLE_GATEWAY_METHODS } = await import("./methods/core-descriptors.js");

type PostAttachParams = Parameters<typeof startGatewayPostAttachRuntimeImpl>[0];
type PostAttachRuntimeDeps = NonNullable<Parameters<typeof startGatewayPostAttachRuntimeImpl>[1]>;
type UpdateCheckParams = Parameters<PostAttachRuntimeDeps["createGatewayUpdateCheck"]>[0];
type UpdateCheck = Awaited<ReturnType<PostAttachRuntimeDeps["createGatewayUpdateCheck"]>>;
type SidecarPublisher = NonNullable<PostAttachParams["onGatewayLifetimeSidecars"]>;
type SidecarHandle = Parameters<SidecarPublisher>[0][number];
type GatewaySidecarsResult = Awaited<ReturnType<typeof startGatewaySidecarsImpl>>;

const publishedConnectionDependentSidecars = new Set<SidecarHandle>();
const publishedGatewayLifetimeSidecars = new Set<SidecarHandle>();
const publishedPostReadySidecars = new Set<SidecarHandle>();
const transferredSidecars = new Set<SidecarHandle>();

function adoptSidecars(target: Set<SidecarHandle>, sidecars: ReadonlyArray<SidecarHandle>): void {
  for (const sidecar of sidecars) {
    if (!transferredSidecars.has(sidecar)) {
      target.add(sidecar);
    }
  }
}

function composeTrackedPublisher(
  publishedSidecars: Set<SidecarHandle>,
  publisher: SidecarPublisher | undefined,
): SidecarPublisher {
  return (sidecars) => {
    adoptSidecars(publishedSidecars, sidecars);
    return publisher?.(sidecars);
  };
}

function adoptPostReadyResult(result: GatewaySidecarsResult): GatewaySidecarsResult {
  adoptSidecars(publishedPostReadySidecars, result.postReadySidecars);
  return result;
}

async function startGatewaySidecars(
  ...args: Parameters<typeof startGatewaySidecarsImpl>
): Promise<GatewaySidecarsResult> {
  return adoptPostReadyResult(await startGatewaySidecarsImpl(...args));
}

function transferBeforeStop(sidecar: SidecarHandle): void {
  publishedConnectionDependentSidecars.delete(sidecar);
  publishedGatewayLifetimeSidecars.delete(sidecar);
  publishedPostReadySidecars.delete(sidecar);
  transferredSidecars.add(sidecar);
}

async function stopTrackedSidecar(sidecar: SidecarHandle): Promise<void> {
  transferBeforeStop(sidecar);
  await sidecar.stop();
}

async function stopTrackedSidecars(sidecars: Set<SidecarHandle>): Promise<void> {
  const stopping = [...sidecars];
  const results = await Promise.allSettled(stopping.map(async (sidecar) => await sidecar.stop()));
  results.forEach((result, index) => {
    const sidecar = stopping[index];
    if (sidecar && result.status === "fulfilled") {
      transferBeforeStop(sidecar);
    }
  });
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
}

async function cleanupGatewayTestState(): Promise<void> {
  let firstError: Error | undefined;
  const cleanup = async (run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      firstError ??= error instanceof Error ? error : new Error(String(error));
    }
  };

  const sidecars = new Set([
    ...publishedConnectionDependentSidecars,
    ...publishedGatewayLifetimeSidecars,
    ...publishedPostReadySidecars,
  ]);
  for (const sidecar of sidecars) {
    transferBeforeStop(sidecar);
    await cleanup(() => sidecar.stop());
  }

  publishedConnectionDependentSidecars.clear();
  publishedGatewayLifetimeSidecars.clear();
  publishedPostReadySidecars.clear();
  transferredSidecars.clear();
  await cleanup(() => resetGatewayWorkAdmission());
  await cleanup(() => closeOpenClawStateDatabaseForTest());
  await cleanup(() => {
    vi.useRealTimers();
  });
  await cleanup(() => {
    vi.unstubAllEnvs();
  });

  if (firstError !== undefined) {
    throw firstError;
  }
}

function startGatewayPostAttachRuntime(
  params: PostAttachParams,
  runtimeDeps?: PostAttachRuntimeDeps,
) {
  return startGatewayPostAttachRuntimeImpl(
    {
      ...params,
      onGatewayLifetimeSidecars: composeTrackedPublisher(
        publishedGatewayLifetimeSidecars,
        params.onGatewayLifetimeSidecars,
      ),
      onPostReadySidecars: composeTrackedPublisher(
        publishedPostReadySidecars,
        params.onPostReadySidecars,
      ),
    },
    runtimeDeps,
  );
}
async function waitForGatewayTestState<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return await vi.waitFor(assertion, { ...options, interval: 1 });
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
  const call = mock.mock.calls.at(index);
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[argIndex];
}

function firstStartupLog(): { loadedPluginIds?: string[] } {
  return mockCallArg(hoisted.logGatewayStartup) as { loadedPluginIds?: string[] };
}

function createStartupMethodUnlocker(unavailableGatewayMethods: Set<string>): () => void {
  return () => {
    for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
      unavailableGatewayMethods.delete(method);
    }
  };
}

function createStartupTraceRecorder() {
  const details: Array<{
    name: string;
    metrics: ReadonlyArray<readonly [string, number | string]>;
  }> = [];
  const marks: string[] = [];
  const measures: string[] = [];
  return {
    details,
    marks,
    measures,
    startupTrace: {
      detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => {
        details.push({ name, metrics });
      },
      mark: (name: string) => {
        marks.push(name);
      },
      measure: async <T>(name: string, run: () => T | Promise<T>) => {
        measures.push(name);
        return await run();
      },
    },
  };
}

function firstGatewayStartCall(
  runGatewayStart: ReturnType<typeof vi.fn>,
): [PluginHookGatewayStartEvent, PluginHookGatewayContext] {
  const call = runGatewayStart.mock.calls[0];
  if (!call) {
    throw new Error("gateway_start was not invoked");
  }
  return call as [PluginHookGatewayStartEvent, PluginHookGatewayContext];
}

describe("startGatewayPostAttachRuntime", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    closeOpenClawStateDatabaseForTest();
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "0");
    vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", "0");
    hoisted.startPluginServices.mockClear();
    hoisted.startGmailWatcherWithLogs.mockClear();
    hoisted.prepareInternalHooks.mockClear();
    hoisted.commitInternalHooks.mockClear();
    hoisted.hasInternalHookListeners.mockReset();
    hoisted.hasInternalHookListeners.mockReturnValue(false);
    hoisted.createInternalHookEvent.mockClear();
    hoisted.triggerInternalHook.mockClear();
    hoisted.createGatewayUpdateCheck.mockClear();
    hoisted.updateCheck.initialize.mockClear();
    hoisted.updateCheck.start.mockClear();
    hoisted.updateCheck.stop.mockClear();
    hoisted.logGatewayStartup.mockClear();
    hoisted.activateSubagentRegistry.mockClear();
    hoisted.markStartupOrphanedMainSessionsForRecovery.mockReset();
    hoisted.markStartupOrphanedMainSessionsForRecovery.mockResolvedValue({
      marked: 0,
      skipped: 0,
    });
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockClear();
    hoisted.scheduleRestartSentinelWake.mockClear();
    hoisted.refreshLatestUpdateRestartSentinel.mockReset();
    hoisted.refreshLatestUpdateRestartSentinel.mockResolvedValue(null);
    hoisted.getAcpRuntimeBackend.mockReset();
    hoisted.getAcpRuntimeBackend.mockReturnValue(null);
    hoisted.reconcilePendingSessionIdentities.mockClear();
    hoisted.isCliProvider.mockReset();
    hoisted.isCliProvider.mockReturnValue(false);
    hoisted.resolveConfiguredModelRef.mockClear();
    hoisted.resolveHooksGmailModel.mockReset();
    hoisted.resolveHooksGmailModel.mockReturnValue(null);
    hoisted.loadFullModelCatalog.mockClear();
    hoisted.loadModelCatalog.mockReset();
    hoisted.loadModelCatalog.mockResolvedValue({});
    hoisted.getModelRefStatus.mockReset();
    hoisted.getModelRefStatus.mockReturnValue({
      key: "openai/gpt-5.4",
      allowed: true,
      inCatalog: true,
    });
    hoisted.prepareModelRuntimeSnapshot.mockReset();
    hoisted.prepareModelRuntimeSnapshot.mockResolvedValue({});
    hoisted.refreshPreparedModelRuntimeSnapshots.mockReset();
    hoisted.refreshPreparedModelRuntimeSnapshots.mockResolvedValue(undefined);
    hoisted.prewarmConfigDrivenReplyRuntime.mockReset();
    hoisted.prewarmConfigDrivenReplyRuntime.mockResolvedValue(undefined);
    hoisted.prewarmContextWindowCacheAfterReady.mockReset();
    hoisted.prewarmContextWindowCacheAfterReady.mockResolvedValue(undefined);
    hoisted.scheduleGatewayHandlerPrewarm.mockClear();
    hoisted.clearCurrentProviderAuthState.mockClear();
    hoisted.warmCurrentProviderAuthStateOffMainThread.mockReset();
    hoisted.warmCurrentProviderAuthStateOffMainThread.mockResolvedValue(undefined);
    hoisted.setAuthProfileFailureHook.mockClear();
    hoisted.transcriptsAutoStartService.start.mockClear();
    hoisted.transcriptsAutoStartService.stop.mockClear();
    hoisted.transcriptsAutoStartService.stop.mockResolvedValue(undefined);
    hoisted.createTranscriptsAutoStartService.mockClear();
  });

  afterEach(async () => {
    await cleanupGatewayTestState();
  });

  it("drains tracked sidecars and resets fixture state after the first cleanup failure", async () => {
    const firstError = new Error("first cleanup failure");
    const stopOrder: string[] = [];
    const firstLifetimeSidecar = {
      stop: vi.fn(async () => {
        stopOrder.push("lifetime:first");
        throw firstError;
      }),
    };
    const secondLifetimeSidecar = {
      stop: vi.fn(async () => {
        stopOrder.push("lifetime:second");
      }),
    };
    const postReadySidecar = {
      stop: vi.fn(async () => {
        stopOrder.push("post-ready");
      }),
    };
    const originalCleanupEnv = process.env.OPENCLAW_CLEANUP_TEST;

    adoptSidecars(publishedGatewayLifetimeSidecars, [firstLifetimeSidecar, secondLifetimeSidecar]);
    adoptSidecars(publishedPostReadySidecars, [postReadySidecar]);
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_CLEANUP_TEST", "dirty");
    expect(tryBeginGatewayRootWorkAdmission()).not.toBeNull();

    await expect(cleanupGatewayTestState()).rejects.toBe(firstError);

    expect(stopOrder).toEqual(["lifetime:first", "lifetime:second", "post-ready"]);
    expect(publishedGatewayLifetimeSidecars.size).toBe(0);
    expect(publishedPostReadySidecars.size).toBe(0);
    expect(transferredSidecars.size).toBe(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(vi.isFakeTimers()).toBe(false);
    expect(process.env.OPENCLAW_CLEANUP_TEST).toBe(originalCleanupEnv);
  });

  it("re-enables startup-gated methods after post-attach sidecars start", async () => {
    const unavailableGatewayMethods = new Set<string>(["chat.history", "models.list"]);
    const startupOrder: string[] = [];
    const methodsAtRecoveryRegistration: string[][] = [];
    const currentConfig = { agents: { list: [{ id: "main" }, { id: "work" }] } };
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockImplementationOnce(
      (params: { getConfig: () => unknown }) => {
        methodsAtRecoveryRegistration.push([...unavailableGatewayMethods]);
        expect(params.getConfig()).toBe(currentConfig);
      },
    );
    const onSidecarsReady = vi.fn(() => startupOrder.push("ready"));
    hoisted.activateSubagentRegistry.mockImplementationOnce(() => {
      startupOrder.push("registry");
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      getConfig: () => currentConfig,
      log,
      unlockStartupMethods: () => {
        startupOrder.push("unlock");
        createStartupMethodUnlocker(unavailableGatewayMethods)();
      },
      onSidecarsReady,
    });

    await waitForGatewayTestState(() => {
      expect(onSidecarsReady).toHaveBeenCalledTimes(1);
    });
    expect([...unavailableGatewayMethods]).toStrictEqual([]);
    expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
    expect(hoisted.prepareInternalHooks).toHaveBeenCalledWith(
      { hooks: { internal: { enabled: false } } },
      "/tmp/openclaw-workspace",
      { failureMode: "best-effort" },
    );
    expect(hoisted.commitInternalHooks).toHaveBeenCalledWith({ initial: true });
    expect(hoisted.logGatewayStartup).toHaveBeenCalledTimes(1);
    expect(firstStartupLog().loadedPluginIds).toEqual(["beta", "alpha"]);
    expect(hoisted.logGatewayStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: { hooks: { internal: { enabled: false } } },
      }),
    );
    expect(log.info).toHaveBeenCalledWith("gateway ready");
    expect(hoisted.scheduleRestartAbortedMainSessionRecovery).toHaveBeenCalledWith({
      delayMs: 0,
      getConfig: expect.any(Function),
      shouldContinue: expect.any(Function),
      startupCheckedStorePaths: expect.any(Set),
      waitForStart: undefined,
      gatewayRuntime: expect.any(Object),
    });
    expect(hoisted.activateSubagentRegistry).toHaveBeenCalledWith(expect.any(Function));
    expect(startupOrder).toEqual(["unlock", "ready", "registry"]);
    expect(methodsAtRecoveryRegistration).toStrictEqual([["chat.history", "models.list"]]);
  });

  it("fences startup recovery as soon as its gateway close prelude begins", async () => {
    let closing = false;
    const recoveryAllowed: (boolean | undefined)[] = [];
    const recoverySidecar = { stop: vi.fn(async () => {}) };
    const onGatewayLifetimeSidecars = vi.fn();
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockImplementationOnce(
      (params: { shouldContinue?: () => boolean }) => {
        recoveryAllowed.push(params.shouldContinue?.());
        closing = true;
        recoveryAllowed.push(params.shouldContinue?.());
        return recoverySidecar;
      },
    );

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      isClosing: () => closing,
      onGatewayLifetimeSidecars,
    });

    expect(hoisted.scheduleRestartAbortedMainSessionRecovery).toHaveBeenCalledOnce();
    expect(recoveryAllowed).toEqual([true, false]);
    expect(onGatewayLifetimeSidecars).toHaveBeenCalledWith([recoverySidecar]);
    expect(publishedGatewayLifetimeSidecars.has(recoverySidecar)).toBe(true);
    expect(recoverySidecar.stop).not.toHaveBeenCalled();
    await stopTrackedSidecars(publishedGatewayLifetimeSidecars);
    expect(recoverySidecar.stop).toHaveBeenCalledOnce();
    expect(publishedGatewayLifetimeSidecars.has(recoverySidecar)).toBe(false);
  });

  it("gates main-session recovery behind post-ready work", async () => {
    let releasePostReadyWork!: () => void;
    const postReadyWork = new Promise<void>((resolve) => {
      releasePostReadyWork = resolve;
    });
    let waitForStart: (() => Promise<void>) | undefined;
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockImplementationOnce(
      (params: { waitForStart?: () => Promise<void> }) => {
        waitForStart = params.waitForStart;
        return { stop: vi.fn(async () => {}) };
      },
    );

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      waitForPostReadyWork: () => postReadyWork,
    });

    await waitForGatewayTestState(() => {
      expect(waitForStart).toEqual(expect.any(Function));
    });
    let released = false;
    const waiting = waitForStart?.().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    releasePostReadyWork();
    await waiting;
    expect(released).toBe(true);
  });

  it("stops restart recovery with gateway-lifetime sidecars", async () => {
    const recoverySidecar = { stop: vi.fn() };
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockReturnValueOnce(recoverySidecar);
    const onGatewayLifetimeSidecars = vi.fn();

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      onGatewayLifetimeSidecars,
    });

    await waitForGatewayTestState(() => {
      expect(onGatewayLifetimeSidecars).toHaveBeenCalledWith(
        expect.arrayContaining([recoverySidecar]),
      );
    });
    const lifetimeSidecars = [...publishedGatewayLifetimeSidecars];
    expect(lifetimeSidecars).toContain(recoverySidecar);

    for (const sidecar of lifetimeSidecars) {
      await stopTrackedSidecar(sidecar);
    }
    expect(recoverySidecar.stop).toHaveBeenCalledOnce();
  });

  it("logs one startup outcome summary after sidecar registration and before readiness", async () => {
    const events: string[] = [];
    const outcomeMessages: string[] = [];
    const log = {
      info: vi.fn((message: string) => {
        if (message.startsWith("gateway startup outcomes:")) {
          outcomeMessages.push(message);
          events.push("outcomes");
        } else if (message === "gateway ready") {
          events.push("ready-log");
        }
      }),
      warn: vi.fn(),
    };

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      log,
      onPostReadySidecars: () => {
        events.push("post-ready-registered");
      },
      onGatewayLifetimeSidecars: () => {
        events.push("lifetime-registered");
      },
      onSidecarsReady: () => {
        events.push("sidecars-ready");
      },
    });

    expect(outcomeMessages).toHaveLength(1);
    expect(outcomeMessages[0]).toBe(
      "gateway startup outcomes: internal-hooks=skipped (hooks-disabled); " +
        "internal-startup-hook=skipped (hooks-disabled); " +
        "gateway-start-hooks=skipped (no-handlers-loaded); " +
        "gmail-watcher=skipped (hooks-disabled); gmail-model=skipped (not-configured)",
    );
    expect(events).toEqual([
      "lifetime-registered",
      "post-ready-registered",
      "lifetime-registered",
      "outcomes",
      "sidecars-ready",
      "ready-log",
    ]);
  });

  it("reports internal hook load failures without copying the error into the summary", async () => {
    const log = { info: vi.fn<(message: string) => void>(), warn: vi.fn() };
    const logHooks = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    hoisted.prepareInternalHooks.mockRejectedValueOnce(new Error("private hook path"));

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      log,
      logHooks,
      gatewayPluginConfigAtStart: { hooks: { internal: { enabled: true } } } as never,
    });

    expect(logHooks.error).toHaveBeenCalledWith("failed to load hooks: Error: private hook path");
    const outcomeMessage = log.info.mock.calls
      .map(([message]) => message)
      .find((message) => message.startsWith("gateway startup outcomes:"));
    expect(outcomeMessage).toContain("internal-hooks=failed (see earlier log)");
    expect(outcomeMessage).not.toContain("private hook path");
  });

  it("does not publish an imported hook candidate after Gateway close starts", async () => {
    const loading = createDeferred<{
      loadedCount: number;
      commit: typeof hoisted.commitInternalHooks;
    }>();
    let closing = false;
    hoisted.prepareInternalHooks.mockReturnValueOnce(loading.promise);
    const params = createPostAttachParams();
    const starting = startGatewaySidecars({
      cfg: { hooks: { internal: { enabled: true } } },
      pluginRegistry: params.pluginRegistry,
      defaultWorkspaceDir: params.defaultWorkspaceDir,
      deps: params.deps,
      startChannels: params.startChannels,
      shouldStartChannels: () => !closing,
      shouldCreatePostReadySidecars: () => !closing,
      shouldStartPluginServices: () => !closing,
      log: params.log,
      logHooks: params.logHooks,
      logChannels: params.logChannels,
    });
    await waitForGatewayTestState(() => {
      expect(hoisted.prepareInternalHooks).toHaveBeenCalledOnce();
    });
    closing = true;
    loading.resolve({ loadedCount: 1, commit: hoisted.commitInternalHooks });
    await starting;
    expect(hoisted.commitInternalHooks).not.toHaveBeenCalled();
    expect(params.startChannels).not.toHaveBeenCalled();
  });

  it("refreshes the restart sentinel after sidecars without blocking post-attach", async () => {
    const events: string[] = [];
    const refreshLatestUpdateRestartSentinel = vi.fn(async () => {
      events.push("sentinel");
      return null;
    });
    const startGatewaySidecarsInner = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        refreshLatestUpdateRestartSentinel,
        startGatewaySidecars: startGatewaySidecarsInner,
      }),
    );

    events.push("returned");
    expect(refreshLatestUpdateRestartSentinel).not.toHaveBeenCalled();

    await waitForGatewayTestState(() => {
      expect(refreshLatestUpdateRestartSentinel).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(["sidecars", "returned", "sentinel"]);
  });

  it("keeps delayed restart sentinel recovery admitted until wake work completes", async () => {
    vi.useFakeTimers();
    let finishWake: (() => void) | undefined;
    const wake = new Promise<void>((resolve) => {
      finishWake = resolve;
    });
    hoisted.scheduleRestartSentinelWake.mockReturnValueOnce(wake);

    const sidecar = testing.scheduleRestartSentinelWakeAfterReady({
      deps: {} as never,
      log: { warn: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(750);

    expect(hoisted.scheduleRestartSentinelWake).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    finishWake?.();
    await waitForGatewayTestState(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    await stopTrackedSidecar(sidecar);
  });

  it("cancels delayed restart sentinel recovery when the gateway closes", async () => {
    vi.useFakeTimers();
    const sidecar = testing.scheduleRestartSentinelWakeAfterReady({
      deps: {} as never,
      log: { warn: vi.fn() },
    });

    await stopTrackedSidecar(sidecar);
    await vi.advanceTimersByTimeAsync(750);

    expect(hoisted.scheduleRestartSentinelWake).not.toHaveBeenCalled();
  });

  it("starts sidecars while startup logging is pending and waits for both", async () => {
    const events: string[] = [];
    let finishStartupLog: (() => void) | undefined;
    const logGatewayStartup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("startup-log-start");
          finishStartupLog = () => {
            events.push("startup-log-end");
            resolve();
          };
        }),
    );
    const startGatewaySidecarsScoped = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    const runtimePromise = startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        logGatewayStartup,
        refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
        startGatewaySidecars: startGatewaySidecarsScoped,
      }),
    );

    await waitForGatewayTestState(() => {
      expect(logGatewayStartup).toHaveBeenCalledTimes(1);
      expect(startGatewaySidecarsScoped).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(["startup-log-start", "sidecars"]);

    let startupSettled = false;
    void runtimePromise.then(() => {
      startupSettled = true;
    });
    await Promise.resolve();
    expect(startupSettled).toBe(false);

    if (!finishStartupLog) {
      throw new Error("Expected startup log release callback to be initialized");
    }
    finishStartupLog();
    await runtimePromise;

    expect(events).toEqual(["startup-log-start", "sidecars", "startup-log-end"]);
  });

  it.each(["logging", "sidecars"] as const)(
    "rejects deferred startup when %s fails but joins its pending peer",
    async (failedOwner) => {
      const startupError = new Error(`startup ${failedOwner} failed`);
      const logging = createDeferred();
      const sidecars = createDeferred<{ pluginServices: null; postReadySidecars: [] }>();
      const loggingStarted = createDeferred();
      const sidecarsStarted = createDeferred();
      const completed: string[] = [];
      const logged = logging.promise.then(() => {
        completed.push("logging");
      });
      const sidecarsCompleted = sidecars.promise.then((result) => {
        completed.push("sidecars");
        return result;
      });
      const logGatewayStartup = vi.fn(() => {
        expect(getAsyncWorkSignal()).toBeUndefined();
        loggingStarted.resolve();
        return logged;
      });
      const startGatewaySidecarsScoped = vi.fn(() => {
        expect(getAsyncWorkSignal()).toBeUndefined();
        sidecarsStarted.resolve();
        return sidecarsCompleted;
      });
      const lifetime = new AsyncWorkScope();
      const trackStartupWork: PostAttachParams["trackStartupWork"] = (run) => {
        const operation = Promise.resolve().then(() => run(lifetime.signal));
        return lifetime.track(() => operation);
      };
      const release = () => {
        logging.resolve();
        sidecars.resolve({ pluginServices: null, postReadySidecars: [] });
      };
      const runtime = await trackStartupWork(() =>
        startGatewayPostAttachRuntime(
          createPostAttachParams({ sidecarStartup: "defer", trackStartupWork }),
          createPostAttachRuntimeDeps({
            logGatewayStartup,
            startGatewaySidecars: startGatewaySidecarsScoped,
          }),
        ),
      );

      try {
        await Promise.all([loggingStarted.promise, sidecarsStarted.promise]);
        if (failedOwner === "logging") {
          logging.reject(startupError);
        } else {
          sidecars.reject(startupError);
        }

        await expect(runtime.startupSettled).rejects.toBe(startupError);
        expect(completed).toEqual([]);
        const closed = vi.fn();
        const closing = lifetime.drain().then(closed);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(closed).not.toHaveBeenCalled();
        release();
        await closing;
        expect(completed).toEqual([failedOwner === "logging" ? "sidecars" : "logging"]);
        expect(closed).toHaveBeenCalledOnce();
      } finally {
        release();
        await Promise.allSettled([logged, sidecarsCompleted]);
        await lifetime.drain();
      }
    },
  );

  it("uses the current runtime config for deferred model publication", async () => {
    const startupConfig = { hooks: { internal: { enabled: false } } } as never;
    const currentConfig = {
      hooks: { internal: { enabled: false } },
      ui: { theme: "dark" },
    } as never;
    const startGatewaySidecarsScoped = vi.fn(
      async (_params: Parameters<typeof startGatewaySidecarsImpl>[0]) => ({
        pluginServices: null,
        postReadySidecars: [],
      }),
    );
    const runtime = await startGatewayPostAttachRuntime(
      createPostAttachParams({
        sidecarStartup: "defer",
        gatewayPluginConfigAtStart: startupConfig,
        getConfig: () => currentConfig,
      }),
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsScoped }),
    );

    await runtime.startupSettled;

    expect(startGatewaySidecarsScoped).toHaveBeenCalledWith(
      expect.objectContaining({ getModelRuntimeConfig: expect.any(Function) }),
    );
    const sidecarParams = startGatewaySidecarsScoped.mock.calls[0]?.[0] as
      | { getModelRuntimeConfig?: () => unknown }
      | undefined;
    expect(sidecarParams?.getModelRuntimeConfig?.()).toBe(currentConfig);
  });

  it("retains a sidecar whose cleanup fails after startup logging rejects", async () => {
    const startupError = new Error("startup logging failed");
    const cleanupError = new Error("sidecar cleanup failed");
    const postReadySidecar = {
      stop: vi.fn().mockRejectedValueOnce(cleanupError).mockResolvedValue(undefined),
    };
    const onPostReadySidecars = vi.fn();
    const runtime = await startGatewayPostAttachRuntime(
      createPostAttachParams({ sidecarStartup: "defer", onPostReadySidecars }),
      createPostAttachRuntimeDeps({
        logGatewayStartup: vi.fn().mockRejectedValue(startupError),
        startGatewaySidecars: vi.fn(
          async (params: Parameters<typeof startGatewaySidecarsImpl>[0]) => {
            params.onPostReadySidecars?.([postReadySidecar]);
            return { pluginServices: null, postReadySidecars: [postReadySidecar] };
          },
        ),
      }),
    );

    await expect(runtime.startupSettled).rejects.toBe(startupError);
    await waitForGatewayTestState(() => {
      expect(onPostReadySidecars).toHaveBeenCalledWith([postReadySidecar]);
    });
    expect(postReadySidecar.stop).not.toHaveBeenCalled();
    await expect(stopTrackedSidecars(publishedPostReadySidecars)).rejects.toBe(cleanupError);
    expect(publishedPostReadySidecars.has(postReadySidecar)).toBe(true);

    await cleanupGatewayTestState();
    expect(postReadySidecar.stop).toHaveBeenCalledTimes(2);
  });

  it("starts the gateway update check after post-attach returns", async () => {
    const events: string[] = [];
    const updateCheck = {
      initialize: vi.fn(async () => {
        events.push("install-identity");
        return await hoisted.updateCheck.initialize();
      }),
      start: vi.fn(() => events.push("update-check")),
      stop: vi.fn(async () => {}),
    };
    const startGatewaySidecarsItem = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        createGatewayUpdateCheck: () => updateCheck,
        refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
        startGatewaySidecars: startGatewaySidecarsItem,
      }),
    );
    events.push("returned");

    expect(updateCheck.initialize).toHaveBeenCalledTimes(1);
    expect(updateCheck.start).not.toHaveBeenCalled();
    expect(events).toEqual(["sidecars", "install-identity", "returned"]);

    await waitForGatewayTestState(() => {
      expect(updateCheck.start).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(["sidecars", "install-identity", "returned", "update-check"]);

    await result.stopGatewayUpdateCheck();
    expect(updateCheck.stop).toHaveBeenCalledTimes(1);
  });

  it("scopes detailed update broadcasts to read-capable operator clients", async () => {
    const clients = [
      {
        connId: "pairing",
        connect: { role: "operator", scopes: ["operator.pairing"] },
      },
      { connId: "node", connect: { role: "node", scopes: ["node.read"] } },
      {
        connId: "operator-read",
        connect: { role: "operator", scopes: ["operator.read"] },
      },
    ];
    const broadcastToConnIds = vi.fn();
    const getClientConnIds: PostAttachParams["getClientConnIds"] = (filter) =>
      new Set(
        clients
          .filter((client) => !filter || filter(client as never))
          .map((client) => client.connId),
      );
    const createGatewayUpdateCheck = vi.fn(() => hoisted.updateCheck);

    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams({ broadcastToConnIds, getClientConnIds }),
      createPostAttachRuntimeDeps({ createGatewayUpdateCheck }),
    );
    await waitForGatewayTestState(() => {
      expect(createGatewayUpdateCheck).toHaveBeenCalledTimes(1);
    });

    const updateCheckParams = mockCallArg(createGatewayUpdateCheck) as UpdateCheckParams;
    const updateAvailable = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev" as const,
      currentSha: "1111111111111111111111111111111111111111",
      upstreamRef: "origin/main",
      upstreamSha: "2222222222222222222222222222222222222222",
      commitsBehind: 1,
      commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
    };
    const schedule = {
      channel: "dev" as const,
      autoEnabled: true,
      install: { kind: "git" as const },
      target: {
        kind: "git" as const,
        currentSha: updateAvailable.currentSha,
        upstreamRef: updateAvailable.upstreamRef,
        upstreamSha: updateAvailable.upstreamSha,
        commitsBehind: updateAvailable.commitsBehind,
        commits: updateAvailable.commits,
      },
    };

    updateCheckParams.onUpdateAvailableChange?.(updateAvailable);
    updateCheckParams.onUpdateScheduleChange?.(schedule);

    expect(broadcastToConnIds.mock.calls).toEqual([
      ["update.available", { updateAvailable }, new Set(["operator-read"]), { dropIfSlow: true }],
      [
        "update.available",
        {
          updateAvailable: {
            currentVersion: updateAvailable.currentVersion,
            latestVersion: updateAvailable.latestVersion,
            channel: updateAvailable.channel,
          },
        },
        new Set(["pairing", "node"]),
        { dropIfSlow: true },
      ],
      [
        "update.available",
        { updateAvailable, schedule },
        new Set(["operator-read"]),
        { dropIfSlow: true },
      ],
      [
        "update.available",
        {
          updateAvailable: {
            currentVersion: updateAvailable.currentVersion,
            latestVersion: updateAvailable.latestVersion,
            channel: updateAvailable.channel,
          },
        },
        new Set(["pairing", "node"]),
        { dropIfSlow: true },
      ],
    ]);
    await result.stopGatewayUpdateCheck();
    broadcastToConnIds.mockClear();
    updateCheckParams.onUpdateAvailableChange?.(updateAvailable);
    updateCheckParams.onUpdateScheduleChange?.(schedule);
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("joins a late update-check factory and its cleanup when close wins startup", async () => {
    const factory = createDeferred<UpdateCheck>();
    const cleanup = createDeferred();
    const updateCheck = {
      initialize: vi.fn(hoisted.updateCheck.initialize),
      start: vi.fn(),
      stop: vi.fn(() => cleanup.promise),
    };
    const createGatewayUpdateCheck = vi.fn(() => factory.promise);

    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
        createGatewayUpdateCheck,
      }),
    );

    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      await waitForGatewayTestState(() => {
        expect(createGatewayUpdateCheck).toHaveBeenCalledTimes(1);
      });
      stopping = result.stopGatewayUpdateCheck().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(updateCheck.stop).not.toHaveBeenCalled();
      factory.resolve(updateCheck);
      await waitForGatewayTestState(() => expect(updateCheck.stop).toHaveBeenCalledOnce());
      expect(stopped).toBe(false);
      expect(updateCheck.initialize).not.toHaveBeenCalled();
      expect(updateCheck.start).not.toHaveBeenCalled();
    } finally {
      factory.resolve(updateCheck);
      cleanup.resolve();
      await (stopping ?? result.stopGatewayUpdateCheck());
    }
    await result.stopGatewayUpdateCheck();
    expect(updateCheck.stop).toHaveBeenCalledOnce();
  });

  it("fences update discovery immediately and joins its pending initialization", async () => {
    const initialization = createDeferred<Awaited<ReturnType<UpdateCheck["initialize"]>>>();
    const cleanup = createDeferred();
    const updateCheck = {
      initialize: vi.fn(() => initialization.promise),
      start: vi.fn(),
      stop: vi.fn(() => cleanup.promise),
    };
    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({ createGatewayUpdateCheck: () => updateCheck }),
    );
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      expect(updateCheck.initialize).toHaveBeenCalledOnce();
      stopping = result.stopGatewayUpdateCheck().then(() => {
        stopped = true;
      });
      expect(updateCheck.stop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBe(false);
      expect(updateCheck.start).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      initialization.resolve(await hoisted.updateCheck.initialize());
      await (stopping ?? result.stopGatewayUpdateCheck());
    }
  });

  it("drains update discovery without waiting for post-ready work that never starts", async () => {
    const postReadyWork = createDeferred();
    const updateCheck = {
      initialize: vi.fn(hoisted.updateCheck.initialize),
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams({ waitForPostReadyWork: () => postReadyWork.promise }),
      createPostAttachRuntimeDeps({ createGatewayUpdateCheck: () => updateCheck }),
    );
    let stopped = false;
    const stopping = result.stopGatewayUpdateCheck().then(() => {
      stopped = true;
    });
    try {
      await waitForGatewayTestState(() => expect(stopped).toBe(true));
      expect(updateCheck.stop).toHaveBeenCalledOnce();
    } finally {
      postReadyWork.resolve();
      await stopping;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(updateCheck.start).not.toHaveBeenCalled();
  });

  it("publishes update-check cleanup ownership before deferred startup can fail", async () => {
    const sidecarsReady = createDeferred();
    const cleanup = createDeferred();
    const startupError = new Error("sidecar startup failed");
    const updateCheck = { ...hoisted.updateCheck, stop: vi.fn(() => cleanup.promise) };
    const onGatewayLifetimeSidecars = vi.fn<SidecarPublisher>();
    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams({ sidecarStartup: "defer", onGatewayLifetimeSidecars }),
      createPostAttachRuntimeDeps({
        createGatewayUpdateCheck: () => updateCheck,
        startGatewaySidecars: async () => {
          await sidecarsReady.promise;
          throw startupError;
        },
      }),
    );
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      const updateCheckOwner = onGatewayLifetimeSidecars.mock.calls[0]?.[0]?.[0];
      if (!updateCheckOwner) {
        throw new Error("update-check cleanup owner was not published");
      }
      expect(updateCheckOwner.stop).toBe(result.stopGatewayUpdateCheck);
      stopping = stopTrackedSidecar(updateCheckOwner).then(() => {
        stopped = true;
      });
      sidecarsReady.resolve();
      await expect(result.startupSettled).rejects.toBe(startupError);
      expect(updateCheck.stop).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
    } finally {
      sidecarsReady.resolve();
      cleanup.resolve();
      await (stopping ?? result.stopGatewayUpdateCheck());
      await result.startupSettled.catch(() => {});
    }
  });

  it("logs deferred gateway update check startup failures without failing ready", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const createGatewayUpdateCheck = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      startGatewayPostAttachRuntime(
        {
          ...createPostAttachParams(),
          log,
        },
        createPostAttachRuntimeDeps({
          refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
          createGatewayUpdateCheck,
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        stopGatewayUpdateCheck: expect.any(Function),
      }),
    );

    await waitForGatewayTestState(() => {
      expect(log.warn).toHaveBeenCalledWith(
        "gateway update check failed to initialize: Error: boom",
      );
    });
  });

  it("skips heavy restart sentinel refresh when no sentinel file exists", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-no-sentinel-"));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        hoisted.refreshLatestUpdateRestartSentinel.mockClear();

        const result = await testing.refreshLatestUpdateRestartSentinelIfPresent();

        expect(result).toBeNull();
        expect(hoisted.refreshLatestUpdateRestartSentinel).not.toHaveBeenCalled();
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("refreshes the restart sentinel when the sentinel row exists", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-"));
    try {
      await writeRestartSentinel(
        {
          kind: "update",
          status: "ok",
          ts: 1,
        },
        { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      );
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const sentinel = { kind: "update", status: "ok", ts: 1 } as const;
        hoisted.refreshLatestUpdateRestartSentinel.mockClear();
        hoisted.refreshLatestUpdateRestartSentinel.mockResolvedValue(sentinel);

        const result = await testing.refreshLatestUpdateRestartSentinelIfPresent();

        expect(result).toBe(sentinel);
        expect(hoisted.refreshLatestUpdateRestartSentinel).toHaveBeenCalledOnce();
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("detects restart sentinel rows in explicit state directories", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sentinel-state-"));
    try {
      await writeRestartSentinel(
        {
          kind: "update",
          status: "ok",
          ts: 1,
        },
        { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      );

      expect(
        await testing.hasRestartSentinelFast({
          OPENCLAW_STATE_DIR: stateDir,
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("avoids sync filesystem probes while checking restart sentinel presence", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-async-sentinel-"));
    try {
      await writeRestartSentinel(
        {
          kind: "update",
          status: "ok",
          ts: 1,
        },
        { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      );
      const actualExistsSync = fs.existsSync;
      const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
        if (String(candidate).startsWith(stateDir)) {
          throw new Error("sync restart sentinel probe");
        }
        return actualExistsSync(candidate);
      });
      try {
        await expect(
          testing.hasRestartSentinelFast({
            OPENCLAW_STATE_DIR: stateDir,
          } as NodeJS.ProcessEnv),
        ).resolves.toBe(true);
        expect(
          existsSync.mock.calls.filter((call) => String(call[0]).startsWith(stateDir)),
        ).toHaveLength(0);
      } finally {
        existsSync.mockRestore();
      }
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "preparing", state: { kind: "preparing" } as const },
    { name: "initially failed", state: { kind: "failed" } as const },
    {
      name: "already-ready bundled",
      state: { kind: "bundled", path: "/repo/dist/control-ui" } as const,
    },
  ])(
    "starts and can cancel Control UI assets for $name roots while plugins are pending",
    async ({ state }) => {
      let finishPluginStartup: (() => void) | undefined;
      const pluginStartup = new Promise<void>((resolve) => {
        finishPluginStartup = resolve;
      });
      const buildController = new AbortController();
      const buildSignal = buildController.signal;
      const startControlUiBuild = vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            buildSignal.addEventListener("abort", () => resolve(), { once: true });
          }),
      );
      const stopControlUiBuild = vi.fn(async () => buildController.abort());
      const onGatewayLifetimeSidecars = vi.fn();
      const startGatewaySidecarsPending = vi.fn(async () => ({
        pluginServices: null,
        postReadySidecars: [],
      }));
      const baseParams = createPostAttachParams();
      const loadStartupPlugins = vi.fn(async () => {
        await pluginStartup;
        return { pluginRegistry: baseParams.pluginRegistry, gatewayMethods: [] };
      });

      const runtimePromise = startGatewayPostAttachRuntime(
        {
          ...baseParams,
          loadStartupPlugins,
          onGatewayLifetimeSidecars,
          controlUiRootLifecycle: {
            state,
            setEnabled: vi.fn(),
            start: startControlUiBuild,
            stop: stopControlUiBuild,
          },
        },
        createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsPending }),
      );

      // Publication is synchronous, so shutdown can observe ownership even
      // while the first CA/plugin startup await has not completed.
      expect(onGatewayLifetimeSidecars).toHaveBeenCalledOnce();
      const earlySidecar = onGatewayLifetimeSidecars.mock.calls[0]?.[0]?.[0];
      expect(earlySidecar).toBeDefined();

      await waitForGatewayTestState(() => {
        expect(loadStartupPlugins).toHaveBeenCalledOnce();
        expect(startControlUiBuild).toHaveBeenCalledOnce();
      });
      expect(startGatewaySidecarsPending).not.toHaveBeenCalled();
      expect(buildSignal?.aborted).toBe(false);

      await stopTrackedSidecar(earlySidecar);
      expect(buildSignal?.aborted).toBe(true);
      expect(stopControlUiBuild).toHaveBeenCalledOnce();

      finishPluginStartup?.();
      await runtimePromise;

      expect(
        onGatewayLifetimeSidecars.mock.calls.slice(1).flatMap(([sidecars]) => sidecars),
      ).not.toContain(earlySidecar);
      expect(startControlUiBuild).toHaveBeenCalledOnce();
      expect(publishedGatewayLifetimeSidecars).not.toContain(earlySidecar);
      await cleanupGatewayTestState();
      expect(stopControlUiBuild).toHaveBeenCalledOnce();
      expect(publishedGatewayLifetimeSidecars).not.toContain(earlySidecar);
    },
  );

  it("loads startup plugins after bind and before channel sidecars", async () => {
    const events: string[] = [];
    const trace = createStartupTraceRecorder();
    const loadedPluginRegistry = {
      plugins: [{ id: "acpx", status: "loaded" }],
      typedHooks: [],
    } as never;
    const loadStartupPlugins = vi.fn(async () => {
      events.push("load-startup-plugins");
      return {
        pluginRegistry: loadedPluginRegistry,
        gatewayMethods: ["ping", "acp.spawn"],
      };
    });
    const onStartupPluginsLoading = vi.fn(() => {
      events.push("startup-loading");
    });
    const onStartupPluginsLoaded = vi.fn(() => {
      events.push("startup-loaded");
    });
    const startGatewaySidecarsCandidate = vi.fn(async (params) => {
      events.push("sidecars");
      expect(params.pluginRegistry).toBe(loadedPluginRegistry);
      return { pluginServices: null, postReadySidecars: [] };
    });

    await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams({
          pluginRegistry: {
            plugins: [],
            typedHooks: [],
          } as never,
          loadStartupPlugins,
          onStartupPluginsLoading,
          onStartupPluginsLoaded,
          startupTrace: trace.startupTrace,
        }),
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsCandidate }),
    );

    expect(events).toEqual([
      "startup-loading",
      "load-startup-plugins",
      "startup-loaded",
      "sidecars",
    ]);
    expect(loadStartupPlugins).toHaveBeenCalledTimes(1);
    expect(onStartupPluginsLoaded).toHaveBeenCalledWith({
      pluginRegistry: loadedPluginRegistry,
      gatewayMethods: ["ping", "acp.spawn"],
    });
    expect(hoisted.logGatewayStartup).toHaveBeenCalledTimes(1);
    expect(firstStartupLog().loadedPluginIds).toEqual(["acpx"]);
    expect(trace.measures).toContain("plugins.runtime-post-bind");
    expect(trace.details).toContainEqual({
      name: "plugins.runtime-post-bind",
      metrics: [
        ["loadedPluginCount", 1],
        ["gatewayMethodCount", 2],
      ],
    });
  });

  it("waits for startup plugin attachment before channel sidecars", async () => {
    const events: string[] = [];
    let finishAttachment: (() => void) | undefined;
    const attachmentFinished = new Promise<void>((resolve) => {
      finishAttachment = () => {
        events.push("startup-loaded-end");
        resolve();
      };
    });
    const loadedPluginRegistry = {
      plugins: [{ id: "acpx", status: "loaded" }],
      typedHooks: [],
    } as never;
    const loadStartupPlugins = vi.fn(async () => ({
      pluginRegistry: loadedPluginRegistry,
      gatewayMethods: ["ping", "acp.spawn"],
    }));
    const onStartupPluginsLoaded = vi.fn(() => {
      events.push("startup-loaded-start");
      return attachmentFinished;
    });
    const startGatewaySidecarsEntry = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    const runtimePromise = startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams({
          pluginRegistry: {
            plugins: [],
            typedHooks: [],
          } as never,
          loadStartupPlugins,
          onStartupPluginsLoaded,
        }),
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsEntry }),
    );

    await waitForGatewayTestState(() => {
      expect(events).toEqual(["startup-loaded-start"]);
    });
    expect(startGatewaySidecarsEntry).not.toHaveBeenCalled();

    if (!finishAttachment) {
      throw new Error("Expected startup plugin attachment release callback to be initialized");
    }
    finishAttachment();
    await runtimePromise;

    expect(events).toEqual(["startup-loaded-start", "startup-loaded-end", "sidecars"]);
  });

  it("adopts a winning plugin generation without publishing stale deferred startup state", async () => {
    const startupRegistry = {
      plugins: [{ id: "startup", status: "loaded" }],
      typedHooks: [],
    } as never;
    const winningRegistry = {
      plugins: [{ id: "replacement", status: "loaded" }],
      typedHooks: [],
    } as never;
    let startupClaimCurrent = true;
    let releasePluginLoad: (() => void) | undefined;
    const pluginLoadReady = new Promise<void>((resolve) => {
      releasePluginLoad = resolve;
    });
    const pluginRuntimeClaim = {
      isCurrent: () => startupClaimCurrent,
      waitForUnblocked: async () => true,
      publish: (publish: () => void) => {
        if (!startupClaimCurrent) {
          return false;
        }
        publish();
        return true;
      },
    };
    const onStartupPluginsLoaded = vi.fn();
    const onPluginServices = vi.fn();
    const onSidecarsReady = vi.fn();
    const unlockStartupMethods = vi.fn();
    const startGatewaySidecarsCandidate = vi.fn(
      async (params: Parameters<typeof startGatewaySidecarsImpl>[0]) => {
        expect(params.pluginRegistry).toBe(winningRegistry);
        expect(params.shouldStartPluginServices?.()).toBe(false);
        return { pluginServices: null, postReadySidecars: [] };
      },
    );
    const loadStartupPlugins = vi.fn(async () => {
      await pluginLoadReady;
      return { pluginRegistry: startupRegistry, gatewayMethods: ["startup.method"] };
    });

    const runtime = await startGatewayPostAttachRuntime(
      createPostAttachParams({
        sidecarStartup: "defer",
        loadStartupPlugins,
        onStartupPluginsLoaded,
        onPluginServices,
        onSidecarsReady,
        unlockStartupMethods,
        pluginRuntimeClaim,
        getCurrentPluginRegistry: () => winningRegistry,
      }),
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsCandidate }),
    );
    await waitForGatewayTestState(() => expect(loadStartupPlugins).toHaveBeenCalledOnce());
    startupClaimCurrent = false;
    releasePluginLoad?.();
    await expect(runtime.startupSettled).resolves.toBeUndefined();

    expect(onStartupPluginsLoaded).not.toHaveBeenCalled();
    expect(startGatewaySidecarsCandidate).toHaveBeenCalledOnce();
    expect(onPluginServices).not.toHaveBeenCalled();
    expect(unlockStartupMethods).toHaveBeenCalledOnce();
    expect(onSidecarsReady).toHaveBeenCalledOnce();
  });

  it("waits for sidecars by default before returning", async () => {
    let resumeSidecars: (() => void) | undefined;
    const sidecarsReady = new Promise<{ pluginServices: null; postReadySidecars: [] }>(
      (resolve) => {
        resumeSidecars = () => resolve({ pluginServices: null, postReadySidecars: [] });
      },
    );
    const startGatewaySidecarsResult = vi.fn(async () => {
      return await sidecarsReady;
    });
    let returned = false;

    const runtimePromise = startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsResult }),
    ).then(() => {
      returned = true;
    });

    await waitForGatewayTestState(() => {
      expect(startGatewaySidecarsResult).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    if (!resumeSidecars) {
      throw new Error("Expected gateway sidecar resume callback to be initialized");
    }
    resumeSidecars();
    await runtimePromise;
    expect(returned).toBe(true);
  });

  it("delays provider auth prewarm so post-ready gateway work can run first", async () => {
    vi.useFakeTimers();
    const postReadyRequestTurn = vi.fn();
    const onPostReadySidecars = vi.fn();
    const onGatewayLifetimeSidecars = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };

    try {
      await startGatewayPostAttachRuntime({
        ...createPostAttachParams(),
        log,
        sidecarStartup: "defer",
        providerAuthPrewarm: { enabled: true, delayMs: 1_000 },
        onPostReadySidecars,
        onGatewayLifetimeSidecars,
        onSidecarsReady: () => {
          setImmediate(() => {
            postReadyRequestTurn();
          });
        },
      });

      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();
      expect(postReadyRequestTurn).toHaveBeenCalledTimes(1);
      expect(onPostReadySidecars.mock.calls[0]?.[0]).toHaveLength(1);
      expect(publishedGatewayLifetimeSidecars.size).toBe(4);
      await vi.dynamicImportSettled();
      await waitForGatewayTestState(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledTimes(1);
      });
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await waitForGatewayTestState(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps provider auth failure rewarm without default startup prewarm", async () => {
    vi.useFakeTimers();
    const onGatewayLifetimeSidecars = vi.fn();

    try {
      await startGatewayPostAttachRuntime({
        ...createPostAttachParams(),
        sidecarStartup: "defer",
        providerAuthPrewarm: {},
        onGatewayLifetimeSidecars,
      });

      await vi.dynamicImportSettled();
      await waitForGatewayTestState(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledTimes(1);
      });
      expect(publishedGatewayLifetimeSidecars.size).toBe(4);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();

      const hook = hoisted.setAuthProfileFailureHook.mock.calls[0]?.[0] as (() => void) | undefined;
      hook?.();
      expect(hoisted.clearCurrentProviderAuthState).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await waitForGatewayTestState(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers context-window cache prewarm to a post-ready sidecar", async () => {
    vi.useFakeTimers();
    const startupConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const currentConfig = { ...startupConfig };
    const admission = tryBeginGatewayRootWorkAdmission();
    if (!admission) {
      throw new Error("Expected request work admission");
    }
    const sidecar = scheduleContextCachePrewarm({
      getConfig: () => currentConfig,
      log: { warn: vi.fn() },
    });

    try {
      expect(hoisted.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(hoisted.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(hoisted.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();

      admission.release();
      await vi.advanceTimersByTimeAsync(249);
      expect(hoisted.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.dynamicImportSettled();
      await waitForGatewayTestState(() => {
        expect(hoisted.prewarmContextWindowCacheAfterReady).toHaveBeenCalledWith({
          config: currentConfig,
          isCancelled: expect.any(Function),
        });
      });
    } finally {
      admission.release();
      await stopTrackedSidecar(sidecar);
    }
  });

  it("cancels context-window cache prewarm when the gateway stops first", async () => {
    vi.useFakeTimers();
    const sidecar = scheduleContextCachePrewarm({
      getConfig: () => ({}) as never,
      log: { warn: vi.fn() },
    });

    await stopTrackedSidecar(sidecar);
    await vi.runAllTimersAsync();
    expect(hoisted.prewarmContextWindowCacheAfterReady).not.toHaveBeenCalled();
  });

  it("keeps provider auth prewarm alive when Gmail post-ready sidecars stop", async () => {
    vi.useFakeTimers();
    const onPostReadySidecars = vi.fn();
    const onGatewayLifetimeSidecars = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };

    try {
      await startGatewayPostAttachRuntime({
        ...createPostAttachParams({
          cfgAtStart: {
            hooks: {
              enabled: true,
              internal: { enabled: false },
              gmail: { account: "me" },
            },
          } as never,
          gatewayPluginConfigAtStart: {
            hooks: {
              enabled: true,
              internal: { enabled: false },
              gmail: { account: "me" },
            },
          } as never,
        }),
        log,
        sidecarStartup: "defer",
        providerAuthPrewarm: { enabled: true, delayMs: 1_000 },
        onPostReadySidecars,
        onGatewayLifetimeSidecars,
      });

      await vi.advanceTimersToNextTimerAsync();
      await waitForGatewayTestState(() => {
        expect(onPostReadySidecars).toHaveBeenCalledTimes(1);
        expect(publishedGatewayLifetimeSidecars.size).toBe(4);
      });
      const gmailSidecars = onPostReadySidecars.mock.calls[0]?.[0] as
        | { stop: () => void }[]
        | undefined;
      const lifetimeSidecars = [...publishedGatewayLifetimeSidecars];
      expect(gmailSidecars).toHaveLength(2);
      expect(lifetimeSidecars).toHaveLength(4);

      for (const sidecar of gmailSidecars ?? []) {
        await stopTrackedSidecar(sidecar);
      }
      await vi.dynamicImportSettled();
      await waitForGatewayTestState(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await waitForGatewayTestState(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      });

      const hook = hoisted.setAuthProfileFailureHook.mock.calls[0]?.[0] as (() => void) | undefined;
      hook?.();
      await waitForGatewayTestState(() => {
        expect(hoisted.clearCurrentProviderAuthState).toHaveBeenCalledTimes(1);
      });
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await waitForGatewayTestState(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps transcripts auto-start alive when Gmail post-ready sidecars stop", async () => {
    const onPostReadySidecars = vi.fn();
    const onGatewayLifetimeSidecars = vi.fn();
    const config = {
      hooks: {
        enabled: true,
        internal: { enabled: false },
        gmail: { account: "me" },
      },
      transcripts: {
        autoStart: [{ providerId: "discord-voice", guildId: "g", channelId: "c" }],
      },
    };

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams({
        cfgAtStart: config as never,
        gatewayPluginConfigAtStart: config as never,
      }),
      providerAuthPrewarm: { enabled: false },
      onPostReadySidecars,
      onGatewayLifetimeSidecars,
    });

    const gmailSidecars = onPostReadySidecars.mock.calls[0]?.[0] as
      | Array<{ stop: () => Promise<void> | void }>
      | undefined;
    const lifetimeSidecars = [...publishedGatewayLifetimeSidecars];
    expect(gmailSidecars).toHaveLength(2);
    expect(lifetimeSidecars).toHaveLength(4);

    await waitForGatewayTestState(() => {
      expect(hoisted.transcriptsAutoStartService.start).toHaveBeenCalledTimes(1);
    });

    for (const sidecar of gmailSidecars ?? []) {
      await stopTrackedSidecar(sidecar);
    }
    expect(hoisted.transcriptsAutoStartService.stop).not.toHaveBeenCalled();

    for (const sidecar of lifetimeSidecars) {
      await stopTrackedSidecar(sidecar);
    }
    expect(hoisted.transcriptsAutoStartService.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels delayed provider auth prewarm when the sidecar stops before the timer fires", async () => {
    vi.useFakeTimers();
    const log = { info: vi.fn(), warn: vi.fn() };

    try {
      const sidecar = testing.scheduleProviderAuthStatePrewarm({
        getConfig: () => ({ marker: "current" }) as never,
        log,
        delayMs: 1_000,
        startupWarmEnabled: true,
      });
      await vi.dynamicImportSettled();
      await waitForGatewayTestState(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledTimes(1);
      });

      await stopTrackedSidecar(sidecar);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();

      const hook = hoisted.setAuthProfileFailureHook.mock.calls[0]?.[0] as (() => void) | undefined;
      hook?.();
      await vi.dynamicImportSettled();
      expect(hoisted.clearCurrentProviderAuthState).not.toHaveBeenCalled();
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns a queued provider auth rewarm rejected by restart drain without warning", async () => {
    vi.useFakeTimers();
    const log = { info: vi.fn(), warn: vi.fn() };
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const sidecar = testing.scheduleProviderAuthStatePrewarm({
      getConfig: () => ({}) as never,
      log,
      startupWarmEnabled: false,
    });

    try {
      await vi.dynamicImportSettled();
      await waitForGatewayTestState(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledOnce();
      });
      const failureHook = hoisted.setAuthProfileFailureHook.mock.calls[0]?.[0] as
        | (() => void)
        | undefined;
      if (!failureHook) {
        throw new Error("Expected provider auth failure hook to be registered");
      }

      failureHook();
      markGatewayRestartDraining();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.dynamicImportSettled();

      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      await sidecar.stop();
      process.off("unhandledRejection", onUnhandledRejection);
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "ordinary failure", error: new Error("provider warm failed") },
    { label: "draining error outside restart", error: new GatewayDrainingError("not draining") },
  ])("warns for a queued provider auth rewarm $label", async ({ error }) => {
    vi.useFakeTimers();
    const log = { info: vi.fn(), warn: vi.fn() };
    hoisted.warmCurrentProviderAuthStateOffMainThread.mockRejectedValueOnce(error);
    const sidecar = testing.scheduleProviderAuthStatePrewarm({
      getConfig: () => ({}) as never,
      log,
      startupWarmEnabled: false,
    });

    try {
      await vi.dynamicImportSettled();
      await waitForGatewayTestState(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledOnce();
      });
      const failureHook = hoisted.setAuthProfileFailureHook.mock.calls[0]?.[0] as
        | (() => void)
        | undefined;
      if (!failureHook) {
        throw new Error("Expected provider auth failure hook to be registered");
      }

      failureHook();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(log.warn).toHaveBeenCalledWith(`provider auth state rewarm failed: ${String(error)}`);
    } finally {
      await sidecar.stop();
      vi.useRealTimers();
    }
  });

  it("delays explicit provider auth prewarm beyond the early post-ready window", async () => {
    expect(testing.providerAuthPrewarmStartDelayMs).toBe(5_000);
  });

  it("uses the current provider auth config when the delayed prewarm fires", async () => {
    vi.useFakeTimers();
    const startupCfg = { marker: "startup" } as never;
    const reloadedCfg = { marker: "reloaded" } as never;
    const afterFailureCfg = { marker: "after-failure" } as never;
    let currentCfg = startupCfg;
    const log = { info: vi.fn(), warn: vi.fn() };

    try {
      testing.scheduleProviderAuthStatePrewarm({
        getConfig: () => currentCfg,
        log,
        delayMs: 0,
        startupWarmEnabled: true,
      });
      currentCfg = reloadedCfg;
      await vi.dynamicImportSettled();
      await waitForGatewayTestState(() => {
        expect(hoisted.setAuthProfileFailureHook).toHaveBeenCalledTimes(1);
      });
      await vi.advanceTimersByTimeAsync(0);
      await waitForGatewayTestState(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      });

      const hook = hoisted.setAuthProfileFailureHook.mock.calls[0]?.[0] as (() => void) | undefined;
      if (!hook) {
        throw new Error("Expected provider auth failure hook to be registered");
      }

      hook();
      currentCfg = afterFailureCfg;
      hook();
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(1);
      expect(hoisted.clearCurrentProviderAuthState).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1_000);
      await waitForGatewayTestState(() => {
        expect(hoisted.warmCurrentProviderAuthStateOffMainThread).toHaveBeenCalledTimes(2);
      });
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread.mock.calls[0]?.[0]).toBe(
        reloadedCfg,
      );
      expect(hoisted.warmCurrentProviderAuthStateOffMainThread.mock.calls[1]?.[0]).toBe(
        afterFailureCfg,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts channels when channel startup is enabled", async () => {
    await withEnvAsync(
      {
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
      async () => {
        const startChannels = vi.fn(async () => {});

        await startGatewaySidecars({
          cfg: {
            hooks: { internal: { enabled: false } },
            agents: { defaults: { model: "openai/gpt-5.4" } },
          } as never,
          pluginRegistry: createPostAttachParams().pluginRegistry,
          defaultWorkspaceDir: "/tmp/openclaw-workspace",
          deps: {} as never,
          startChannels,
          log: { warn: vi.fn() },
          logHooks: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
          logChannels: {
            info: vi.fn(),
            error: vi.fn(),
          },
        });

        expect(startChannels).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("releases startup account starts before awaiting channel handoff", async () => {
    const events: string[] = [];
    let releaseAccountStarts!: () => void;
    const accountStartsReady = new Promise<void>((resolve) => {
      releaseAccountStarts = resolve;
    });
    const startChannels = vi.fn(async () => {
      events.push("channels-start");
      await accountStartsReady;
      events.push("channels-end");
    });
    const onChannelsStarted = vi.fn(() => {
      events.push("channels-released");
      releaseAccountStarts();
    });

    const sidecars = startGatewaySidecars({
      cfg: { hooks: { internal: { enabled: false } } } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels,
      onChannelsStarted,
      log: { warn: vi.fn() },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
    });

    await waitForGatewayTestState(() => {
      expect(onChannelsStarted).toHaveBeenCalledOnce();
    });
    expect(events.slice(0, 2)).toEqual(["channels-start", "channels-released"]);
    await sidecars;

    expect(events).toEqual(["channels-start", "channels-released", "channels-end"]);
    expect(startChannels).toHaveBeenCalledOnce();
    expect(onChannelsStarted).toHaveBeenCalledOnce();
  });

  it("starts and reports plugin services after channel startup completes", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let releaseChannels: (() => void) | undefined;
        const events: string[] = [];
        const pluginServices: PluginServicesHandle = {
          reload: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        };
        const onPluginServices = vi.fn();
        const onSidecarsReady = vi.fn();
        const startChannels = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              events.push("channels-start");
              releaseChannels = () => {
                events.push("channels-end");
                resolve();
              };
            }),
        );
        hoisted.startPluginServices.mockImplementationOnce(async (params) => {
          events.push("plugin-services");
          params.onHandle?.(pluginServices);
          return pluginServices;
        });

        await startGatewayPostAttachRuntime({
          ...createPostAttachParams({
            sidecarStartup: "defer",
            onChannelsStarted: async () => {
              events.push("channels-started");
            },
            onPluginServices,
            onSidecarsReady,
          }),
          startChannels,
        });

        await waitForGatewayTestState(() => {
          expect(startChannels).toHaveBeenCalledTimes(1);
        });
        expect(hoisted.startPluginServices).not.toHaveBeenCalled();
        expect(onPluginServices).not.toHaveBeenCalled();
        expect(onSidecarsReady).not.toHaveBeenCalled();

        if (!releaseChannels) {
          throw new Error("Expected channel startup release callback to be initialized");
        }
        releaseChannels();
        await waitForGatewayTestState(() => {
          expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
          expect(onPluginServices).toHaveBeenCalledOnce();
          expect(onPluginServices.mock.calls[0]?.[0]).toHaveProperty("stop");
          expect(onSidecarsReady).toHaveBeenCalledTimes(1);
        });
        expect(events).toEqual([
          "channels-start",
          "channels-started",
          "channels-end",
          "plugin-services",
        ]);
        expect(onPluginServices).toHaveBeenCalledTimes(1);
        const owner: PluginServicesHandle = onPluginServices.mock.calls[0]?.[0];
        const config: OpenClawConfig = { diagnostics: { otel: { enabled: true } } };
        const selected = new Set(["exporter"]);
        await owner.reload(config, selected);
        expect(pluginServices.reload).toHaveBeenCalledExactlyOnceWith(config, selected);
        await owner.stop();
        await expect(owner.reload(config, selected)).rejects.toThrow("stopping");
        expect(pluginServices.reload).toHaveBeenCalledOnce();
      },
    );
  });

  it("does not start plugin services after deferred close starts during channel startup", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let closing = false;
        let releaseChannels: (() => void) | undefined;
        const onPluginServices = vi.fn();
        const onSidecarsReady = vi.fn();
        const startChannels = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseChannels = resolve;
            }),
        );

        const runtime = await startGatewayPostAttachRuntime({
          ...createPostAttachParams({
            sidecarStartup: "defer",
            onPluginServices,
            onSidecarsReady,
          }),
          startChannels,
          isClosing: () => closing,
        });

        await waitForGatewayTestState(() => {
          expect(startChannels).toHaveBeenCalledTimes(1);
        });
        closing = true;

        if (!releaseChannels) {
          throw new Error("Expected channel startup release callback to be initialized");
        }
        releaseChannels();

        await runtime.startupSettled;
        expect(onSidecarsReady).not.toHaveBeenCalled();
        expect(hoisted.startPluginServices).not.toHaveBeenCalled();
        expect(onPluginServices).toHaveBeenCalledWith(null);
      },
    );
  });

  it.each(["Gateway close", "replacement reservation", "strict replacement"] as const)(
    "keeps published service lifetime with its owner during %s",
    async (boundary) => {
      const actualServices =
        await vi.importActual<typeof import("../plugins/services.js")>("../plugins/services.js");
      hoisted.startPluginServices.mockImplementationOnce(actualServices.startPluginServices);
      const registry = createEmptyPluginRegistry();
      const siblingStarted = createDeferred();
      const releaseSibling = createDeferred();
      const serviceStop = vi.fn();
      const broadcastPluginEvent = vi.fn();
      let emit: (() => void) | undefined;
      registry.services.push(
        {
          pluginId: "published-startup",
          source: "test",
          origin: "workspace",
          service: {
            id: "published-startup-service",
            start: (context) => {
              emit = () => context.gatewayEvents?.emit("ready", {}, { scope: "operator.read" });
              registerPluginHttpRoute({
                path: "/published-startup-service",
                auth: "plugin",
                handler: vi.fn(),
              });
            },
            stop: serviceStop,
          },
        },
        {
          pluginId: "blocked-startup",
          source: "test",
          origin: "workspace",
          service: {
            id: "blocked-startup-service",
            start: () => {
              siblingStarted.resolve();
              return releaseSibling.promise;
            },
          },
        },
      );
      let services: PluginServicesHandle | null = null;
      const generation = createGatewayPluginRuntimeGeneration({
        getServices: () => services,
        setServices: (next) => {
          services = next;
        },
      });
      const claim = generation.currentClaim();
      const onPluginServices = vi.fn((handle: PluginServicesHandle | null) => {
        generation.publishServices(claim, handle);
      });
      let closing = false;
      const base = createPostAttachParams();
      const sidecarsPromise = startGatewaySidecars({
        cfg: base.cfgAtStart,
        pluginRegistry: registry,
        defaultWorkspaceDir: base.defaultWorkspaceDir,
        deps: base.deps,
        startChannels: vi.fn(async () => {}),
        shouldStartPluginServices: () => !closing && claim.isCurrent(),
        shouldCreatePostReadySidecars: () => false,
        pluginRuntimeClaim: claim,
        onPluginServices,
        broadcastPluginEvent,
        log: base.log,
        logHooks: base.logHooks,
        logChannels: base.logChannels,
      });
      let reservation: ReturnType<typeof generation.reserve> | undefined;
      let stopping: Promise<void> | undefined;
      try {
        await siblingStarted.promise;
        const owner = generation.currentServices();
        if (!owner) {
          throw new Error("plugin service owner was not published before startup yielded");
        }
        expect(registry.httpRoutes.map((route) => route.path)).toEqual([
          "/published-startup-service",
        ]);
        emit?.();
        expect(broadcastPluginEvent).toHaveBeenCalledOnce();

        if (boundary === "Gateway close") {
          closing = true;
        } else {
          reservation = generation.reserve();
          if (boundary === "strict replacement") {
            stopping = owner.stop({ strict: true, deadlineAtMs: Date.now() + 5_000 });
          }
        }
        releaseSibling.resolve();
        const result = await sidecarsPromise;
        await stopping;

        expect(result.pluginServices).not.toBeNull();
        expect(generation.currentServices()).toBe(owner);
        expect(onPluginServices).toHaveBeenLastCalledWith(owner);
        if (boundary === "strict replacement") {
          expect(serviceStop).toHaveBeenCalledOnce();
          expect(registry.httpRoutes).toEqual([]);
          expect(() => emit?.()).toThrow("no longer active");
        } else {
          expect(serviceStop).not.toHaveBeenCalled();
          expect(registry.httpRoutes.map((route) => route.path)).toEqual([
            "/published-startup-service",
          ]);
          emit?.();
          expect(broadcastPluginEvent).toHaveBeenCalledTimes(2);
        }
      } finally {
        releaseSibling.resolve();
        reservation?.reject();
        await Promise.allSettled([sidecarsPromise, stopping]);
        await generation.currentServices()?.stop();
      }
    },
  );

  it("releases tracked startup after strict timeout while retaining service cleanup", async () => {
    vi.useFakeTimers();
    const actualServices =
      await vi.importActual<typeof import("../plugins/services.js")>("../plugins/services.js");
    hoisted.startPluginServices.mockImplementationOnce(actualServices.startPluginServices);
    const startupEntered = createDeferred();
    const startup = createDeferred();
    const cleanup = createDeferred();
    const serviceStop = vi.fn(() => cleanup.promise);
    const registry = createEmptyPluginRegistry();
    registry.services.push({
      pluginId: "retained-startup-cleanup",
      source: "test",
      origin: "workspace",
      service: {
        id: "retained-startup-cleanup",
        start: () => {
          startupEntered.resolve();
          return startup.promise;
        },
        stop: serviceStop,
      },
    });
    const publishedOwner: { current: PluginServicesHandle | null } = { current: null };
    const generation = createGatewayPluginRuntimeGeneration({
      getServices: () => publishedOwner.current,
      setServices: (handle) => {
        publishedOwner.current = handle;
      },
    });
    const claim = generation.currentClaim();
    const connectionWork = new GatewayConnectionWork();
    const base = createPostAttachParams();
    const operation = Promise.resolve().then(() =>
      startGatewaySidecars({
        cfg: base.cfgAtStart,
        pluginRegistry: registry,
        defaultWorkspaceDir: base.defaultWorkspaceDir,
        deps: base.deps,
        startChannels: vi.fn(async () => {}),
        shouldCreatePostReadySidecars: () => false,
        pluginRuntimeClaim: claim,
        onPluginServices: (handle) => {
          generation.publishServices(claim, handle);
        },
        log: base.log,
        logHooks: base.logHooks,
        logChannels: base.logChannels,
      }),
    );
    const starting = connectionWork.track(() => operation);
    let replacing: Promise<unknown> | undefined;
    let draining: Promise<void> | undefined;
    let finalCleanup: Promise<void> | undefined;
    let reservation: ReturnType<typeof generation.reserve> | undefined;

    try {
      await startupEntered.promise;
      const owner = generation.currentServices();
      if (!owner) {
        throw new Error("plugin service owner was not published before startup yielded");
      }
      reservation = generation.reserve();
      replacing = owner
        .stop({
          strict: true,
          deadlineAtMs: Date.now() + actualServices.PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(actualServices.PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      expect(await replacing).toBeInstanceOf(AggregateError);
      expect(serviceStop).toHaveBeenCalledOnce();
      reservation.reject();
      startup.resolve();

      let drained = false;
      draining = connectionWork.drain().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(true);
      expect(generation.currentServices()).toBe(owner);

      let cleanupSettled = false;
      finalCleanup = owner.stop().then(() => {
        cleanupSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupSettled).toBe(false);
      expect(serviceStop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await finalCleanup;
      expect(cleanupSettled).toBe(true);
      expect(serviceStop).toHaveBeenCalledOnce();
    } finally {
      reservation?.reject();
      startup.resolve();
      cleanup.resolve();
      await Promise.allSettled([starting, replacing, draining, finalCleanup]);
      await generation.currentServices()?.stop();
    }
  });

  it("publishes plugin cleanup ownership before lazy service loading", async () => {
    let shouldStartPluginServices = true;
    let stopping: Promise<void> | undefined;
    const onPluginServices = vi.fn((handle: PluginServicesHandle | null) => {
      if (!handle) {
        return;
      }
      shouldStartPluginServices = false;
      stopping = handle.stop();
    });

    const sidecars = await startGatewaySidecars({
      cfg: { hooks: { internal: { enabled: false } } } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      shouldStartPluginServices: () => shouldStartPluginServices,
      onPluginServices,
      log: { warn: vi.fn() },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
    });

    if (!stopping) {
      throw new Error("plugin service cleanup owner was not published");
    }
    await stopping;
    expect(hoisted.startPluginServices).not.toHaveBeenCalled();
    expect(sidecars.pluginServices).toBeNull();
    expect(onPluginServices).toHaveBeenCalledOnce();
  });

  it.each(["settles", "times out"] as const)(
    "forwards strict replacement cleanup through the deferred plugin service owner when it %s",
    async (strictOutcome) => {
      vi.useFakeTimers();
      const cleanup = createDeferred();
      const strictCleanup = createDeferred();
      const serviceStop = vi.fn<PluginServicesHandle["stop"]>((options) => {
        if (options?.strict) {
          return strictOutcome === "settles" ? Promise.resolve() : strictCleanup.promise;
        }
        return cleanup.promise;
      });
      const startedServices = { reload: vi.fn(async () => {}), stop: serviceStop };
      const publishedOwner: { current: PluginServicesHandle | null } = { current: null };
      hoisted.startPluginServices.mockImplementationOnce(async (params) => {
        params.onHandle?.(startedServices);
        return startedServices;
      });

      await startGatewaySidecars({
        cfg: { hooks: { internal: { enabled: false } } } as never,
        pluginRegistry: createPostAttachParams().pluginRegistry,
        defaultWorkspaceDir: "/tmp/openclaw-workspace",
        deps: {} as never,
        startChannels: vi.fn(async () => {}),
        onPluginServices: (handle) => {
          publishedOwner.current = handle;
        },
        log: { warn: vi.fn() },
        logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        logChannels: { info: vi.fn(), error: vi.fn() },
      });

      const owner = publishedOwner.current;
      if (!owner) {
        throw new Error("deferred plugin service owner was not published");
      }
      const replacement = { strict: true, deadlineAtMs: Date.now() + 5_000 } as const;
      const replacing = owner.stop(replacement);
      const replacementResult = replacing.catch((error: unknown) => error);
      let stopping: Promise<void> | undefined;

      try {
        if (strictOutcome === "settles") {
          await replacing;
          expect(serviceStop).toHaveBeenCalledWith(replacement);
          return;
        }

        await vi.advanceTimersByTimeAsync(5_000);
        expect(await replacementResult).toBeInstanceOf(AggregateError);
        strictCleanup.reject(new Error("strict service cleanup timed out"));
        await vi.advanceTimersByTimeAsync(0);

        let stopped = false;
        stopping = owner.stop();
        void stopping.then(
          () => {
            stopped = true;
          },
          () => {
            stopped = true;
          },
        );
        await vi.advanceTimersByTimeAsync(0);

        expect(stopped).toBe(false);
        expect(serviceStop.mock.calls.map(([options]) => options)).toEqual([
          replacement,
          undefined,
        ]);
        cleanup.resolve();
        await expect(stopping).resolves.toBeUndefined();
      } finally {
        strictCleanup.resolve();
        cleanup.resolve();
        await Promise.allSettled([replacing, stopping]);
      }
    },
  );

  it("fences late service capabilities when deferred ownership consumes the replacement deadline", async () => {
    vi.useFakeTimers();
    const actualServices =
      await vi.importActual<typeof import("../plugins/services.js")>("../plugins/services.js");
    const registry = createEmptyPluginRegistry();
    const broadcastPluginEvent = vi.fn();
    let context: OpenClawPluginServiceContext | undefined;
    let releaseCleanup: (() => void) | undefined;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    registry.services.push({
      pluginId: "deferred-deadline",
      source: "test",
      origin: "workspace",
      service: {
        id: "deferred-deadline-service",
        start: (serviceContext) => {
          context = serviceContext;
          registerPluginHttpRoute({
            path: "/deferred-deadline-route",
            auth: "plugin",
            handler: vi.fn(),
          });
        },
        stop: async () => {
          await cleanupReleased;
        },
      },
    });
    hoisted.startPluginServices.mockImplementationOnce(async (params) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 4_900);
      });
      return await actualServices.startPluginServices(params);
    });
    const publishedOwner: { current: PluginServicesHandle | null } = { current: null };
    let stopping: Promise<void> | undefined;
    let sidecars: ReturnType<typeof startGatewaySidecars> | undefined;

    try {
      sidecars = startGatewaySidecars({
        cfg: { hooks: { internal: { enabled: false } } } as never,
        pluginRegistry: registry,
        defaultWorkspaceDir: "/tmp/openclaw-workspace",
        deps: {} as never,
        startChannels: vi.fn(async () => {}),
        broadcastPluginEvent,
        onPluginServices: (handle) => {
          publishedOwner.current = handle;
        },
        log: { warn: vi.fn() },
        logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        logChannels: { info: vi.fn(), error: vi.fn() },
      });
      await waitForGatewayTestState(() => {
        expect(hoisted.startPluginServices).toHaveBeenCalledOnce();
      });
      if (!publishedOwner.current) {
        throw new Error("deferred plugin service owner was not published");
      }

      const deadlineAtMs = Date.now() + 5_000;
      let failure: unknown;
      stopping = publishedOwner.current
        .stop({ strict: true, deadlineAtMs })
        .catch((error: unknown) => {
          failure = error;
        });

      await vi.advanceTimersByTimeAsync(4_900);
      expect(registry.httpRoutes).toHaveLength(1);
      expect(failure).toBeUndefined();

      await vi.advanceTimersByTimeAsync(100);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(registry.httpRoutes).toEqual([]);
      expect(() => context?.gatewayEvents?.emit("late", {}, { scope: "operator.read" })).toThrow(
        "no longer active",
      );
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
    } finally {
      releaseCleanup?.();
      await stopping;
      await sidecars;
      vi.useRealTimers();
    }
  });

  it("reports deferred plugin services after core startup returns", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let releaseStartupLog: (() => void) | undefined;
        let releaseChannels: (() => void) | undefined;
        const pluginServices = { stop: vi.fn(async () => {}) } as never;
        const onPluginServices = vi.fn();
        const onSidecarsReady = vi.fn();
        const logGatewayStartup = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseStartupLog = resolve;
            }),
        );
        const startChannels = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseChannels = resolve;
            }),
        );
        hoisted.startPluginServices.mockImplementationOnce(async (params) => {
          params.onHandle?.(pluginServices);
          return pluginServices;
        });

        const runtimePromise = startGatewayPostAttachRuntime(
          {
            ...createPostAttachParams({
              sidecarStartup: "defer",
              onPluginServices,
              onSidecarsReady,
            }),
            startChannels,
          },
          createPostAttachRuntimeDeps({
            logGatewayStartup,
            startGatewaySidecars,
          }),
        );

        await expect(runtimePromise).resolves.toMatchObject({ pluginServices: null });

        await waitForGatewayTestState(() => {
          expect(logGatewayStartup).toHaveBeenCalledTimes(1);
        });

        if (!releaseStartupLog) {
          throw new Error("Expected startup log release callback to be initialized");
        }
        releaseStartupLog();

        await waitForGatewayTestState(() => expect(startChannels).toHaveBeenCalledTimes(1));

        if (!releaseChannels) {
          throw new Error("Expected channel startup release callback to be initialized");
        }
        releaseChannels();
        await waitForGatewayTestState(() => {
          expect(onPluginServices).toHaveBeenCalledOnce();
          expect(onPluginServices.mock.calls[0]?.[0]).toHaveProperty("stop");
        });

        await waitForGatewayTestState(() => {
          expect(onSidecarsReady).toHaveBeenCalledTimes(1);
        });
      },
    );
  });

  it("emits a startup trace span when channel startup is skipped", async () => {
    const trace = createStartupTraceRecorder();
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const prewarmPrimaryModel = vi.fn(async () => {});
    const onChannelsStarted = vi.fn();

    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        await startGatewaySidecars({
          cfg: {
            hooks: { internal: { enabled: false } },
            agents: { defaults: { model: "openai/gpt-5.6" } },
          } as never,
          pluginRegistry: createPostAttachParams().pluginRegistry,
          defaultWorkspaceDir: "/tmp/openclaw-workspace",
          deps: {} as never,
          startChannels: vi.fn(async () => {}),
          log: { warn: vi.fn() },
          logHooks: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
          logChannels,
          startupTrace: trace.startupTrace,
          prewarmPrimaryModel,
          onChannelsStarted,
        });
      },
    );

    await waitForGatewayTestState(() => {
      expect(prewarmPrimaryModel).toHaveBeenCalledOnce();
    });
    expect(trace.measures).toContain("sidecars.channels");
    expect(trace.measures).toContain("sidecars.channel-skip");
    expect(prewarmPrimaryModel).toHaveBeenCalledWith(
      expect.objectContaining({ startupTrace: trace.startupTrace }),
    );
    expect(logChannels.info).toHaveBeenCalledWith(
      "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
    expect(onChannelsStarted).toHaveBeenCalledOnce();
  });

  it("records prepared runtime build grouping in the startup trace", async () => {
    const trace = createStartupTraceRecorder();

    await startGatewaySidecars({
      cfg: { hooks: { internal: { enabled: false } } } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: { info: vi.fn(), error: vi.fn() },
      startupTrace: trace.startupTrace,
    });

    const options = hoisted.refreshPreparedModelRuntimeSnapshots.mock.calls[0]?.[1] as
      | {
          onBuildStats?: (stats: {
            agentCount: number;
            workspaceGroupCount: number;
            configuredFactsGroupCount: number;
            catalogSourceCount: number;
            credentialGroupCount: number;
            catalogGroupCount: number;
            runtimeRegistryCount: number;
            configuredRuntimeModelCount: number;
            generatedCatalogPluginCount: number;
            generatedCatalogReadCount: number;
            workspaceFactsMs: number;
            runtimePluginMs: number;
            pluginMetadataMs: number;
            staticProviderCatalogMs: number;
            ambientCredentialsMs: number;
            agentFactsMs: number;
            configuredProjectionMs: number;
            catalogSourceMs: number;
            registryMs: number;
            sourceConcurrencyLimit: number;
            fullCatalogConcurrencyLimit: number;
          }) => void;
        }
      | undefined;
    options?.onBuildStats?.({
      agentCount: 12,
      workspaceGroupCount: 2,
      configuredFactsGroupCount: 2,
      catalogSourceCount: 0,
      credentialGroupCount: 1,
      catalogGroupCount: 0,
      runtimeRegistryCount: 12,
      configuredRuntimeModelCount: 2,
      generatedCatalogPluginCount: 0,
      generatedCatalogReadCount: 0,
      workspaceFactsMs: 120,
      runtimePluginMs: 0,
      pluginMetadataMs: 40,
      staticProviderCatalogMs: 50,
      ambientCredentialsMs: 10,
      agentFactsMs: 5,
      configuredProjectionMs: 15,
      catalogSourceMs: 0,
      registryMs: 30,
      sourceConcurrencyLimit: 2,
      fullCatalogConcurrencyLimit: 1,
    });

    expect(trace.details).toContainEqual({
      name: "sidecars.model-runtime-build",
      metrics: [
        ["agentCount", 12],
        ["workspaceGroupCount", 2],
        ["configuredFactsGroupCount", 2],
        ["catalogSourceCount", 0],
        ["credentialGroupCount", 1],
        ["catalogGroupCount", 0],
        ["runtimeRegistryCount", 12],
        ["configuredRuntimeModelCount", 2],
        ["generatedCatalogPluginCount", 0],
        ["generatedCatalogReadCount", 0],
        ["workspaceFactsMs", 120],
        ["runtimePluginMs", 0],
        ["pluginMetadataMs", 40],
        ["staticProviderCatalogMs", 50],
        ["ambientCredentialsMs", 10],
        ["agentFactsMs", 5],
        ["configuredProjectionMs", 15],
        ["catalogSourceMs", 0],
        ["registryMs", 30],
        ["sourceConcurrencyLimitCount", 2],
        ["fullCatalogConcurrencyLimitCount", 1],
      ],
    });
  });

  it("passes a current-config supplier after loading the prepared runtime", async () => {
    const initialConfig = { ui: { theme: "light" } } as never;
    const nextConfig = { ui: { theme: "dark" } } as never;
    let currentConfig = initialConfig;

    const publication = testing.publishConfiguredModelRuntimeSnapshots({
      cfg: initialConfig,
      getConfig: () => currentConfig,
      log: { warn: vi.fn() },
    } as never);
    currentConfig = nextConfig;
    await publication;

    const getConfig = hoisted.refreshPreparedModelRuntimeSnapshots.mock.calls[0]?.[0];
    expect(getConfig).toBeTypeOf("function");
    await expect(Promise.resolve((getConfig as () => unknown)())).resolves.toBe(nextConfig);
  });

  it("hydrates external CLI auth from the config supplied to model publication", async () => {
    const initialConfig = { ui: { theme: "light" } } as never;
    const nextConfig = { ui: { theme: "dark" } } as never;
    let currentConfig = initialConfig;
    const depsReady = createDeferred<{
      listAgentIds: () => string[];
      resolveAgentDir: () => string;
      collectConfiguredRefs: ReturnType<typeof vi.fn>;
      hydrate: ReturnType<typeof vi.fn>;
    }>();
    const collectConfiguredRefs = vi.fn(() => [{ value: "openai/gpt-5.4" }]);
    const hydrate = vi.fn();

    const hydration = testing.hydrateConfiguredExternalCliAuth({
      getConfig: () => currentConfig,
      log: { warn: vi.fn() },
      deps: depsReady.promise,
    } as never);
    currentConfig = nextConfig;
    depsReady.resolve({
      listAgentIds: () => ["default"],
      resolveAgentDir: () => "/tmp/default-agent",
      collectConfiguredRefs,
      hydrate,
    });

    await expect(hydration).resolves.toBe(nextConfig);
    expect(collectConfiguredRefs).toHaveBeenCalledWith(nextConfig, "default");
    expect(hydrate).toHaveBeenCalledWith(nextConfig, "/tmp/default-agent", ["openai"]);
  });

  it("drops a stale plugin generation after loading the prepared runtime", async () => {
    let current = true;
    const publication = testing.publishConfiguredModelRuntimeSnapshots({
      cfg: {},
      isCurrent: () => current,
      log: { warn: vi.fn() },
    } as never);
    current = false;

    await publication;

    expect(hoisted.refreshPreparedModelRuntimeSnapshots).not.toHaveBeenCalled();
  });

  it("threads plugin claim loss through async model config publication", async () => {
    const configStarted = createDeferred();
    const releaseConfig = createDeferred();
    let current = true;
    hoisted.refreshPreparedModelRuntimeSnapshots.mockImplementationOnce(
      async (getConfig: unknown, options: unknown) => {
        expect(getConfig).toBeTypeOf("function");
        const config = (getConfig as () => Promise<unknown>)();
        await configStarted.promise;
        expect(options).toMatchObject({ isPublicationCurrent: expect.any(Function) });
        await config;
        expect((options as { isPublicationCurrent: () => boolean }).isPublicationCurrent()).toBe(
          false,
        );
      },
    );
    const publication = testing.publishConfiguredModelRuntimeSnapshots({
      cfg: {},
      getConfig: async () => {
        configStarted.resolve();
        await releaseConfig.promise;
        return {};
      },
      isCurrent: () => current,
      log: { warn: vi.fn() },
    } as never);

    await configStarted.promise;
    current = false;
    releaseConfig.resolve();
    await publication;

    expect(hoisted.refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledOnce();
  });

  it("prepares the model runtime with the active Gateway plugin registry", async () => {
    const pluginRegistry = createPostAttachParams().pluginRegistry;
    const prewarmPrimaryModel = vi.fn(async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
    });

    await startGatewaySidecars({
      cfg: { hooks: { internal: { enabled: false } } } as never,
      pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      prewarmPrimaryModel,
    });

    expect(prewarmPrimaryModel).toHaveBeenCalledOnce();
    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  });

  it("marks startup main-session orphans before model runtime and channel startup", async () => {
    const events: string[] = [];
    let releaseMarking: (() => void) | undefined;
    const prewarmPrimaryModel = vi.fn(async () => {
      events.push("model-runtime");
    });
    const startChannels = vi.fn(async () => {
      events.push("channels");
    });
    hoisted.markStartupOrphanedMainSessionsForRecovery.mockImplementationOnce(
      async () =>
        await new Promise<{ marked: number; skipped: number }>((resolve) => {
          events.push("main-session-mark:start");
          releaseMarking = () => {
            events.push("main-session-mark:done");
            resolve({ marked: 1, skipped: 0 });
          };
        }),
    );

    const sidecars = startGatewaySidecars({
      cfg: { hooks: { internal: { enabled: false } } } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels,
      prewarmPrimaryModel,
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    await waitForGatewayTestState(() => {
      expect(events).toEqual(["main-session-mark:start"]);
    });
    expect(startChannels).not.toHaveBeenCalled();

    if (!releaseMarking) {
      throw new Error("Expected marker release callback to be initialized");
    }
    releaseMarking();
    await sidecars;

    expect(events).toEqual([
      "main-session-mark:start",
      "main-session-mark:done",
      "model-runtime",
      "channels",
    ]);
    expect(prewarmPrimaryModel).toHaveBeenCalledTimes(1);
    expect(startChannels).toHaveBeenCalledTimes(1);
    expect(hoisted.scheduleRestartAbortedMainSessionRecovery).not.toHaveBeenCalled();
  });

  it("skips model publication when the startup plugin generation loses ownership", async () => {
    let current = true;
    let releaseMarking: (() => void) | undefined;
    hoisted.markStartupOrphanedMainSessionsForRecovery.mockImplementationOnce(
      async () =>
        await new Promise<{ marked: number; skipped: number }>((resolve) => {
          releaseMarking = () => resolve({ marked: 0, skipped: 0 });
        }),
    );
    const prewarmPrimaryModel = vi.fn(async () => {});
    const sidecars = startGatewaySidecars({
      cfg: {},
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      prewarmPrimaryModel,
      pluginRuntimeClaim: {
        isCurrent: () => current,
        waitForUnblocked: async () => current,
        publish: () => current,
      },
    });
    await waitForGatewayTestState(() => expect(releaseMarking).toBeDefined());
    current = false;
    releaseMarking?.();

    await sidecars;

    expect(prewarmPrimaryModel).not.toHaveBeenCalled();
  });

  it("awaits reply runtime after model publication and before channels and readiness", async () => {
    const events: string[] = [];
    let releaseReplyRuntime: (() => void) | undefined;
    const trace = createStartupTraceRecorder();
    hoisted.refreshPreparedModelRuntimeSnapshots.mockImplementationOnce(async () => {
      events.push("model-runtime");
    });
    hoisted.prewarmConfigDrivenReplyRuntime.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          events.push("reply-runtime:start");
          releaseReplyRuntime = () => {
            events.push("reply-runtime:done");
            resolve();
          };
        }),
    );
    const startChannels = vi.fn(async () => {
      events.push("channels");
    });
    const onSidecarsReady = vi.fn(() => {
      events.push("ready");
    });

    const startup = startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      startChannels,
      onSidecarsReady,
      startupTrace: trace.startupTrace,
    });

    await waitForGatewayTestState(() => {
      expect(events).toEqual(["model-runtime", "reply-runtime:start"]);
    });
    expect(startChannels).not.toHaveBeenCalled();
    expect(onSidecarsReady).not.toHaveBeenCalled();

    if (!releaseReplyRuntime) {
      throw new Error("Expected reply runtime release callback to be initialized");
    }
    releaseReplyRuntime();
    await startup;

    expect(events).toEqual([
      "model-runtime",
      "reply-runtime:start",
      "reply-runtime:done",
      "channels",
      "ready",
    ]);
    expect(trace.measures).toContain("sidecars.reply-runtime");
  });

  it("does not start channels when close begins during deferred sidecar preparation", async () => {
    let closeStarted = false;
    let releaseReplyRuntime: (() => void) | undefined;
    hoisted.prewarmConfigDrivenReplyRuntime.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseReplyRuntime = resolve;
        }),
    );
    const startChannels = vi.fn(async () => {});
    const onChannelsStarted = vi.fn();
    const unlockStartupMethods = vi.fn();
    const runtime = await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      sidecarStartup: "defer",
      isClosing: () => closeStarted,
      startChannels,
      onChannelsStarted,
      unlockStartupMethods,
    });

    await waitForGatewayTestState(() => {
      expect(releaseReplyRuntime).toBeTypeOf("function");
    });
    closeStarted = true;
    releaseReplyRuntime?.();
    await expect(runtime.startupSettled).resolves.toBeUndefined();

    expect(startChannels).not.toHaveBeenCalled();
    expect(onChannelsStarted).not.toHaveBeenCalled();
    expect(unlockStartupMethods).not.toHaveBeenCalled();
  });

  it("marks startup main-session orphans before propagating model runtime failure", async () => {
    const modelRuntimeError = new Error("model runtime unavailable");
    const startChannels = vi.fn(async () => {});
    const prewarmPrimaryModel = vi.fn(async () => {
      throw modelRuntimeError;
    });
    hoisted.markStartupOrphanedMainSessionsForRecovery.mockResolvedValueOnce({
      marked: 1,
      skipped: 0,
    });

    await expect(
      startGatewaySidecars({
        cfg: { hooks: { internal: { enabled: false } } } as never,
        pluginRegistry: createPostAttachParams().pluginRegistry,
        defaultWorkspaceDir: "/tmp/openclaw-workspace",
        deps: {} as never,
        startChannels,
        prewarmPrimaryModel,
        log: { warn: vi.fn() },
        logHooks: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        logChannels: {
          info: vi.fn(),
          error: vi.fn(),
        },
      }),
    ).rejects.toBe(modelRuntimeError);

    expect(hoisted.markStartupOrphanedMainSessionsForRecovery).toHaveBeenCalledTimes(1);
    expect(prewarmPrimaryModel).toHaveBeenCalledTimes(1);
    expect(startChannels).not.toHaveBeenCalled();
  });

  it("logs startup main-session marker failures and still starts channels", async () => {
    const log = { warn: vi.fn() };
    const startChannels = vi.fn(async () => {});
    hoisted.markStartupOrphanedMainSessionsForRecovery.mockRejectedValueOnce(
      new Error("store unreadable"),
    );

    await startGatewaySidecars({
      cfg: { hooks: { internal: { enabled: false } } } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels,
      log,
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(log.warn).toHaveBeenCalledWith(
      "main-session startup orphan marking failed before channel startup: Error: store unreadable",
    );
    expect(hoisted.scheduleRestartAbortedMainSessionRecovery).not.toHaveBeenCalled();
    expect(startChannels).toHaveBeenCalledTimes(1);
  });

  it("emits a sidecar readiness summary in startup trace details", async () => {
    const trace = createStartupTraceRecorder();

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams({
        startupTrace: trace.startupTrace,
      }),
    });

    expect(trace.marks).toContain("sidecars.ready");
    expect(trace.details).toContainEqual({
      name: "sidecars.ready",
      metrics: [
        ["loadedPluginCount", 2],
        ["postReadySidecarCount", 3],
      ],
    });
  });

  it("runs Gmail watcher after sidecars are ready", async () => {
    let resolveWatcher: (() => void) | undefined;
    let watcherSignal: AbortSignal | undefined;
    hoisted.startGmailWatcherWithLogs.mockImplementationOnce(
      async (...args: unknown[]) =>
        await new Promise<void>((resolve) => {
          const [params] = args as [{ signal?: AbortSignal }];
          watcherSignal = params.signal;
          resolveWatcher = resolve;
        }),
    );
    let sidecarStartReturned = false;
    const onPostReadySidecars = vi.fn();
    const log = { warn: vi.fn() };

    const result = await startGatewaySidecars({
      cfg: {
        hooks: { enabled: true, internal: { enabled: false }, gmail: { account: "me" } },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      onPostReadySidecars: (sidecars) => {
        expect(sidecarStartReturned).toBe(false);
        onPostReadySidecars(sidecars);
      },
      log,
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });
    sidecarStartReturned = true;

    expect(result.postReadySidecars).toHaveLength(2);
    expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
    expect(onPostReadySidecars).toHaveBeenCalledWith(result.postReadySidecars);

    await waitForGatewayTestState(() => {
      expect(hoisted.startGmailWatcherWithLogs).toHaveBeenCalledTimes(1);
    });
    expect(watcherSignal?.aborted).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();

    if (!resolveWatcher) {
      throw new Error("Expected gmail watcher resolver to be initialized");
    }
    for (const sidecar of result.postReadySidecars) {
      await stopTrackedSidecar(sidecar);
    }
    expect(watcherSignal?.aborted).toBe(true);
    resolveWatcher();
  });

  it("does not create post-ready sidecars after close begins during channel startup", async () => {
    let releaseChannels: (() => void) | undefined;
    let closeStarted = false;
    const startChannels = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseChannels = resolve;
        }),
    );
    const onPostReadySidecars = vi.fn();

    const sidecarsPromise = startGatewaySidecars({
      cfg: {
        hooks: { enabled: true, internal: { enabled: false }, gmail: { account: "me" } },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels,
      shouldCreatePostReadySidecars: () => !closeStarted,
      onPostReadySidecars,
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    await waitForGatewayTestState(() => {
      expect(startChannels).toHaveBeenCalledTimes(1);
      expect(releaseChannels).toBeDefined();
    });
    closeStarted = true;
    releaseChannels?.();

    const result = await sidecarsPromise;
    expect(result.postReadySidecars).toEqual([]);
    expect(onPostReadySidecars).not.toHaveBeenCalled();
    expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
  });

  it("logs post-ready Gmail watcher failures without delaying sidecar readiness", async () => {
    const log = { warn: vi.fn() };
    hoisted.startGmailWatcherWithLogs.mockRejectedValueOnce(new Error("boom"));

    const result = await startGatewaySidecars({
      cfg: {
        hooks: { enabled: true, internal: { enabled: false }, gmail: { account: "me" } },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log,
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.postReadySidecars).toHaveLength(2);
    await waitForGatewayTestState(() => {
      expect(log.warn).toHaveBeenCalledWith(
        "sidecars.gmail-watch failed after gateway ready: Error: boom",
      );
    });
  });

  it("cancels a post-ready Gmail watcher before the immediate starts", async () => {
    const result = await startGatewaySidecars({
      cfg: {
        hooks: { enabled: true, internal: { enabled: false }, gmail: { account: "me" } },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.postReadySidecars).toHaveLength(2);
    for (const sidecar of result.postReadySidecars) {
      await stopTrackedSidecar(sidecar);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
  });

  it("cancels a post-ready Gmail watcher after the immediate enters", async () => {
    let releaseImport: (() => void) | undefined;
    vi.doMock("../hooks/gmail-watcher-lifecycle.js", async () => {
      await new Promise<void>((resolve) => {
        releaseImport = resolve;
      });
      return {
        startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
      };
    });
    vi.resetModules();
    try {
      const { startGatewaySidecars: startGatewaySidecarsWithDelayedImport } =
        await import("./server-startup-post-attach.js");

      const result = adoptPostReadyResult(
        await startGatewaySidecarsWithDelayedImport({
          cfg: {
            hooks: { enabled: true, internal: { enabled: false }, gmail: { account: "me" } },
          } as never,
          pluginRegistry: createPostAttachParams().pluginRegistry,
          defaultWorkspaceDir: "/tmp/openclaw-workspace",
          deps: {} as never,
          startChannels: vi.fn(async () => {}),
          log: { warn: vi.fn() },
          logHooks: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
          logChannels: {
            info: vi.fn(),
            error: vi.fn(),
          },
        }),
      );

      await waitForGatewayTestState(() => {
        expect(releaseImport).toBeDefined();
      });
      for (const sidecar of result.postReadySidecars) {
        await stopTrackedSidecar(sidecar);
      }
      releaseImport?.();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(hoisted.startGmailWatcherWithLogs).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../hooks/gmail-watcher-lifecycle.js");
      vi.resetModules();
    }
  });

  it("runs Gmail model validation after sidecars are ready", async () => {
    hoisted.resolveHooksGmailModel.mockReturnValueOnce({
      provider: "openai",
      model: "gpt-5.4",
    });
    hoisted.loadModelCatalog.mockImplementationOnce(async (options: unknown) => {
      const scoped = options as {
        readOnly?: boolean;
        providerDiscoveryProviderIds?: string[];
        scopedLiveProviderDiscovery?: boolean;
      };
      if (
        scoped.readOnly !== true ||
        scoped.scopedLiveProviderDiscovery !== true ||
        scoped.providerDiscoveryProviderIds?.[0] !== "openai" ||
        scoped.providerDiscoveryProviderIds.length !== 1
      ) {
        return await hoisted.loadFullModelCatalog();
      }
      return [];
    });

    const result = await startGatewaySidecars({
      cfg: {
        hooks: { internal: { enabled: false }, gmail: { model: "openai/gpt-5.4" } },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.postReadySidecars).toHaveLength(2);
    expect(hoisted.loadModelCatalog).not.toHaveBeenCalled();

    await waitForGatewayTestState(() => {
      expect(hoisted.loadModelCatalog).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.loadFullModelCatalog).not.toHaveBeenCalled();
    expect(hoisted.loadModelCatalog).toHaveBeenCalledWith({
      config: expect.any(Object),
      readOnly: true,
      providerDiscoveryProviderIds: ["openai"],
      scopedLiveProviderDiscovery: true,
    });
    expect(hoisted.getModelRefStatus).toHaveBeenCalledWith(
      expect.objectContaining({ ref: { provider: "openai", model: "gpt-5.4" } }),
    );
  });

  it("keeps startup-gated methods unavailable while sidecars are still resuming", async () => {
    let resumeSidecars: (() => void) | undefined;
    const sidecarsReady = new Promise<{ pluginServices: null; postReadySidecars: [] }>(
      (resolve) => {
        resumeSidecars = () => resolve({ pluginServices: null, postReadySidecars: [] });
      },
    );
    const startGatewaySidecarsValue = vi.fn(async () => {
      return await sidecarsReady;
    });
    const unavailableGatewayMethods = new Set<string>(STARTUP_UNAVAILABLE_GATEWAY_METHODS);

    await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams(),
        unlockStartupMethods: createStartupMethodUnlocker(unavailableGatewayMethods),
        sidecarStartup: "defer",
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsValue }),
    );

    await waitForGatewayTestState(
      () => {
        expect(startGatewaySidecarsValue).toHaveBeenCalledTimes(1);
      },
      { timeout: 10_000 },
    );

    expect([...unavailableGatewayMethods]).toEqual([...STARTUP_UNAVAILABLE_GATEWAY_METHODS]);
    expect(hoisted.startPluginServices).not.toHaveBeenCalled();

    if (!resumeSidecars) {
      throw new Error("Expected gateway sidecar resume callback to be initialized");
    }
    resumeSidecars();
    await waitForGatewayTestState(() => {
      expect([...unavailableGatewayMethods]).toStrictEqual([]);
    });
    expect([...unavailableGatewayMethods]).toStrictEqual([]);
    expect(startGatewaySidecarsValue).toHaveBeenCalledTimes(1);
  });

  it("warms the CA cache before worker placement and sidecar startup", async () => {
    let finishWarmup: (() => void) | undefined;
    const warmupReady = new Promise<void>((resolve) => {
      finishWarmup = resolve;
    });
    let finishReconcile: (() => void) | undefined;
    const reconcileReady = new Promise<void>((resolve) => {
      finishReconcile = resolve;
    });
    const startupOrder: string[] = [];
    const warmSystemCa = vi.fn(async () => {
      startupOrder.push("ca-warmup");
      await warmupReady;
      startupOrder.push("ca-ready");
    });
    const workerSidecar = { stop: vi.fn() };
    const onGatewayLifetimeSidecars = vi.fn();
    const startWorkerEnvironmentRuntime = vi.fn(async () => {
      startupOrder.push("worker-reconcile");
      adoptSidecars(publishedConnectionDependentSidecars, [workerSidecar]);
      await reconcileReady;
      startupOrder.push("worker-ready");
      return workerSidecar;
    });
    const startGatewaySidecarsValue = vi.fn(async () => {
      startupOrder.push("gateway-sidecars");
      return {
        pluginServices: null,
        postReadySidecars: [],
      };
    });
    const unavailableGatewayMethods = new Set<string>(STARTUP_UNAVAILABLE_GATEWAY_METHODS);

    const runtimePromise = startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams(),
        unlockStartupMethods: createStartupMethodUnlocker(unavailableGatewayMethods),
        sidecarStartup: "defer",
        startWorkerEnvironmentRuntime,
        onGatewayLifetimeSidecars,
      },
      createPostAttachRuntimeDeps({
        startGatewaySidecars: startGatewaySidecarsValue,
        warmSystemCa,
      }),
    );

    await waitForGatewayTestState(() => {
      expect(warmSystemCa).toHaveBeenCalledTimes(1);
    });
    expect(startWorkerEnvironmentRuntime).not.toHaveBeenCalled();
    expect(startGatewaySidecarsValue).not.toHaveBeenCalled();
    expect(startupOrder).toEqual(["ca-warmup"]);

    finishWarmup?.();
    await runtimePromise;
    await waitForGatewayTestState(() => {
      expect(startWorkerEnvironmentRuntime).toHaveBeenCalledTimes(1);
    });
    expect(startGatewaySidecarsValue).not.toHaveBeenCalled();
    expect(startupOrder).toEqual(["ca-warmup", "ca-ready", "worker-reconcile"]);
    expect([...unavailableGatewayMethods]).toEqual([...STARTUP_UNAVAILABLE_GATEWAY_METHODS]);

    finishReconcile?.();
    await waitForGatewayTestState(() => {
      expect(startGatewaySidecarsValue).toHaveBeenCalledTimes(1);
    });
    expect(startupOrder).toEqual([
      "ca-warmup",
      "ca-ready",
      "worker-reconcile",
      "worker-ready",
      "gateway-sidecars",
    ]);
    expect([...unavailableGatewayMethods]).toEqual([]);
    expect(publishedConnectionDependentSidecars.has(workerSidecar)).toBe(true);
    expect(onGatewayLifetimeSidecars).not.toHaveBeenCalledWith([workerSidecar]);
  });

  it("stops worker placement runtime when channel and sidecar startup fails", async () => {
    const cleanupError = new Error("worker cleanup failed");
    const workerSidecar = {
      stop: vi.fn().mockRejectedValueOnce(cleanupError).mockResolvedValue(undefined),
    };
    const startupError = new Error("sidecar startup failed");
    const onGatewayLifetimeSidecars = vi.fn();
    const unregisterConnectionDependentSidecar = vi.fn();
    const params = createPostAttachParams({
      onGatewayLifetimeSidecars,
      unregisterConnectionDependentSidecar,
    });

    await expect(
      startGatewayPostAttachRuntime(
        {
          ...params,
          startWorkerEnvironmentRuntime: vi.fn(() => {
            adoptSidecars(publishedConnectionDependentSidecars, [workerSidecar]);
            return workerSidecar;
          }),
        },
        createPostAttachRuntimeDeps({
          startGatewaySidecars: vi.fn(async () => {
            throw startupError;
          }),
        }),
      ),
    ).rejects.toBe(startupError);

    expect(workerSidecar.stop).toHaveBeenCalledTimes(1);
    expect(publishedConnectionDependentSidecars.has(workerSidecar)).toBe(true);
    expect(onGatewayLifetimeSidecars).not.toHaveBeenCalledWith([workerSidecar]);
    expect(unregisterConnectionDependentSidecar).not.toHaveBeenCalled();
    expect(params.log.warn).toHaveBeenCalledWith(
      `worker environment cleanup after sidecar startup failure failed: ${String(cleanupError)}`,
    );

    await stopTrackedSidecars(publishedConnectionDependentSidecars);
    expect(workerSidecar.stop).toHaveBeenCalledTimes(2);
  });

  it("stops worker placement once when close begins while it starts", async () => {
    let closeStarted = false;
    let releaseWorkerStart: (() => void) | undefined;
    const workerStartBlocked = new Promise<void>((resolve) => {
      releaseWorkerStart = resolve;
    });
    let markWorkerStart: (() => void) | undefined;
    const workerStartReached = new Promise<void>((resolve) => {
      markWorkerStart = resolve;
    });
    const workerSidecar = { stop: vi.fn(async () => {}) };
    const startGatewaySidecarsValue = vi.fn();
    const runtimePromise = startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams(),
        isClosing: () => closeStarted,
        startWorkerEnvironmentRuntime: vi.fn(async () => {
          markWorkerStart?.();
          await workerStartBlocked;
          await workerSidecar.stop();
          return null;
        }),
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsValue }),
    );

    await workerStartReached;
    closeStarted = true;
    releaseWorkerStart?.();
    await runtimePromise;

    expect(workerSidecar.stop).toHaveBeenCalledOnce();
    expect(startGatewaySidecarsValue).not.toHaveBeenCalled();
  });

  it("keeps ignored deferred sidecar failure handled for direct callers", async () => {
    const startupError = new Error("deferred sidecar startup failed");
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const params = createPostAttachParams({ sidecarStartup: "defer" });
      const runtime = await startGatewayPostAttachRuntime(
        params,
        createPostAttachRuntimeDeps({
          startGatewaySidecars: vi.fn(async () => {
            throw startupError;
          }),
        }),
      );

      await waitForGatewayTestState(() => {
        expect(params.log.warn).toHaveBeenCalledWith(
          `gateway sidecars failed to start: ${String(startupError)}`,
        );
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toStrictEqual([]);
      await expect(runtime.startupSettled).rejects.toBe(startupError);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("retires unadopted startup plugins when close begins during deferred loading", async () => {
    let closeStarted = false;
    const pluginLoadStarted = createDeferred();
    const pluginLoadReady = createDeferred();
    const retireGatewayRuntimeBindings = vi.fn();
    const onStartupPluginsLoaded = vi.fn();
    const startGatewaySidecarsValue = vi.fn(async () => ({
      pluginServices: null,
      postReadySidecars: [],
    }));
    const runtime = await startGatewayPostAttachRuntime(
      createPostAttachParams({
        sidecarStartup: "defer",
        isClosing: () => closeStarted,
        loadStartupPlugins: async () => {
          pluginLoadStarted.resolve();
          await pluginLoadReady.promise;
          return {
            pluginRegistry: createPostAttachParams().pluginRegistry,
            gatewayMethods: [],
            retireGatewayRuntimeBindings,
          };
        },
        onStartupPluginsLoaded,
      }),
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsValue }),
    );

    await pluginLoadStarted.promise;
    closeStarted = true;
    pluginLoadReady.resolve();
    await expect(runtime.startupSettled).resolves.toBeUndefined();

    expect(retireGatewayRuntimeBindings).toHaveBeenCalledOnce();
    expect(onStartupPluginsLoaded).not.toHaveBeenCalled();
    expect(startGatewaySidecarsValue).not.toHaveBeenCalled();
  });

  it("does not start the worker environment sidecar after close begins", async () => {
    const startWorkerEnvironmentRuntime = vi.fn(() => ({ stop: vi.fn() }));
    const startGatewaySidecarsValue = vi.fn(async () => ({
      pluginServices: null,
      postReadySidecars: [],
    }));

    const runtime = await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams(),
        sidecarStartup: "defer",
        startWorkerEnvironmentRuntime,
        isClosing: () => true,
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsValue }),
    );

    await runtime.startupSettled;
    expect(startGatewaySidecarsValue).not.toHaveBeenCalled();
    expect(startWorkerEnvironmentRuntime).not.toHaveBeenCalled();
  });

  it("does not activate restored recovery when close begins during activation loading", async () => {
    let closeStarted = false;
    let releaseRecoveryLoad: (() => void) | undefined;
    const recoveryLoadReady = new Promise<void>((resolve) => {
      releaseRecoveryLoad = resolve;
    });
    let markRecoveryLoadStarted: (() => void) | undefined;
    const recoveryLoadStarted = new Promise<void>((resolve) => {
      markRecoveryLoadStarted = resolve;
    });
    const pluginServices: PluginServicesHandle = {
      reload: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const postReadySidecar = { stop: vi.fn(async () => {}) };
    const workerSidecar = { stop: vi.fn(async () => {}) };
    const unlockStartupMethods = vi.fn();
    const activateSubagentRegistry = vi.fn();
    const onPluginServices = vi.fn();
    const onGatewayLifetimeSidecars = vi.fn();
    const runtime = await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams(),
        sidecarStartup: "defer",
        isClosing: () => closeStarted,
        startWorkerEnvironmentRuntime: vi.fn(() => {
          adoptSidecars(publishedConnectionDependentSidecars, [workerSidecar]);
          return workerSidecar;
        }),
        onGatewayLifetimeSidecars,
        unlockStartupMethods,
        onPluginServices,
      },
      createPostAttachRuntimeDeps({
        startGatewaySidecars: vi.fn(
          async (params: Parameters<typeof startGatewaySidecarsImpl>[0]) => {
            params.onPostReadySidecars?.([postReadySidecar]);
            params.onPluginServices?.(pluginServices);
            return { pluginServices, postReadySidecars: [postReadySidecar] };
          },
        ),
        loadSubagentRegistryActivation: vi.fn(async () => {
          markRecoveryLoadStarted?.();
          await recoveryLoadReady;
          return activateSubagentRegistry;
        }),
      }),
    );

    await recoveryLoadStarted;
    closeStarted = true;
    releaseRecoveryLoad?.();
    await expect(runtime.startupSettled).resolves.toBeUndefined();

    expect(activateSubagentRegistry).not.toHaveBeenCalled();
    expect(unlockStartupMethods).toHaveBeenCalledOnce();
    expect(workerSidecar.stop).not.toHaveBeenCalled();
    expect(publishedConnectionDependentSidecars.has(workerSidecar)).toBe(true);
    expect(pluginServices.stop).not.toHaveBeenCalled();
    expect(postReadySidecar.stop).not.toHaveBeenCalled();
    expect(onPluginServices).toHaveBeenLastCalledWith(pluginServices);
    await stopTrackedSidecars(publishedConnectionDependentSidecars);
    await stopTrackedSidecars(publishedPostReadySidecars);
    await pluginServices.stop();
    expect(workerSidecar.stop).toHaveBeenCalledOnce();
    expect(postReadySidecar.stop).toHaveBeenCalledOnce();
    expect(pluginServices.stop).toHaveBeenCalledOnce();
  });

  it("returns before loading startup plugins with deferred sidecars", async () => {
    const pluginRegistry = {
      plugins: [{ id: "lazy", status: "loaded" }],
      typedHooks: [],
    } as never;
    const loaded = { pluginRegistry, gatewayMethods: ["core.ping"] };
    let releasePluginLoad: (() => void) | undefined;
    const pluginLoadReady = new Promise<void>((resolve) => {
      releasePluginLoad = resolve;
    });
    const loadStartupPlugins = vi.fn(async () => {
      await pluginLoadReady;
      return loaded;
    });
    const onStartupPluginsLoaded = vi.fn();
    const startGatewaySidecarsLocal = vi.fn(async () => ({
      pluginServices: null,
      postReadySidecars: [],
    }));
    let returned = false;

    const runtimePromise = startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams({
          sidecarStartup: "defer",
          loadStartupPlugins,
          onStartupPluginsLoaded,
        }),
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsLocal }),
    ).then(() => {
      returned = true;
    });

    await waitForGatewayTestState(() => expect(loadStartupPlugins).toHaveBeenCalledTimes(1));
    expect(returned).toBe(true);
    expect(onStartupPluginsLoaded).not.toHaveBeenCalled();
    expect(startGatewaySidecarsLocal).not.toHaveBeenCalled();

    releasePluginLoad?.();
    await runtimePromise;
    await waitForGatewayTestState(() => {
      expect(onStartupPluginsLoaded).toHaveBeenCalledWith(loaded);
      expect(startGatewaySidecarsLocal).toHaveBeenCalledTimes(1);
    });
  });

  it("dispatches registered gateway startup internal hooks without configured hook packs", async () => {
    vi.useFakeTimers();
    hoisted.hasInternalHookListeners.mockReturnValue(true);
    let releaseHook = () => {};
    hoisted.triggerInternalHook.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseHook = resolve;
        }),
    );
    const cfg = {} as never;
    const deps = {} as never;

    try {
      await startGatewaySidecars({
        cfg,
        pluginRegistry: createPostAttachParams().pluginRegistry,
        defaultWorkspaceDir: "/tmp/openclaw-workspace",
        deps,
        startChannels: vi.fn(async () => {}),
        log: { warn: vi.fn() },
        logHooks: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        logChannels: {
          info: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(hoisted.commitInternalHooks).toHaveBeenCalledWith({ initial: true });
      expect(hoisted.hasInternalHookListeners).toHaveBeenCalledWith("gateway", "startup");

      await vi.advanceTimersByTimeAsync(250);

      expect(hoisted.createInternalHookEvent).toHaveBeenCalledWith(
        "gateway",
        "startup",
        "gateway:startup",
        {
          cfg,
          deps,
          workspaceDir: "/tmp/openclaw-workspace",
        },
      );
      expect(hoisted.triggerInternalHook).toHaveBeenCalledWith(hoisted.startupHookEvent);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      releaseHook();
      await waitForGatewayTestState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      releaseHook();
      vi.useRealTimers();
    }
  });

  it("cancels registered gateway startup hooks when close starts", async () => {
    vi.useFakeTimers();
    hoisted.hasInternalHookListeners.mockReturnValue(true);
    const trace = createStartupTraceRecorder();
    let releasePostReadyWork!: () => void;
    const postReadyWork = new Promise<void>((resolve) => {
      releasePostReadyWork = resolve;
    });

    const result = await startGatewaySidecars({
      cfg: {} as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
      startupTrace: trace.startupTrace,
      waitForPostReadyWork: () => postReadyWork,
    });

    expect(result.postReadySidecars).toHaveLength(2);
    for (const sidecar of result.postReadySidecars) {
      await stopTrackedSidecar(sidecar);
    }
    releasePostReadyWork();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(hoisted.createInternalHookEvent).not.toHaveBeenCalled();
    expect(hoisted.triggerInternalHook).not.toHaveBeenCalled();
    expect(trace.measures).not.toContain("sidecars.session-locks");
    expect(trace.measures).not.toContain("sidecars.restart-sentinel");
  });

  it("waits for a healthy ACP runtime backend before startup identity reconcile", async () => {
    const trace = createStartupTraceRecorder();
    let healthy = false;
    hoisted.getAcpRuntimeBackend.mockImplementation((id?: string) => ({
      id: id ?? "acpx",
      runtime: {},
      healthy: () => healthy,
    }));

    await startGatewaySidecars({
      cfg: {
        hooks: { internal: { enabled: false } },
        acp: { enabled: true, backend: "acpx" },
      } as never,
      pluginRegistry: createPostAttachParams().pluginRegistry,
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { warn: vi.fn() },
      logHooks: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      logChannels: {
        info: vi.fn(),
        error: vi.fn(),
      },
      startupTrace: trace.startupTrace,
    });

    await waitForGatewayTestState(() => {
      expect(hoisted.getAcpRuntimeBackend).toHaveBeenCalledWith("acpx");
    });
    expect(hoisted.reconcilePendingSessionIdentities).not.toHaveBeenCalled();

    healthy = true;
    await waitForGatewayTestState(() => {
      expect(hoisted.reconcilePendingSessionIdentities).toHaveBeenCalledTimes(1);
    });
    expect(trace.measures).toContain("sidecars.acp.runtime-ready");
    expect(trace.measures).toContain("sidecars.acp.identity-reconcile");
    expect(trace.details).toContainEqual({
      name: "sidecars.acp.runtime-ready",
      metrics: [
        ["readyCount", 1],
        ["backend", "acpx"],
      ],
    });
  });

  it.each([
    { label: "before restart-sentinel refresh starts", closeAfterRefreshStarts: false },
    { label: "during restart-sentinel refresh", closeAfterRefreshStarts: true },
  ])("retains the startup tail when close begins $label", async ({ closeAfterRefreshStarts }) => {
    const refreshStarted = createDeferred();
    const releaseRefresh = createDeferred();
    const connectionWork = new GatewayConnectionWork();
    const events: string[] = [];
    const refreshLatestUpdateRestartSentinel = vi.fn(async () => {
      events.push("refresh-started");
      refreshStarted.resolve();
      await releaseRefresh.promise;
      events.push("refresh-completed");
      return null;
    });
    const trackStartupWork: PostAttachParams["trackStartupWork"] = (run) => {
      const operation = Promise.resolve().then(() => run(connectionWork.signal));
      return connectionWork.track(() => operation);
    };
    const runtime = await trackStartupWork(() =>
      startGatewayPostAttachRuntime(
        createPostAttachParams({
          isClosing: () => connectionWork.isClosing,
          trackStartupWork,
        }),
        createPostAttachRuntimeDeps({ refreshLatestUpdateRestartSentinel }),
      ),
    );

    try {
      if (closeAfterRefreshStarts) {
        await refreshStarted.promise;
      }
      connectionWork.beginClose();
      const closing = connectionWork.drain().then(() => {
        events.push("metadata-retired");
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (closeAfterRefreshStarts) {
        expect.soft(events).toEqual(["refresh-started"]);
      } else {
        expect.soft(refreshLatestUpdateRestartSentinel).not.toHaveBeenCalled();
      }
      releaseRefresh.resolve();
      await runtime.startupSettled;
      await closing;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(events).toEqual(
        closeAfterRefreshStarts
          ? ["refresh-started", "refresh-completed", "metadata-retired"]
          : ["metadata-retired"],
      );
    } finally {
      releaseRefresh.resolve();
      await connectionWork.drain();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  });

  it.each(["sentinel", "gateway_start"] as const)(
    "retires startup %s admission parked behind suspension when the Gateway closes",
    async (stage) => {
      const { createHookRunner } = await import("../plugins/hooks.js");
      const gatewayStart = vi.fn<PluginHookHandlerMap["gateway_start"]>(async () => {});
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.typedHooks.push({
        pluginId: "startup-suspension-test",
        hookName: "gateway_start",
        handler: gatewayStart,
        source: "startup-suspension-test",
      });
      const hookRunner = createHookRunner(pluginRegistry);
      const postReadyWork = createDeferred();
      const hookLoadStarted = createDeferred();
      const releaseHookLoad = createDeferred();
      const connectionWork = new GatewayConnectionWork();
      const refresh = vi.fn(async () => null);
      const sidecarsReady = vi.fn();
      const trackStartupWork: PostAttachParams["trackStartupWork"] = (run) => {
        const operation = Promise.resolve().then(() => run(connectionWork.signal));
        return connectionWork.track(() => operation);
      };
      const runtime = await trackStartupWork(() =>
        startGatewayPostAttachRuntime(
          createPostAttachParams({
            pluginRegistry,
            isClosing: () => connectionWork.isClosing,
            trackStartupWork,
            onSidecarsReady: sidecarsReady,
            waitForPostReadyWork: () => postReadyWork.promise,
          }),
          createPostAttachRuntimeDeps({
            refreshLatestUpdateRestartSentinel: refresh,
            getGlobalHookRunner: async () => {
              hookLoadStarted.resolve();
              if (stage === "gateway_start") {
                await releaseHookLoad.promise;
                return hookRunner;
              }
              return null;
            },
          }),
        ),
      );
      let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
      let closing: Promise<void> | undefined;
      try {
        expect(sidecarsReady).toHaveBeenCalledOnce();
        if (stage === "gateway_start") {
          postReadyWork.resolve();
          await hookLoadStarted.promise;
        }
        suspension = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspension?.commit()).toBe(true);
        postReadyWork.resolve();
        await hookLoadStarted.promise;
        releaseHookLoad.resolve();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        let drained = false;
        connectionWork.beginClose();
        closing = connectionWork.drain().then(() => {
          drained = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect.soft(drained, "startup admission retires without reopening suspension").toBe(true);
        suspension?.release();
        await closing;
        expect(gatewayStart).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(stage === "sentinel" ? 0 : 1);
      } finally {
        suspension?.release();
        postReadyWork.resolve();
        releaseHookLoad.resolve();
        await runtime.startupSettled;
        await connectionWork.drain();
        await closing;
      }
    },
  );

  it("retains gateway_start loading until close can retire plugin metadata", async () => {
    const { createHookRunner } = await import("../plugins/hooks.js");
    const gatewayStart = vi.fn<PluginHookHandlerMap["gateway_start"]>(async () => {});
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.typedHooks.push({
      pluginId: "startup-lifetime-test",
      hookName: "gateway_start",
      handler: gatewayStart,
      source: "startup-lifetime-test",
    });
    const hookRunner = createHookRunner(pluginRegistry);
    const hookLoadStarted = createDeferred();
    const releaseHookLoad = createDeferred();
    const connectionWork = new GatewayConnectionWork();
    const retirePluginMetadata = vi.fn();
    const trackStartupWork: PostAttachParams["trackStartupWork"] = (run) => {
      const operation = Promise.resolve().then(() => run(connectionWork.signal));
      return connectionWork.track(() => operation);
    };
    const runtime = await trackStartupWork(() =>
      startGatewayPostAttachRuntime(
        createPostAttachParams({
          sidecarStartup: "defer",
          pluginRegistry,
          isClosing: () => connectionWork.isClosing,
          trackStartupWork,
        }),
        createPostAttachRuntimeDeps({
          getGlobalHookRunner: async () => {
            hookLoadStarted.resolve();
            await releaseHookLoad.promise;
            return hookRunner;
          },
        }),
      ),
    );

    try {
      await hookLoadStarted.promise;
      connectionWork.beginClose();
      const closing = connectionWork.drain().then(retirePluginMetadata);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect.soft(retirePluginMetadata).not.toHaveBeenCalled();
      releaseHookLoad.resolve();
      await runtime.startupSettled;
      await closing;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(gatewayStart).not.toHaveBeenCalled();
      expect(retirePluginMetadata).toHaveBeenCalledOnce();
    } finally {
      releaseHookLoad.resolve();
      await connectionWork.drain();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  });

  it("passes typed gateway_start context with config, workspace dir, and a live cron getter", async () => {
    const runGatewayStart = vi.fn<
      (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void>
    >(async () => {});
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "gateway_start"),
      runGatewayStart,
    };
    const initialCron = {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      removeStaleJobFamily: vi.fn(),
    };
    const params = createPostAttachParams({
      gatewayPluginConfigAtStart: {
        hooks: { internal: { enabled: false } },
        plugins: { entries: { demo: { enabled: true } } },
      } as never,
      pluginRegistry: {
        ...createPostAttachParams().pluginRegistry,
        typedHooks: [{ hookName: "gateway_start" }],
      } as never,
      deps: { cron: initialCron } as never,
    });

    await startGatewayPostAttachRuntime(
      params,
      createPostAttachRuntimeDeps({
        getGlobalHookRunner: vi.fn(async () => hookRunner as never),
      }),
    );

    await waitForGatewayTestState(() => {
      expect(runGatewayStart).toHaveBeenCalledTimes(1);
    });

    const [event, ctx] = firstGatewayStartCall(runGatewayStart);
    expect(event).toEqual({ port: 18789 });
    expect(ctx.port).toBe(18789);
    expect(ctx.config).toBe(params.gatewayPluginConfigAtStart);
    expect(ctx.workspaceDir).toBe("/tmp/openclaw-workspace");
    const getCron = ctx.getCron;
    if (!getCron) {
      throw new Error("gateway_start context did not expose getCron");
    }
    expect(getCron()).toBe(initialCron);

    const reloadedCron = {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      removeStaleJobFamily: vi.fn(),
    };
    params.deps.cron = reloadedCron as never;
    expect(getCron()).toBe(reloadedCron);
  });

  it("does not resolve the global hook runner when no gateway_start hooks are registered", async () => {
    const getGlobalHookRunner = vi.fn(async () => {
      throw new Error("should not load hook runner");
    });

    await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({ getGlobalHookRunner }),
    );

    expect(getGlobalHookRunner).not.toHaveBeenCalled();
  });

  it("resolves gateway_start cron from the live runtime getter before deps fallback", async () => {
    const runGatewayStart = vi.fn<
      (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void>
    >(async () => {});
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "gateway_start"),
      runGatewayStart,
    };
    const depsCron = {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      removeStaleJobFamily: vi.fn(),
    };
    const liveCron = {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      removeStaleJobFamily: vi.fn(),
    };
    const reloadedCron = {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      removeStaleJobFamily: vi.fn(),
    };
    let currentLiveCron = liveCron;
    const params = createPostAttachParams({
      deps: { cron: depsCron } as never,
      getCronService: () => currentLiveCron,
      pluginRegistry: {
        ...createPostAttachParams().pluginRegistry,
        typedHooks: [{ hookName: "gateway_start" }],
      } as never,
    });

    await startGatewayPostAttachRuntime(
      params,
      createPostAttachRuntimeDeps({
        getGlobalHookRunner: vi.fn(async () => hookRunner as never),
      }),
    );

    await waitForGatewayTestState(() => {
      expect(runGatewayStart).toHaveBeenCalledTimes(1);
    });

    const [, ctx] = firstGatewayStartCall(runGatewayStart);
    if (!ctx?.getCron) {
      throw new Error("gateway_start context did not expose getCron");
    }
    expect(ctx.getCron()).toBe(liveCron);

    params.deps.cron = depsCron as never;
    currentLiveCron = reloadedCron;
    expect(ctx.getCron()).toBe(reloadedCron);
  });
});

function createPostAttachRuntimeDeps(
  overrides: Partial<PostAttachRuntimeDeps> = {},
): PostAttachRuntimeDeps {
  return {
    getGlobalHookRunner: vi.fn(() => null),
    logGatewayStartup: hoisted.logGatewayStartup,
    refreshLatestUpdateRestartSentinel: hoisted.refreshLatestUpdateRestartSentinel,
    createGatewayUpdateCheck: hoisted.createGatewayUpdateCheck,
    startGatewaySidecars: vi.fn(async () => ({ pluginServices: null, postReadySidecars: [] })),
    warmSystemCa: vi.fn(async () => {}),
    loadSubagentRegistryActivation: vi.fn(async () => hoisted.activateSubagentRegistry),
    ...overrides,
  };
}

function createPostAttachParams(overrides: Partial<PostAttachParams> = {}): PostAttachParams {
  const startupSignal = new AbortController().signal;
  return {
    minimalTestGateway: false,
    cfgAtStart: { hooks: { internal: { enabled: false } } } as never,
    getConfig: () => ({ hooks: { internal: { enabled: false } } }) as never,
    bindHost: "127.0.0.1",
    bindHosts: ["127.0.0.1"],
    port: 18789,
    tlsEnabled: false,
    log: { info: vi.fn(), warn: vi.fn() },
    isNixMode: false,
    broadcastToConnIds: vi.fn(),
    getClientConnIds: () => new Set(),
    controlUiBasePath: "/",
    gatewayPluginConfigAtStart: { hooks: { internal: { enabled: false } } } as never,
    activationSourceConfig: { hooks: { internal: { enabled: false } } } as never,
    pluginManifestRecords: [],
    pluginRegistry: {
      plugins: [
        { id: "beta", status: "loaded" },
        { id: "alpha", status: "loaded" },
        { id: "cold", status: "disabled" },
        { id: "broken", status: "error" },
      ],
      typedHooks: [],
    } as never,
    defaultWorkspaceDir: "/tmp/openclaw-workspace",
    deps: {} as never,
    startChannels: vi.fn(async () => {}),
    recoveryRuntime: {
      abortAgent: vi.fn(),
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    },
    resolveGatewayContext: vi.fn(() => ({ recoveryRuntime: {} }) as never),
    logHooks: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    logChannels: {
      info: vi.fn(),
      error: vi.fn(),
    },
    unlockStartupMethods: vi.fn(),
    providerAuthPrewarm: { enabled: false },
    unregisterConnectionDependentSidecar: vi.fn(),
    trackStartupWork: (run) => run(startupSignal),
    ...overrides,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
