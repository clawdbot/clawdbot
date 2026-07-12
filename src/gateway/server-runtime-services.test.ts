/**
 * Gateway runtime service lifecycle tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";

const hoisted = vi.hoisted(() => {
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  const stopModelPricingRefresh = vi.fn();
  return {
    heartbeatRunner,
    startHeartbeatRunner: vi.fn(() => heartbeatRunner),
    startChannelHealthMonitor: vi.fn(() => ({
      stop: vi.fn(),
      shutdown: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
    })),
    stopModelPricingRefresh,
    startGatewayModelPricingRefresh: vi.fn(() => stopModelPricingRefresh),
    loadModelPricingCacheModule: vi.fn(),
    isVitestRuntimeEnv: vi.fn(() => false),
    recoverPendingDeliveries: vi.fn(async () => undefined),
    recoverPendingRestartContinuationDeliveries: vi.fn(async () => undefined),
    recoverPendingContinuationDelegates: vi.fn(async () => ({
      sessions: 0,
      dispatched: 0,
      rejected: 0,
    })),
    requeueAwaitingNextCompactionDelegates: vi.fn(async () => ({ requeued: 0 })),
    recoverAndReleaseStagedPostCompactionDelegates: vi.fn(async () => ({
      sessions: 0,
      dispatched: 0,
      failed: 0,
    })),
    recoverPendingContinuationWork: vi.fn(async () => ({
      sessions: 0,
      dispatched: 0,
      failed: 0,
      reaped: 0,
    })),
    deliverOutboundPayloads: vi.fn(),
  };
});

vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
}));

vi.mock("../infra/env.js", () => ({
  isVitestRuntimeEnv: hoisted.isVitestRuntimeEnv,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: hoisted.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: hoisted.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  recoverPendingDeliveries: hoisted.recoverPendingDeliveries,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  recoverPendingRestartContinuationDeliveries: hoisted.recoverPendingRestartContinuationDeliveries,
}));

vi.mock("../auto-reply/continuation/delegate-dispatch.js", () => ({
  recoverPendingContinuationDelegates: hoisted.recoverPendingContinuationDelegates,
  requeueAwaitingNextCompactionDelegates: hoisted.requeueAwaitingNextCompactionDelegates,
  recoverAndReleaseStagedPostCompactionDelegates:
    hoisted.recoverAndReleaseStagedPostCompactionDelegates,
}));

vi.mock("../auto-reply/continuation/work-dispatch.js", () => ({
  recoverPendingContinuationWork: hoisted.recoverPendingContinuationWork,
}));

vi.mock("./channel-health-monitor.js", () => ({
  startChannelHealthMonitor: hoisted.startChannelHealthMonitor,
}));

vi.mock("./model-pricing-cache.js", () => ({
  ...(() => {
    hoisted.loadModelPricingCacheModule();
    return {};
  })(),
  startGatewayModelPricingRefresh: hoisted.startGatewayModelPricingRefresh,
}));

const {
  activateGatewayScheduledServices,
  runGatewayPostReadyMaintenance,
  scheduleGatewayPostReadyMaintenance,
  startGatewayCronWithLogging,
  startGatewayRuntimeServices,
} = await import("./server-runtime-services.js");

describe("server-runtime-services", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    hoisted.heartbeatRunner.stop.mockClear();
    hoisted.heartbeatRunner.updateConfig.mockClear();
    hoisted.startHeartbeatRunner.mockClear();
    hoisted.startChannelHealthMonitor.mockClear();
    hoisted.startGatewayModelPricingRefresh.mockClear();
    hoisted.stopModelPricingRefresh.mockClear();
    hoisted.loadModelPricingCacheModule.mockClear();
    hoisted.isVitestRuntimeEnv.mockReset().mockReturnValue(false);
    hoisted.recoverPendingDeliveries.mockClear();
    hoisted.recoverPendingRestartContinuationDeliveries.mockClear();
    hoisted.recoverPendingContinuationDelegates.mockClear();
    hoisted.requeueAwaitingNextCompactionDelegates.mockClear();
    hoisted.recoverAndReleaseStagedPostCompactionDelegates.mockClear();
    hoisted.recoverPendingContinuationWork.mockClear();
    hoisted.deliverOutboundPayloads.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });

  it("skips model pricing bootstrap import when pricing is disabled", async () => {
    activateGatewayScheduledServices({
      minimalTestGateway: false,
      cfgAtStart: { models: { pricing: { enabled: false } } } as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cronState: createTestCronState(),
      cronReconciliation: createTestCronReconciliation(),
      logCron: { error: vi.fn() },
      log: createLog(),
    });

    await vi.dynamicImportSettled();

    expect(hoisted.loadModelPricingCacheModule).not.toHaveBeenCalled();
    expect(hoisted.startGatewayModelPricingRefresh).not.toHaveBeenCalled();
  });

  it("keeps scheduled services and pricing refresh inert during initial runtime setup", async () => {
    const services = startGatewayRuntimeServices({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      channelManager: {
        getRuntimeSnapshot: vi.fn(),
        isHealthMonitorEnabled: vi.fn(),
        isManuallyStopped: vi.fn(),
      } as never,
      log: createLog(),
    });

    expect(hoisted.startChannelHealthMonitor).toHaveBeenCalledTimes(1);
    expect(hoisted.loadModelPricingCacheModule).not.toHaveBeenCalled();
    expect(hoisted.startGatewayModelPricingRefresh).not.toHaveBeenCalled();
    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();

    services.heartbeatRunner.stop();
    expect(hoisted.heartbeatRunner.stop).not.toHaveBeenCalled();
  });

  it("starts model pricing refresh after scheduled services activate", async () => {
    const pluginLookUpTable = {
      index: { plugins: [] },
      manifestRegistry: { plugins: [], diagnostics: [] },
    };
    const { cronStart, services } = activateScheduledServicesForTest({
      pluginLookUpTable: pluginLookUpTable as never,
    });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(cronStart).toHaveBeenCalledTimes(1);
    await vi.dynamicImportSettled();
    expect(hoisted.startGatewayModelPricingRefresh).toHaveBeenCalledWith({
      config: {},
      pluginLookUpTable,
    });
    services.stopModelPricingRefresh();
    expect(hoisted.stopModelPricingRefresh).toHaveBeenCalledTimes(1);
  });

  it("runs cron start, watcher reconciliation, and hook completion in order", async () => {
    const order: string[] = [];
    const cron = {
      start: vi.fn(async () => {
        order.push("start");
      }),
    };
    const afterStart = vi.fn(async () => {
      order.push("after-start");
    });
    const cronReconciliation = createTestCronReconciliation(async () => {
      order.push("hook");
    });
    const cronState = createTestCronState(cron);
    const config = { cron: { enabled: true } } as never;
    const logCron = { error: vi.fn() };

    startGatewayCronWithLogging({
      cronState,
      cronReconciliation,
      reason: "startup",
      config,
      afterStart,
      logCron,
    });

    await vi.waitFor(() => expect(order).toEqual(["start", "after-start", "hook"]));
    expect(cronReconciliation.arm).toHaveBeenCalledWith({
      reason: "startup",
      config,
      cronState,
    });
    expect(logCron.error).not.toHaveBeenCalled();
  });

  it("does not complete cron reconciliation when scheduler startup rejects", async () => {
    const cron = {
      start: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const cronReconciliation = createTestCronReconciliation();
    const logCron = { error: vi.fn() };

    startGatewayCronWithLogging({
      cronState: createTestCronState(cron),
      cronReconciliation,
      reason: "startup",
      config: {} as never,
      logCron,
    });

    await vi.waitFor(() =>
      expect(logCron.error).toHaveBeenCalledWith("failed to start: Error: store unavailable"),
    );
    expect(cronReconciliation.complete).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("does not complete cron reconciliation when exit-watcher reconciliation rejects", async () => {
    const cronReconciliation = createTestCronReconciliation();
    const logCron = { error: vi.fn() };

    startGatewayCronWithLogging({
      cronState: createTestCronState(),
      cronReconciliation,
      reason: "reload",
      config: {} as never,
      afterStart: async () => {
        throw new Error("watcher unavailable");
      },
      logCron,
    });

    await vi.waitFor(() =>
      expect(logCron.error).toHaveBeenCalledWith("failed to start: Error: watcher unavailable"),
    );
    expect(cronReconciliation.complete).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps one independent root admitted until the reconciliation hook settles", async () => {
    let releaseHook: (() => void) | undefined;
    const cronReconciliation = createTestCronReconciliation(
      () =>
        new Promise<void>((resolve) => {
          releaseHook = resolve;
        }),
    );

    startGatewayCronWithLogging({
      cronState: createTestCronState(),
      cronReconciliation,
      reason: "startup",
      config: {} as never,
      logCron: { error: vi.fn() },
    });

    await vi.waitFor(() => expect(cronReconciliation.complete).toHaveBeenCalledTimes(1));
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    if (!releaseHook) {
      throw new Error("Expected cron reconciliation hook to be pending");
    }
    releaseHook();
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("does not start model pricing refresh after scheduled services stop before import settles", async () => {
    const { services } = activateScheduledServicesForTest();

    services.stopModelPricingRefresh();
    await vi.dynamicImportSettled();

    expect(hoisted.startGatewayModelPricingRefresh).not.toHaveBeenCalled();
    expect(hoisted.stopModelPricingRefresh).not.toHaveBeenCalled();
  });

  it("activates heartbeat, cron, and delivery recovery after sidecars are ready", async () => {
    vi.useFakeTimers();
    const log = createLog();
    const { cronStart, services } = activateScheduledServicesForTest({ log });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(cronStart).toHaveBeenCalledTimes(1);
    expect(services.heartbeatRunner).toBe(hoisted.heartbeatRunner);
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();
    expect(log.child).toHaveBeenNthCalledWith(1, "delivery-recovery");
    expect(log.child).toHaveBeenNthCalledWith(2, "session-delivery-recovery");
    const deliveryLog = log.child.mock.results[0]?.value;
    const sessionDeliveryLog = log.child.mock.results[1]?.value;
    if (!deliveryLog || !sessionDeliveryLog) {
      throw new Error("Expected delivery recovery log children");
    }
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledWith({
      deliver: hoisted.deliverOutboundPayloads,
      cfg: {},
      log: deliveryLog,
    });
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledWith({
      deps: {},
      maxEnqueuedAt: 123,
      log: sessionDeliveryLog,
    });
  });

  it("can defer cron startup while activating other scheduled services", async () => {
    vi.useFakeTimers();
    const cron = { start: vi.fn(async () => undefined) };
    const log = createLog();

    activateGatewayScheduledServices({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cronState: createTestCronState(cron),
      cronReconciliation: createTestCronReconciliation(),
      startCron: false,
      logCron: { error: vi.fn() },
      log,
    });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(cron.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledTimes(1);
  });

  it("requeues next-seam post-compaction claims using the boot-time cutoff", async () => {
    vi.useFakeTimers();
    const recoveryArmedAt = new Date("2026-07-03T20:00:00.000Z");
    const recoveryArmedAtMs = recoveryArmedAt.getTime();
    vi.setSystemTime(recoveryArmedAt);

    activateScheduledServicesForTest();
    await vi.advanceTimersByTimeAsync(1_400);
    await vi.dynamicImportSettled();

    expect(hoisted.recoverPendingContinuationDelegates).toHaveBeenCalledWith({
      queuedCreatedAtOrBefore: recoveryArmedAtMs,
      includeRunningUpdatedAtOrBefore: recoveryArmedAtMs,
    });
    expect(hoisted.requeueAwaitingNextCompactionDelegates).toHaveBeenCalledWith({
      runningUpdatedAtOrBefore: recoveryArmedAtMs,
    });
    expect(hoisted.recoverAndReleaseStagedPostCompactionDelegates).toHaveBeenCalledWith({
      runningUpdatedAtOrBefore: recoveryArmedAtMs,
    });
  });

  it("starts cron and records memory when post-ready maintenance fails", async () => {
    const cron = { start: vi.fn(async () => undefined) };
    const log = createLog();
    const recordPostReadyMemory = vi.fn();

    await runGatewayPostReadyMaintenance({
      startMaintenance: vi.fn(async () => {
        throw new Error("timers unavailable");
      }),
      applyMaintenance: vi.fn(),
      shouldStartCron: () => true,
      markCronStartHandled: vi.fn(),
      cronState: createTestCronState(cron),
      cronReconciliation: createTestCronReconciliation(),
      cronConfig: {} as never,
      logCron: { error: vi.fn() },
      log,
      recordPostReadyMemory,
    });

    expect(log.warn).toHaveBeenCalledWith(
      "gateway post-ready maintenance startup failed: Error: timers unavailable",
    );
    expect(cron.start).toHaveBeenCalledTimes(1);
    expect(recordPostReadyMemory).toHaveBeenCalledTimes(1);
  });

  it("returns a cancellable post-ready maintenance timer", async () => {
    vi.useFakeTimers();
    const startMaintenance = vi.fn(async () => null);
    const onStarted = vi.fn();
    const handle = scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        delayMs: 25,
        onStarted,
        startMaintenance,
      }),
    );

    clearTimeout(handle);
    await vi.advanceTimersByTimeAsync(25);

    expect(onStarted).not.toHaveBeenCalled();
    expect(startMaintenance).not.toHaveBeenCalled();
  });

  it("clears delayed maintenance handles when close starts during maintenance startup", async () => {
    vi.useFakeTimers();
    let closing = false;
    let resolveMaintenance:
      | ((maintenance: ReturnType<typeof createMaintenanceHandles>) => void)
      | undefined;
    const startMaintenance = vi.fn(
      () =>
        new Promise<ReturnType<typeof createMaintenanceHandles>>((resolve) => {
          resolveMaintenance = resolve;
        }),
    );
    const applyMaintenance = vi.fn();
    const cron = { start: vi.fn(async () => undefined) };
    const recordPostReadyMemory = vi.fn();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        delayMs: 25,
        isClosing: () => closing,
        startMaintenance,
        applyMaintenance,
        cronState: createTestCronState(cron),
        recordPostReadyMemory,
      }),
    );

    await vi.advanceTimersByTimeAsync(25);
    expect(startMaintenance).toHaveBeenCalledTimes(1);

    closing = true;
    if (!resolveMaintenance) {
      throw new Error("Expected gateway maintenance resolver to be initialized");
    }
    const maintenance = createMaintenanceHandles();
    resolveMaintenance(maintenance);
    await Promise.resolve();
    await Promise.resolve();

    expect(applyMaintenance).not.toHaveBeenCalled();
    expect(cron.start).not.toHaveBeenCalled();
    expect(recordPostReadyMemory).not.toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.tickInterval);
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.healthInterval);
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.dedupeCleanup);
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.mediaCleanup);
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.worktreeCleanup);
  });

  it("keeps scheduled services disabled for minimal test gateways", () => {
    const cron = { start: vi.fn(async () => undefined) };

    const services = activateGatewayScheduledServices({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cronState: createTestCronState(cron),
      cronReconciliation: createTestCronReconciliation(),
      logCron: { error: vi.fn() },
      log: createLog(),
    });

    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
    expect(cron.start).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).not.toHaveBeenCalled();

    services.heartbeatRunner.stop();
    expect(hoisted.heartbeatRunner.stop).not.toHaveBeenCalled();
  });
});

function createLog() {
  return {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTestCron() {
  return { start: vi.fn<() => Promise<void>>(async () => {}) };
}

function createTestCronState(
  cron: { start: () => Promise<void> } = createTestCron(),
  cronEnabled = true,
) {
  return {
    cron,
    storePath: "/tmp/cron.json",
    cronEnabled,
  } as never;
}

function createTestCronReconciliation(complete: () => Promise<void> = async () => {}) {
  const completeMock = vi.fn<() => Promise<void>>(complete);
  return {
    arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete: completeMock })),
    complete: completeMock,
    invalidate: vi.fn(),
  };
}

function activateScheduledServicesForTest(
  overrides: Omit<
    Partial<Parameters<typeof activateGatewayScheduledServices>[0]>,
    "cronState"
  > = {},
) {
  const cron = createTestCron();
  const cronState = createTestCronState(cron);
  const cronStart = cron.start;
  const log = overrides.log ?? createLog();
  const services = activateGatewayScheduledServices({
    minimalTestGateway: false,
    cfgAtStart: {} as never,
    deps: {} as never,
    sessionDeliveryRecoveryMaxEnqueuedAt: 123,
    cronReconciliation: createTestCronReconciliation(),
    logCron: { error: vi.fn() },
    ...overrides,
    cronState,
    log,
  });
  return { cron, cronStart, log, services };
}

function createPostReadyMaintenanceScheduleParams(
  overrides: Partial<Parameters<typeof scheduleGatewayPostReadyMaintenance>[0]> = {},
): Parameters<typeof scheduleGatewayPostReadyMaintenance>[0] {
  return {
    delayMs: 1,
    isClosing: () => false,
    startMaintenance: vi.fn(async () => null),
    applyMaintenance: vi.fn(),
    shouldStartCron: () => true,
    markCronStartHandled: vi.fn(),
    cronState: createTestCronState(),
    cronReconciliation: createTestCronReconciliation(),
    cronConfig: {} as never,
    logCron: { error: vi.fn() },
    log: createLog(),
    recordPostReadyMemory: vi.fn(),
    ...overrides,
  };
}

function createMaintenanceHandles() {
  return {
    tickInterval: setInterval(() => undefined, 60_000),
    healthInterval: setInterval(() => undefined, 60_000),
    dedupeCleanup: setInterval(() => undefined, 60_000),
    mediaCleanup: setInterval(() => undefined, 60_000),
    worktreeCleanup: setInterval(() => undefined, 60_000),
    skillCuratorCleanup: vi.fn(),
  };
}
