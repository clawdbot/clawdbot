/**
 * Gateway post-attach startup task tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeRestartSentinel } from "../infra/restart-sentinel.js";
import type {
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
} from "../plugins/hook-types.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createGatewayResidentRegistry } from "./server-resident-registry.js";
import "./server-startup-outcomes.test-support.js";

const hoisted = vi.hoisted(() => {
  const startPluginServices = vi.fn<
    (params: { onHandle?: (handle: PluginServicesHandle) => void }) => Promise<PluginServicesHandle>
  >(async () => ({ stop: async () => {} }));
  const startGmailWatcherWithLogs = vi.fn(async () => {});
  const loadInternalHooks = vi.fn(async () => 0);
  const setInternalHooksEnabled = vi.fn();
  const hasInternalHookListeners = vi.fn(() => false);
  const startupHookEvent = { type: "gateway", action: "startup", sessionKey: "gateway:startup" };
  const createInternalHookEvent = vi.fn(() => startupHookEvent);
  const triggerInternalHook = vi.fn(async () => {});
  const scheduleGatewayUpdateCheck = vi.fn(() => () => {});
  const startGatewayTailscaleExposure = vi.fn(async () => null);
  const logGatewayStartup = vi.fn();
  const scheduleSubagentRegistrySweep = vi.fn();
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
    loadInternalHooks,
    setInternalHooksEnabled,
    hasInternalHookListeners,
    startupHookEvent,
    createInternalHookEvent,
    triggerInternalHook,
    scheduleGatewayUpdateCheck,
    startGatewayTailscaleExposure,
    logGatewayStartup,
    scheduleSubagentRegistrySweep,
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
  scheduleSubagentRegistrySweep: hoisted.scheduleSubagentRegistrySweep,
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
  setInternalHooksEnabled: hoisted.setInternalHooksEnabled,
  triggerInternalHook: hoisted.triggerInternalHook,
}));

vi.mock("../hooks/loader.js", () => ({
  loadInternalHooks: hoisted.loadInternalHooks,
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
  scheduleGatewayUpdateCheck: hoisted.scheduleGatewayUpdateCheck,
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

vi.mock("./server-tailscale.js", () => ({
  startGatewayTailscaleExposure: hoisted.startGatewayTailscaleExposure,
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
type UpdateCheckParams = Parameters<PostAttachRuntimeDeps["scheduleGatewayUpdateCheck"]>[0];
type SidecarPublisher = NonNullable<PostAttachParams["onGatewayLifetimeSidecars"]>;
type SidecarHandle = Parameters<SidecarPublisher>[0][number];
type GatewaySidecarsResult = Awaited<ReturnType<typeof startGatewaySidecarsImpl>>;

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

  const lifetimeSidecars = [...publishedGatewayLifetimeSidecars];
  publishedGatewayLifetimeSidecars.clear();
  const postReadySidecars = [...publishedPostReadySidecars];
  publishedPostReadySidecars.clear();

  for (const sidecar of lifetimeSidecars) {
    transferredSidecars.add(sidecar);
    await cleanup(() => sidecar.stop());
  }
  for (const sidecar of postReadySidecars) {
    transferredSidecars.add(sidecar);
    await cleanup(() => sidecar.stop());
  }

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
    hoisted.loadInternalHooks.mockClear();
    hoisted.setInternalHooksEnabled.mockClear();
    hoisted.hasInternalHookListeners.mockReset();
    hoisted.hasInternalHookListeners.mockReturnValue(false);
    hoisted.createInternalHookEvent.mockClear();
    hoisted.triggerInternalHook.mockClear();
    hoisted.scheduleGatewayUpdateCheck.mockClear();
    hoisted.startGatewayTailscaleExposure.mockClear();
    hoisted.logGatewayStartup.mockClear();
    hoisted.scheduleSubagentRegistrySweep.mockClear();
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
    const methodsAtRecoveryRegistration: string[][] = [];
    const currentConfig = { agents: { list: [{ id: "main" }, { id: "work" }] } };
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockImplementationOnce(
      (params: { getConfig: () => unknown }) => {
        methodsAtRecoveryRegistration.push([...unavailableGatewayMethods]);
        expect(params.getConfig()).toBe(currentConfig);
      },
    );
    const onSidecarsReady = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      getConfig: () => currentConfig,
      log,
      unlockStartupMethods: createStartupMethodUnlocker(unavailableGatewayMethods),
      onSidecarsReady,
    });

    await waitForGatewayTestState(() => {
      expect(onSidecarsReady).toHaveBeenCalledTimes(1);
    });
    expect([...unavailableGatewayMethods]).toStrictEqual([]);
    expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
    expect(hoisted.loadInternalHooks).not.toHaveBeenCalled();
    expect(hoisted.setInternalHooksEnabled).not.toHaveBeenCalled();
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
      waitForStart: undefined,
      gatewayRuntime: expect.any(Object),
    });
    expect(hoisted.scheduleSubagentRegistrySweep).toHaveBeenCalledWith();
    expect(methodsAtRecoveryRegistration).toStrictEqual([["chat.history", "models.list"]]);
  });

  it("fences startup recovery as soon as its gateway close prelude begins", async () => {
    let closing = false;
    const recoverySidecar = { stop: vi.fn(async () => {}) };
    const onGatewayLifetimeSidecars = vi.fn();
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockImplementationOnce(
      (params: { shouldContinue?: () => boolean }) => {
        expect(params.shouldContinue?.()).toBe(true);
        closing = true;
        expect(params.shouldContinue?.()).toBe(false);
        return recoverySidecar;
      },
    );

    await startGatewayPostAttachRuntime({
      ...createPostAttachParams(),
      isClosing: () => closing,
      onGatewayLifetimeSidecars,
    });

    expect(hoisted.scheduleRestartAbortedMainSessionRecovery).toHaveBeenCalledOnce();
    expect(recoverySidecar.stop).toHaveBeenCalledOnce();
    expect(onGatewayLifetimeSidecars).toHaveBeenCalledWith([recoverySidecar]);
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
      expect(onGatewayLifetimeSidecars).toHaveBeenCalledOnce();
    });
    const lifetimeSidecars = onGatewayLifetimeSidecars.mock.calls[0]?.[0] as
      | Array<{ stop: () => Promise<void> | void }>
      | undefined;
    expect(lifetimeSidecars).toContain(recoverySidecar);

    for (const sidecar of lifetimeSidecars ?? []) {
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
    hoisted.loadInternalHooks.mockRejectedValueOnce(new Error("private hook path"));

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

  it("rejects deferred startup when logging fails while sidecars remain pending", async () => {
    const startupError = new Error("startup logging failed");
    let rejectStartupLog: ((error: Error) => void) | undefined;
    let releaseSidecars: (() => void) | undefined;
    let sidecarsCompleted = false;
    const logGatewayStartup = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStartupLog = reject;
        }),
    );
    const startGatewaySidecarsScoped = vi.fn(
      async () =>
        await new Promise<{ pluginServices: null; postReadySidecars: [] }>((resolve) => {
          releaseSidecars = () => {
            sidecarsCompleted = true;
            resolve({ pluginServices: null, postReadySidecars: [] });
          };
        }),
    );
    const runtime = await startGatewayPostAttachRuntime(
      createPostAttachParams({ sidecarStartup: "defer" }),
      createPostAttachRuntimeDeps({
        logGatewayStartup,
        startGatewaySidecars: startGatewaySidecarsScoped,
      }),
    );

    await waitForGatewayTestState(() => {
      expect(rejectStartupLog).toBeTypeOf("function");
      expect(releaseSidecars).toBeTypeOf("function");
    });
    rejectStartupLog?.(startupError);

    await expect(runtime.startupSettled).rejects.toBe(startupError);
    expect(sidecarsCompleted).toBe(false);

    releaseSidecars?.();
    await waitForGatewayTestState(() => expect(sidecarsCompleted).toBe(true));
  });

  it("observes deferred startup logging failure while tailscale startup is pending", async () => {
    const startupError = new Error("startup logging failed");
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    let releaseTailscale: (() => void) | undefined;
    const tailscaleStartup = new Promise<null>((resolve) => {
      releaseTailscale = () => resolve(null);
    });
    const logGatewayStartup = vi.fn().mockRejectedValue(startupError);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const runtimePromise = startGatewayPostAttachRuntime(
        createPostAttachParams({ sidecarStartup: "defer" }),
        createPostAttachRuntimeDeps({
          logGatewayStartup,
          startGatewayTailscaleExposure: vi.fn(() => tailscaleStartup),
        }),
      );

      await waitForGatewayTestState(() => {
        expect(releaseTailscale).toBeTypeOf("function");
        expect(logGatewayStartup).toHaveBeenCalledOnce();
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toEqual([]);

      releaseTailscale?.();
      const runtime = await runtimePromise;
      await expect(runtime.startupSettled).rejects.toBe(startupError);
    } finally {
      releaseTailscale?.();
      process.off("unhandledRejection", onUnhandledRejection);
    }
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
    expect(postReadySidecar.stop).toHaveBeenCalledOnce();

    await cleanupGatewayTestState();
    expect(postReadySidecar.stop).toHaveBeenCalledTimes(2);
  });

  it("starts the gateway update check after post-attach returns", async () => {
    const events: string[] = [];
    const stopUpdateCheck = vi.fn();
    const scheduleGatewayUpdateCheck = vi.fn(async () => {
      events.push("update-check");
      return stopUpdateCheck;
    });
    const startGatewaySidecarsItem = vi.fn(async () => {
      events.push("sidecars");
      return { pluginServices: null, postReadySidecars: [] };
    });

    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
        scheduleGatewayUpdateCheck,
        startGatewaySidecars: startGatewaySidecarsItem,
      }),
    );
    events.push("returned");

    expect(scheduleGatewayUpdateCheck).not.toHaveBeenCalled();
    expect(events).toEqual(["sidecars", "returned"]);

    await waitForGatewayTestState(() => {
      expect(scheduleGatewayUpdateCheck).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(["sidecars", "returned", "update-check"]);

    result.stopGatewayUpdateCheck();
    expect(stopUpdateCheck).toHaveBeenCalledTimes(1);
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
    const scheduleGatewayUpdateCheck = vi.fn(async () => () => {});

    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams({ broadcastToConnIds, getClientConnIds }),
      createPostAttachRuntimeDeps({ scheduleGatewayUpdateCheck }),
    );
    await waitForGatewayTestState(() => {
      expect(scheduleGatewayUpdateCheck).toHaveBeenCalledTimes(1);
    });

    const updateCheckParams = mockCallArg(scheduleGatewayUpdateCheck) as UpdateCheckParams;
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
    result.stopGatewayUpdateCheck();
  });

  it("stops the gateway update check if close wins the deferred startup race", async () => {
    let finishUpdateCheckSchedule: (() => void) | undefined;
    const stopUpdateCheck = vi.fn();
    const scheduleGatewayUpdateCheck = vi.fn(
      async () =>
        await new Promise<() => void>((resolve) => {
          finishUpdateCheckSchedule = () => resolve(stopUpdateCheck);
        }),
    );

    const result = await startGatewayPostAttachRuntime(
      createPostAttachParams(),
      createPostAttachRuntimeDeps({
        refreshLatestUpdateRestartSentinel: vi.fn(async () => null),
        scheduleGatewayUpdateCheck,
      }),
    );

    await waitForGatewayTestState(() => {
      expect(scheduleGatewayUpdateCheck).toHaveBeenCalledTimes(1);
    });
    result.stopGatewayUpdateCheck();
    expect(stopUpdateCheck).not.toHaveBeenCalled();

    if (!finishUpdateCheckSchedule) {
      throw new Error("Expected update check schedule release callback to be initialized");
    }
    finishUpdateCheckSchedule();

    await waitForGatewayTestState(() => {
      expect(stopUpdateCheck).toHaveBeenCalledTimes(1);
    });
  });

  it("logs deferred gateway update check startup failures without failing ready", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const scheduleGatewayUpdateCheck = vi.fn(async () => {
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
          scheduleGatewayUpdateCheck,
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        stopGatewayUpdateCheck: expect.any(Function),
      }),
    );

    await waitForGatewayTestState(() => {
      expect(log.warn).toHaveBeenCalledWith("gateway update check failed to start: Error: boom");
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

  it("starts and can cancel Control UI preparation while startup plugins are pending", async () => {
    let finishPluginStartup: (() => void) | undefined;
    const pluginStartup = new Promise<void>((resolve) => {
      finishPluginStartup = resolve;
    });
    let buildSignal: AbortSignal | undefined;
    const startControlUiBuild = vi.fn(
      async (_isStopped: () => boolean, signal: AbortSignal) =>
        await new Promise<void>((resolve) => {
          buildSignal = signal;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const stopControlUiBuild = vi.fn(async () => {});
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
          state: { kind: "preparing" },
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

    expect(onGatewayLifetimeSidecars).toHaveBeenCalledTimes(2);
    expect(onGatewayLifetimeSidecars.mock.calls[1]?.[0]).not.toContain(earlySidecar);
    expect(startControlUiBuild).toHaveBeenCalledOnce();
    expect(publishedGatewayLifetimeSidecars).not.toContain(earlySidecar);
    await cleanupGatewayTestState();
    expect(stopControlUiBuild).toHaveBeenCalledOnce();
    expect(publishedGatewayLifetimeSidecars).not.toContain(earlySidecar);
  });

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
      expect(onGatewayLifetimeSidecars.mock.calls[0]?.[0]).toHaveLength(3);
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
      expect(onGatewayLifetimeSidecars.mock.calls[0]?.[0]).toHaveLength(3);

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
        expect(onGatewayLifetimeSidecars).toHaveBeenCalledTimes(1);
      });
      const gmailSidecars = onPostReadySidecars.mock.calls[0]?.[0] as
        | { stop: () => void }[]
        | undefined;
      const lifetimeSidecars = onGatewayLifetimeSidecars.mock.calls[0]?.[0] as
        | { stop: () => void }[]
        | undefined;
      expect(gmailSidecars).toHaveLength(2);
      expect(lifetimeSidecars).toHaveLength(3);

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
    const lifetimeSidecars = onGatewayLifetimeSidecars.mock.calls[0]?.[0] as
      | Array<{ stop: () => Promise<void> | void }>
      | undefined;
    expect(gmailSidecars).toHaveLength(2);
    expect(lifetimeSidecars).toHaveLength(3);

    await waitForGatewayTestState(() => {
      expect(hoisted.transcriptsAutoStartService.start).toHaveBeenCalledTimes(1);
    });

    for (const sidecar of gmailSidecars ?? []) {
      await stopTrackedSidecar(sidecar);
    }
    expect(hoisted.transcriptsAutoStartService.stop).not.toHaveBeenCalled();

    for (const sidecar of lifetimeSidecars ?? []) {
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

  it("starts and reports plugin services after channel startup completes", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let releaseChannels: (() => void) | undefined;
        const events: string[] = [];
        const pluginServices: PluginServicesHandle = { stop: vi.fn(async () => {}) };
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
          "channels-end",
          "channels-started",
          "plugin-services",
        ]);
        expect(onPluginServices).toHaveBeenCalledTimes(1);
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

  it("stops plugin services that finish starting after deferred close begins", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        let shouldStartPluginServices = true;
        let releasePluginServices: (() => void) | undefined;
        const pluginServices: PluginServicesHandle = { stop: vi.fn(async () => {}) };
        const onPluginServices = vi.fn();
        hoisted.startPluginServices.mockImplementationOnce(
          async (params) =>
            (await new Promise<typeof pluginServices>((resolve) => {
              params.onHandle?.(pluginServices);
              releasePluginServices = () => resolve(pluginServices);
            })) as never,
        );

        const sidecarsPromise = startGatewaySidecars({
          cfg: { hooks: { internal: { enabled: false } } } as never,
          pluginRegistry: createPostAttachParams().pluginRegistry,
          defaultWorkspaceDir: "/tmp/openclaw-workspace",
          deps: {} as never,
          startChannels: vi.fn(async () => {}),
          shouldStartPluginServices: () => shouldStartPluginServices,
          onPluginServices,
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
          expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
        });
        expect(onPluginServices).toHaveBeenCalledOnce();
        expect(onPluginServices.mock.calls[0]?.[0]).toHaveProperty("stop");
        shouldStartPluginServices = false;

        if (!releasePluginServices) {
          throw new Error("Expected plugin service release callback to be initialized");
        }
        releasePluginServices();
        await expect(sidecarsPromise).resolves.toMatchObject({ pluginServices: null });

        expect(pluginServices.stop).toHaveBeenCalledTimes(1);
        expect(onPluginServices).toHaveBeenCalledWith(null);
      },
    );
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
    expect(onPluginServices).toHaveBeenLastCalledWith(null);
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
      onGatewayLifetimeSidecars([workerSidecar]);
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
    const workerPublications = onGatewayLifetimeSidecars.mock.calls.filter(([sidecars]) =>
      sidecars.includes(workerSidecar),
    );
    expect(workerPublications).toEqual([[[workerSidecar]]]);
  });

  it("stops worker placement runtime when channel and sidecar startup fails", async () => {
    const cleanupError = new Error("worker cleanup failed");
    const workerSidecar = {
      stop: vi.fn().mockRejectedValueOnce(cleanupError).mockResolvedValue(undefined),
    };
    const startupError = new Error("sidecar startup failed");
    const onGatewayLifetimeSidecars = vi.fn();
    const unregisterGatewayLifetimeSidecar = vi.fn();
    let ownedWorkerSidecar: typeof workerSidecar | undefined;
    const params = createPostAttachParams({
      onGatewayLifetimeSidecars,
      unregisterGatewayLifetimeSidecar,
    });

    await expect(
      startGatewayPostAttachRuntime(
        {
          ...params,
          startWorkerEnvironmentRuntime: vi.fn(() => {
            ownedWorkerSidecar = workerSidecar;
            onGatewayLifetimeSidecars([workerSidecar]);
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
    expect(onGatewayLifetimeSidecars).toHaveBeenCalledWith([workerSidecar]);
    expect(unregisterGatewayLifetimeSidecar).not.toHaveBeenCalled();
    expect(params.log.warn).toHaveBeenCalledWith(
      `worker environment cleanup after sidecar startup failure failed: ${String(cleanupError)}`,
    );

    await ownedWorkerSidecar?.stop();
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

  it("fences plugin publication when close begins during deferred plugin loading", async () => {
    let closeStarted = false;
    let releasePluginLoad: (() => void) | undefined;
    const pluginLoadReady = new Promise<void>((resolve) => {
      releasePluginLoad = resolve;
    });
    const onStartupPluginsLoaded = vi.fn();
    const startGatewaySidecarsValue = vi.fn(async () => ({
      pluginServices: null,
      postReadySidecars: [],
    }));
    const runtime = await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams({
          sidecarStartup: "defer",
          isClosing: () => closeStarted,
          loadStartupPlugins: async () => {
            await pluginLoadReady;
            return { pluginRegistry: createPostAttachParams().pluginRegistry, gatewayMethods: [] };
          },
          onStartupPluginsLoaded,
        }),
      },
      createPostAttachRuntimeDeps({ startGatewaySidecars: startGatewaySidecarsValue }),
    );

    closeStarted = true;
    releasePluginLoad?.();
    await expect(runtime.startupSettled).resolves.toBeUndefined();

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

  it("keeps startup methods fenced when close begins during late recovery loading", async () => {
    let closeStarted = false;
    let releaseRecoveryLoad: (() => void) | undefined;
    const recoveryLoadReady = new Promise<void>((resolve) => {
      releaseRecoveryLoad = resolve;
    });
    let markRecoveryLoadStarted: (() => void) | undefined;
    const recoveryLoadStarted = new Promise<void>((resolve) => {
      markRecoveryLoadStarted = resolve;
    });
    const pluginServices = { stop: vi.fn(async () => {}) } as PluginServicesHandle;
    const postReadySidecar = { stop: vi.fn(async () => {}) };
    const workerSidecar = { stop: vi.fn(async () => {}) };
    let ownedWorkerSidecar: typeof workerSidecar | undefined;
    const unlockStartupMethods = vi.fn();
    const scheduleSubagentRegistrySweep = vi.fn();
    const onPluginServices = vi.fn();
    const onGatewayLifetimeSidecars = vi.fn();
    const runtime = await startGatewayPostAttachRuntime(
      {
        ...createPostAttachParams(),
        sidecarStartup: "defer",
        isClosing: () => closeStarted,
        startWorkerEnvironmentRuntime: vi.fn(() => {
          ownedWorkerSidecar = workerSidecar;
          onGatewayLifetimeSidecars([workerSidecar]);
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
            return { pluginServices, postReadySidecars: [postReadySidecar] };
          },
        ),
        loadSubagentRegistrySweep: vi.fn(async () => {
          markRecoveryLoadStarted?.();
          await recoveryLoadReady;
          return scheduleSubagentRegistrySweep;
        }),
      }),
    );

    await recoveryLoadStarted;
    closeStarted = true;
    releaseRecoveryLoad?.();
    await expect(runtime.startupSettled).resolves.toBeUndefined();

    expect(scheduleSubagentRegistrySweep).not.toHaveBeenCalled();
    expect(unlockStartupMethods).not.toHaveBeenCalled();
    expect(workerSidecar.stop).not.toHaveBeenCalled();
    expect(pluginServices.stop).toHaveBeenCalledOnce();
    expect(postReadySidecar.stop).toHaveBeenCalledOnce();
    expect(onPluginServices).toHaveBeenLastCalledWith(null);
    await ownedWorkerSidecar?.stop();
    expect(workerSidecar.stop).toHaveBeenCalledOnce();
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

      expect(hoisted.loadInternalHooks).not.toHaveBeenCalled();
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
    scheduleGatewayUpdateCheck: hoisted.scheduleGatewayUpdateCheck,
    startGatewaySidecars: vi.fn(async () => ({ pluginServices: null, postReadySidecars: [] })),
    warmSystemCa: vi.fn(async () => {}),
    startGatewayTailscaleExposure: hoisted.startGatewayTailscaleExposure,
    loadSubagentRegistrySweep: vi.fn(async () => hoisted.scheduleSubagentRegistrySweep),
    ...overrides,
  };
}

function createPostAttachParams(overrides: Partial<PostAttachParams> = {}): PostAttachParams {
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
    tailscaleMode: "off",
    resetOnExit: false,
    preserveFunnel: false,
    controlUiBasePath: "/",
    logTailscale: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
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
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    },
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
    residentRegistry: createGatewayResidentRegistry(),
    providerAuthPrewarm: { enabled: false },
    unregisterGatewayLifetimeSidecar: vi.fn(),
    stopRegisteredPostReadySidecars: () => stopTrackedSidecars(publishedPostReadySidecars),
    stopRegisteredGatewayLifetimeSidecars: () =>
      stopTrackedSidecars(publishedGatewayLifetimeSidecars),
    ...overrides,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
