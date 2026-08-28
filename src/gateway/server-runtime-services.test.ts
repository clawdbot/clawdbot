/**
 * Gateway runtime service lifecycle tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

type StartSessionDeliveryRuntime =
  typeof import("../infra/session-delivery-queue-runtime.js").startSessionDeliveryRuntime;
type StartHeartbeatRunner = typeof import("../infra/heartbeat-runner.js").startHeartbeatRunner;
type DrainPendingDeliveries =
  typeof import("../infra/outbound/delivery-queue-recovery.js").drainPendingDeliveriesCore;
type RecoverPendingDeliveries =
  typeof import("../infra/outbound/delivery-queue-recovery.js").recoverPendingDeliveries;
type MigrateLegacyPendingOutboundDeliveries =
  typeof import("../infra/outbound/delivery-queue-migration.js").migrateLegacyPendingOutboundDeliveries;

const hoisted = vi.hoisted(() => {
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  const stopSessionUpstreamMonitor = vi.fn();
  const stopSessionDeliveryRuntime = vi.fn();
  return {
    heartbeatRunner,
    startHeartbeatRunner: vi.fn<StartHeartbeatRunner>(() => heartbeatRunner),
    runHeartbeatOnce: vi.fn(async () => ({ status: "ran" as const, durationMs: 1 })),
    startChannelHealthMonitor: vi.fn(() => ({
      stop: vi.fn(),
      shutdown: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
    })),
    stopSessionUpstreamMonitor,
    stopSessionDeliveryRuntime,
    startSessionDeliveryRuntime: vi.fn<StartSessionDeliveryRuntime>(
      () => stopSessionDeliveryRuntime,
    ),
    schedulePendingSessionDeliveries: vi.fn(async () => undefined),
    startSessionUpstreamMonitor: vi.fn(() => ({ stop: stopSessionUpstreamMonitor })),
    recoverPendingDeliveries: vi.fn<RecoverPendingDeliveries>(async () => ({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    })),
    migrateLegacyPendingOutboundDeliveries: vi.fn<MigrateLegacyPendingOutboundDeliveries>(
      async () => ({ moved: 0, skipped: 0, remaining: 0 }),
    ),
    drainPendingDeliveries: vi.fn<DrainPendingDeliveries>(async () => undefined),
    recoverPendingRestartContinuationDeliveries: vi.fn(async () => undefined),
    deliverQueuedSessionDelivery: vi.fn(async () => undefined),
    settleQueuedSessionDelivery: vi.fn(async () => undefined),
    deliverOutboundPayloads: vi.fn(),
    assertQueuedConversationDeliveryAttemptAuthorized: vi.fn(),
  };
});

vi.mock("../infra/heartbeat-runner.js", () => ({
  resolveHeartbeatAgents: (cfg: { agents?: { defaults?: { heartbeat?: unknown } } }) => [
    { agentId: "main", heartbeat: cfg.agents?.defaults?.heartbeat },
  ],
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
  runHeartbeatOnce: hoisted.runHeartbeatOnce,
}));

vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: hoisted.startSessionUpstreamMonitor,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: hoisted.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: hoisted.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue-recovery.js", () => ({
  recoverPendingDeliveries: hoisted.recoverPendingDeliveries,
  drainPendingDeliveriesCore: hoisted.drainPendingDeliveries,
}));

vi.mock("../infra/outbound/delivery-queue-migration.js", () => ({
  migrateLegacyPendingOutboundDeliveries: hoisted.migrateLegacyPendingOutboundDeliveries,
}));

vi.mock("./conversation-route-ownership.js", () => ({
  assertQueuedConversationDeliveryAttemptAuthorized:
    hoisted.assertQueuedConversationDeliveryAttemptAuthorized,
}));

vi.mock("../infra/session-delivery-queue-runtime.js", () => ({
  startSessionDeliveryRuntime: hoisted.startSessionDeliveryRuntime,
  schedulePendingSessionDeliveries: hoisted.schedulePendingSessionDeliveries,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  deliverQueuedSessionDelivery: hoisted.deliverQueuedSessionDelivery,
  recoverPendingRestartContinuationDeliveries: hoisted.recoverPendingRestartContinuationDeliveries,
  settleQueuedSessionDelivery: hoisted.settleQueuedSessionDelivery,
}));

vi.mock("./channel-health-monitor.js", () => ({
  startChannelHealthMonitor: hoisted.startChannelHealthMonitor,
}));

import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";

const {
  activateGatewayScheduledServices,
  scheduleGatewayIdleTask,
  scheduleGatewayPostReadyMaintenance,
  startGatewayChannelHealthMonitor,
  startGatewayCronWithLogging,
} = await import("./server-runtime-services.js");

describe("server-runtime-services", () => {
  beforeEach(() => {
    vi.useRealTimers();
    // Gateway test helpers set these at module load. Stub them off so a shared
    // worker's import order cannot silently disable this suite's health monitor.
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "");
    vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", "");
    resetGatewayWorkAdmission();
    hoisted.heartbeatRunner.stop.mockClear();
    hoisted.heartbeatRunner.updateConfig.mockClear();
    hoisted.startHeartbeatRunner.mockClear();
    hoisted.runHeartbeatOnce.mockClear();
    hoisted.startChannelHealthMonitor.mockClear();
    hoisted.startSessionUpstreamMonitor.mockClear();
    hoisted.stopSessionUpstreamMonitor.mockClear();
    hoisted.stopSessionDeliveryRuntime.mockClear();
    hoisted.startSessionDeliveryRuntime.mockClear();
    hoisted.schedulePendingSessionDeliveries.mockClear();
    hoisted.recoverPendingDeliveries.mockReset();
    hoisted.recoverPendingDeliveries.mockResolvedValue({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    hoisted.migrateLegacyPendingOutboundDeliveries.mockReset();
    hoisted.migrateLegacyPendingOutboundDeliveries.mockResolvedValue({
      moved: 0,
      skipped: 0,
      remaining: 0,
    });
    hoisted.drainPendingDeliveries.mockReset();
    hoisted.drainPendingDeliveries.mockResolvedValue(undefined);
    hoisted.recoverPendingRestartContinuationDeliveries.mockClear();
    hoisted.deliverQueuedSessionDelivery.mockClear();
    hoisted.settleQueuedSessionDelivery.mockClear();
    hoisted.deliverOutboundPayloads.mockClear();
    hoisted.assertQueuedConversationDeliveryAttemptAuthorized.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetGatewayWorkAdmission();
  });

  it("starts channel health without activating scheduled services", () => {
    startGatewayChannelHealthMonitor({
      channelManager: {
        getRuntimeSnapshot: vi.fn(),
        isHealthMonitorEnabled: vi.fn(),
        isManuallyStopped: vi.fn(),
      } as never,
    });

    expect(hoisted.startChannelHealthMonitor).toHaveBeenCalledTimes(1);
    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
    expect(hoisted.startSessionUpstreamMonitor).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();
  });

  it.each(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"])(
    "keeps channel health recovery disabled when %s suppresses startup",
    (envKey) => {
      const monitor = startGatewayChannelHealthMonitor({
        channelManager: {} as never,
        env: { [envKey]: "1" },
      });

      expect(monitor).toBeNull();
      expect(hoisted.startChannelHealthMonitor).not.toHaveBeenCalled();
    },
  );

  function activateCronOff(
    cfgAtStart: Parameters<typeof activateGatewayScheduledServices>[0]["cfgAtStart"],
  ) {
    vi.useFakeTimers();
    const warn = vi.fn();
    activateGatewayScheduledServices({
      minimalTestGateway: false,
      cfgAtStart,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cronState: createTestCronState(createTestCron(), false),
      cronReconciliation: createTestCronReconciliation(),
      logCron: { error: vi.fn() },
      log: {
        child: vi.fn(() => ({ info: vi.fn(), warn, error: vi.fn() })),
        error: vi.fn(),
      },
    });
    return warn;
  }

  it("warns when cron is disabled but scheduled heartbeats remain enabled", () => {
    const warn = activateCronOff({ skills: { workshop: { autonomous: { mode: "off" } } } });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cron scheduler is disabled"));
  });

  it("does not warn about disabled cron when heartbeat cadence is disabled", () => {
    const warn = activateCronOff({
      agents: { defaults: { heartbeat: { every: "0m" } } },
      skills: { workshop: { autonomous: { mode: "off" } } },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["auto", true],
    ["off", false],
    ["propose", false],
  ] as const)(
    "reports cron-disabled automatic skill collection reviews for mode %s",
    (mode, shouldWarn) => {
      const warn = activateCronOff({
        agents: { defaults: { heartbeat: { every: "0m" } } },
        skills: { workshop: { autonomous: { mode } } },
      });

      if (shouldWarn) {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("scheduled skill collection reviews are disabled"),
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

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

    await waitForFast(() => expect(order).toEqual(["start", "after-start", "hook"]));
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
    const onStartError = vi.fn(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    });

    startGatewayCronWithLogging({
      cronState: createTestCronState(cron),
      cronReconciliation,
      reason: "startup",
      config: {} as never,
      onStartError,
      logCron,
    });

    await waitForFast(() =>
      expect(logCron.error).toHaveBeenCalledWith("failed to start: Error: store unavailable"),
    );
    expect(onStartError).toHaveBeenCalledOnce();
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

    await waitForFast(() =>
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

    await waitForFast(() => expect(cronReconciliation.complete).toHaveBeenCalledTimes(1));
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    if (!releaseHook) {
      throw new Error("Expected cron reconciliation hook to be pending");
    }
    releaseHook();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("activates heartbeat, cron, and delivery recovery after sidecars are ready", async () => {
    vi.useFakeTimers();
    const log = createLog();
    const resolveGatewayContext = () => undefined;
    const { cronStart, services } = activateScheduledServicesForTest({
      log,
      resolveGatewayContext,
    });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(cronStart).toHaveBeenCalledTimes(1);
    expect(services.heartbeatRunner.updateConfig).toBe(hoisted.heartbeatRunner.updateConfig);
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
      deliver: expect.any(Function),
      cfg: {},
      log: deliveryLog,
    });
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledWith({
      deps: {},
      maxEnqueuedAt: 123,
      log: sessionDeliveryLog,
      resolveGatewayContext,
    });
    const runtimeParams = hoisted.startSessionDeliveryRuntime.mock.calls[0]?.[0] as
      | {
          onSettled?: (
            entry: { id: string; sessionKey: string },
            outcome: "recovered",
          ) => Promise<void>;
        }
      | undefined;
    expect(runtimeParams?.onSettled).toBe(hoisted.settleQueuedSessionDelivery);
    await runtimeParams?.onSettled?.(
      {
        id: "settled-delivery-1",
        sessionKey: "agent:main:cron:job:run:run-1",
      },
      "recovered",
    );
    expect(hoisted.settleQueuedSessionDelivery).toHaveBeenCalledWith(
      { id: "settled-delivery-1", sessionKey: "agent:main:cron:job:run:run-1" },
      "recovered",
    );
    expect(hoisted.schedulePendingSessionDeliveries).toHaveBeenCalledTimes(1);
  });

  it("gives standalone scheduled heartbeats a resolvable gateway context", async () => {
    vi.useFakeTimers();
    const gatewayContext = {
      terminalSessions: {},
      resolveGatewayContext: () => gatewayContext,
    } as never;
    let observed: unknown = "never-ran";
    let observedClient: unknown = "never-ran";
    hoisted.runHeartbeatOnce.mockImplementationOnce(async () => {
      const scope = getPluginRuntimeGatewayRequestScope();
      observed = scope?.resolveGatewayContext?.();
      observedClient = scope?.client;
      return { status: "ran", durationMs: 1 };
    });
    const { services } = activateScheduledServicesForTest({
      resolveGatewayContext: () => gatewayContext,
    });
    const runnerParams = hoisted.startHeartbeatRunner.mock.calls[0]?.[0] as
      | { runOnce?: (opts: never) => Promise<unknown> }
      | undefined;

    await withPluginRuntimeGatewayRequestScope({ client: { id: "retired-request" } } as never, () =>
      runnerParams?.runOnce?.({} as never),
    );

    expect(observed).toBe(gatewayContext);
    expect(observedClient).toBeUndefined();
    services.heartbeatRunner.stop();
  });

  it("waits for active startup recovery before its stop handle settles", async () => {
    vi.useFakeTimers();
    let resolveRecovery: (() => void) | undefined;
    hoisted.recoverPendingDeliveries.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      return {
        recovered: 0,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      };
    });

    const { services } = activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();

    let stopped = false;
    const stopPromise = services.stopOutboundDeliveryRecovery().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    if (!resolveRecovery) {
      throw new Error("Expected outbound startup recovery resolver to be initialized");
    }
    resolveRecovery();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    services.heartbeatRunner.stop();
  });

  it("warns but holds shutdown until outbound recovery settles", async () => {
    vi.useFakeTimers();
    let resolveDrain: (() => void) | undefined;
    hoisted.drainPendingDeliveries.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDrain = resolve;
        }),
    );
    const log = createLog();
    const { services } = activateScheduledServicesForTest({ log });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();

    let firstStopped = false;
    let secondStopped = false;
    const firstStop = services.stopOutboundDeliveryRecovery().then(() => {
      firstStopped = true;
    });
    const secondStop = services.stopOutboundDeliveryRecovery().then(() => {
      secondStopped = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(firstStopped).toBe(false);
    expect(secondStopped).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(log.child.mock.results[0]?.value.warn).toHaveBeenCalledOnce();
    expect(log.child.mock.results[0]?.value.warn).toHaveBeenCalledWith(
      "delivery recovery is still pending after 5000ms; waiting before runtime teardown",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(firstStopped).toBe(false);
    expect(secondStopped).toBe(false);
    expect(log.child.mock.results[0]?.value.warn).toHaveBeenCalledOnce();

    if (!resolveDrain) {
      throw new Error("Expected outbound retry drain resolver to be initialized");
    }
    resolveDrain();
    await Promise.all([firstStop, secondStop]);
    expect(firstStopped).toBe(true);
    expect(secondStopped).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    services.heartbeatRunner.stop();
  });

  it("schedules pending session deliveries when startup recovery fails", async () => {
    vi.useFakeTimers();
    hoisted.recoverPendingRestartContinuationDeliveries.mockRejectedValueOnce(
      new Error("database busy"),
    );
    const log = createLog();
    activateScheduledServicesForTest({ log });

    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();

    expect(hoisted.schedulePendingSessionDeliveries).toHaveBeenCalledTimes(1);
    await waitForFast(() =>
      expect(log.error).toHaveBeenCalledWith(
        "Session delivery recovery failed: Error: database busy",
      ),
    );
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

  it("runs legacy migration once while clean periodic ticks keep draining canonical work", async () => {
    vi.useFakeTimers();
    const { services } = activateScheduledServicesForTest({ startCron: false });

    await vi.dynamicImportSettled();
    expect(hoisted.migrateLegacyPendingOutboundDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(hoisted.migrateLegacyPendingOutboundDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(3);
    services.heartbeatRunner.stop();
  });

  it.each([
    {
      name: "the pass skipped work",
      firstPass: { moved: 0, skipped: 1, remaining: 0 },
    },
    {
      name: "retired work remains",
      firstPass: { moved: 0, skipped: 0, remaining: 1 },
    },
  ])("retries legacy migration when $name until a clean pass completes", async ({ firstPass }) => {
    vi.useFakeTimers();
    hoisted.migrateLegacyPendingOutboundDeliveries
      .mockResolvedValueOnce(firstPass)
      .mockResolvedValueOnce({ moved: 1, skipped: 0, remaining: 0 });
    const { services } = activateScheduledServicesForTest({ startCron: false });

    await vi.dynamicImportSettled();
    expect(hoisted.migrateLegacyPendingOutboundDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.migrateLegacyPendingOutboundDeliveries).toHaveBeenCalledTimes(2);
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledTimes(2);
    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.migrateLegacyPendingOutboundDeliveries).toHaveBeenCalledTimes(2);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    services.heartbeatRunner.stop();
  });

  it("resets legacy migration completion with the scheduled-service lifecycle", async () => {
    vi.useFakeTimers();
    const first = activateScheduledServicesForTest({ startCron: false });
    await vi.dynamicImportSettled();
    expect(hoisted.migrateLegacyPendingOutboundDeliveries).toHaveBeenCalledOnce();
    await first.services.stopOutboundDeliveryRecovery();

    const second = activateScheduledServicesForTest({ startCron: false });
    await vi.dynamicImportSettled();
    expect(hoisted.migrateLegacyPendingOutboundDeliveries).toHaveBeenCalledTimes(2);
    second.services.heartbeatRunner.stop();
  });

  it.each([
    {
      name: "startup recovery deferred an existing delivery for backoff",
      deferredBackoff: 1,
    },
    {
      name: "a new delivery failed after an empty startup scan",
      deferredBackoff: 0,
    },
  ])("retries outbound deliveries when $name", async ({ deferredBackoff }) => {
    vi.useFakeTimers();
    hoisted.recoverPendingDeliveries.mockResolvedValueOnce({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff,
    });
    const { services } = activateScheduledServicesForTest({ startCron: false });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    const [drain] = hoisted.drainPendingDeliveries.mock.calls[0] ?? [];
    expect(drain).toMatchObject({
      drainKey: "gateway:outbound",
      deliver: expect.any(Function),
    });
    expect(drain?.selectEntry({ channel: "discord" } as never, Date.now())).toEqual({
      match: true,
      bypassBackoff: false,
    });
    services.heartbeatRunner.stop();
  });

  it("reconstructs conversation route authorization for a recovered delivery attempt", async () => {
    vi.useFakeTimers();
    const { services } = activateScheduledServicesForTest({ startCron: false });
    await vi.dynamicImportSettled();
    const recovery = hoisted.recoverPendingDeliveries.mock.calls[0]?.[0];
    if (!recovery) {
      throw new Error("Expected outbound recovery to start");
    }
    hoisted.deliverOutboundPayloads.mockImplementationOnce(async (params) => {
      await params.onDeliveryAttempt?.();
      return [];
    });
    const denial = new Error("conversation route reassigned");
    hoisted.assertQueuedConversationDeliveryAttemptAuthorized.mockImplementationOnce(() => {
      throw denial;
    });

    await expect(
      recovery.deliver({
        cfg: {},
        channel: "reef",
        to: "reef:molty",
        payloads: [{ text: "hello" }],
        conversationDeliveryAttemptAuthority: {
          agentId: "main",
          operationId: "operation-recovery",
          storePath: "/tmp/agent.sqlite",
          routeFingerprint: "route-recovery",
        },
      }),
    ).rejects.toBe(denial);

    expect(hoisted.assertQueuedConversationDeliveryAttemptAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        operationId: "operation-recovery",
        storePath: "/tmp/agent.sqlite",
        routeFingerprint: "route-recovery",
      }),
    );
    services.heartbeatRunner.stop();
  });

  it("uses the current runtime config when retrying queued outbound deliveries", async () => {
    vi.useFakeTimers();
    const configModule = await import("../config/config.js");
    const reloadedConfig = { channels: { discord: { enabled: false } } };
    const runtimeConfig = vi
      .spyOn(configModule, "getRuntimeConfig")
      .mockReturnValue(reloadedConfig as never);
    const { services } = activateScheduledServicesForTest({
      startCron: false,
      cfgAtStart: { channels: { discord: { enabled: true } } } as never,
    });

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({ cfg: reloadedConfig }),
      );
      expect(runtimeConfig).toHaveBeenCalledOnce();
    } finally {
      services.heartbeatRunner.stop();
      runtimeConfig.mockRestore();
    }
  });

  it("never overlaps outbound retry drains or admits work between timer firings", async () => {
    vi.useFakeTimers();
    let finishDrain: (() => void) | undefined;
    hoisted.drainPendingDeliveries.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const { services } = activateScheduledServicesForTest({ startCron: false });

    await vi.advanceTimersByTimeAsync(1_250);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(3_750);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    if (!finishDrain) {
      throw new Error("Expected the outbound retry drain to be pending");
    }
    finishDrain();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(2);
    services.heartbeatRunner.stop();
  });

  it("stops outbound delivery retry timers with the gateway lifecycle", async () => {
    vi.useFakeTimers();
    const { services } = activateScheduledServicesForTest({ startCron: false });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();

    services.heartbeatRunner.stop();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.heartbeatRunner.stop).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("skips outbound retry ticks while gateway work admission is suspended", async () => {
    vi.useFakeTimers();
    const { services } = activateScheduledServicesForTest({ startCron: false });
    await vi.advanceTimersByTimeAsync(1_250);

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    if (!suspension?.commit()) {
      throw new Error("Expected gateway suspension admission to be acquired");
    }
    await vi.advanceTimersByTimeAsync(13_750);

    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    suspension.release();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    services.heartbeatRunner.stop();
  });

  it("starts cron and records memory when post-ready maintenance fails", async () => {
    vi.useFakeTimers();
    const cron = { start: vi.fn(async () => undefined) };
    const log = createLog();
    const recordPostReadyMemory = vi.fn();

    scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        startMaintenance: vi.fn(async () => {
          throw new Error("timers unavailable");
        }),
        cronState: createTestCronState(cron),
        log,
        recordPostReadyMemory,
      }),
    );
    await vi.advanceTimersByTimeAsync(1);

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

  it("runs a scheduled idle task in an independent admitted root", async () => {
    vi.useFakeTimers();
    const activeRootCounts: number[] = [];
    const run = vi.fn(async () => {
      activeRootCounts.push(getActiveGatewayRootWorkCount());
    });

    scheduleGatewayIdleTask({
      delayMs: 25,
      retryDelayMs: 50,
      isClosing: () => false,
      isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
      run,
      log: createLog(),
      errorMessage: "idle task failed",
    });

    await vi.advanceTimersByTimeAsync(25);
    await waitForFast(() => expect(run).toHaveBeenCalledOnce());
    expect(activeRootCounts).toEqual([1]);
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("retries a scheduled idle task while request work is active", async () => {
    vi.useFakeTimers();
    const admission = tryBeginGatewayRootWorkAdmission();
    if (!admission) {
      throw new Error("Expected request work admission");
    }
    const run = vi.fn(async () => undefined);

    scheduleGatewayIdleTask({
      delayMs: 25,
      retryDelayMs: 50,
      isClosing: () => false,
      isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
      run,
      log: createLog(),
      errorMessage: "idle task failed",
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(run).not.toHaveBeenCalled();
    admission.release();
    await vi.advanceTimersByTimeAsync(49);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waitForFast(() => expect(run).toHaveBeenCalledOnce());
  });

  it("rechecks request work after joining the admitted root set", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const isBusy = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    scheduleGatewayIdleTask({
      delayMs: 25,
      retryDelayMs: 50,
      isClosing: () => false,
      isBusy,
      run,
      log: createLog(),
      errorMessage: "idle task failed",
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waitForFast(() => expect(run).toHaveBeenCalledOnce());
    expect(isBusy).toHaveBeenCalledTimes(4);
  });

  it("cancels a scheduled idle task before its delay elapses", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const handle = scheduleGatewayIdleTask({
      delayMs: 25,
      retryDelayMs: 50,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: createLog(),
      errorMessage: "idle task failed",
    });

    handle.stop();
    await vi.advanceTimersByTimeAsync(25);

    expect(run).not.toHaveBeenCalled();
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
    expect(maintenance.startMediaCleanup).not.toHaveBeenCalled();
    expect(maintenance.stopMediaCleanup).toHaveBeenCalledTimes(1);
    expect(cron.start).not.toHaveBeenCalled();
    expect(recordPostReadyMemory).not.toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.tickInterval);
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.healthInterval);
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.dedupeCleanup);
    expect(maintenance.stopMediaCleanup).toHaveBeenCalledTimes(1);
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

const createTestCron = () => ({ start: vi.fn<() => Promise<void>>(async () => {}) });

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
  const cfgAtStart = overrides.cfgAtStart ?? ({} as never);
  const services = activateGatewayScheduledServices({
    minimalTestGateway: false,
    cfgAtStart,
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
    startMediaCleanup: vi.fn(async () => undefined),
    stopMediaCleanup: vi.fn(async () => "drained" as const),
    worktreeCleanup: setInterval(() => undefined, 60_000),
    skillUsageCleanup: vi.fn(),
  };
}
