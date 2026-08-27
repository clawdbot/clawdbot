import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  const stopFollowupQueueRecovery = vi.fn();
  return {
    heartbeatRunner,
    startHeartbeatRunner: vi.fn(() => heartbeatRunner),
    runHeartbeatOnce: vi.fn(async () => ({ status: "ran" as const, durationMs: 1 })),
    stopFollowupQueueRecovery,
    scheduleRestoredFollowupQueueRecovery: vi.fn(() => stopFollowupQueueRecovery),
    startSessionUpstreamMonitor: vi.fn(() => ({ stop: vi.fn() })),
    startSessionDeliveryRuntime: vi.fn(() => vi.fn()),
    schedulePendingSessionDeliveries: vi.fn(async () => undefined),
    recoverPendingDeliveries: vi.fn(async () => ({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    })),
    drainPendingDeliveries: vi.fn(async () => undefined),
    migrateLegacyPendingOutboundDeliveries: vi.fn(async () => ({
      moved: 0,
      skipped: 0,
      remaining: 0,
    })),
    recoverPendingRestartContinuationDeliveries: vi.fn(async () => undefined),
    deliverQueuedSessionDelivery: vi.fn(async () => undefined),
    settleQueuedSessionDelivery: vi.fn(async () => undefined),
  };
});

vi.mock("../infra/heartbeat-runner.js", () => ({
  resolveHeartbeatAgents: () => [],
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
  runHeartbeatOnce: hoisted.runHeartbeatOnce,
}));

vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: hoisted.startSessionUpstreamMonitor,
}));

vi.mock("../infra/session-delivery-queue-runtime.js", () => ({
  startSessionDeliveryRuntime: hoisted.startSessionDeliveryRuntime,
  schedulePendingSessionDeliveries: hoisted.schedulePendingSessionDeliveries,
}));

vi.mock("../infra/outbound/delivery-queue-recovery.js", () => ({
  recoverPendingDeliveries: hoisted.recoverPendingDeliveries,
  drainPendingDeliveriesCore: hoisted.drainPendingDeliveries,
}));

vi.mock("../infra/outbound/delivery-queue-migration.js", () => ({
  migrateLegacyPendingOutboundDeliveries: hoisted.migrateLegacyPendingOutboundDeliveries,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  deliverQueuedSessionDelivery: hoisted.deliverQueuedSessionDelivery,
  recoverPendingRestartContinuationDeliveries: hoisted.recoverPendingRestartContinuationDeliveries,
  settleQueuedSessionDelivery: hoisted.settleQueuedSessionDelivery,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn(),
  deliverOutboundPayloadsInternal: vi.fn(),
}));

vi.mock("./conversation-route-ownership.js", () => ({
  assertQueuedConversationDeliveryAttemptAuthorized: vi.fn(),
}));

vi.mock("./server-followup-queue-recovery.js", () => ({
  scheduleRestoredFollowupQueueRecovery: hoisted.scheduleRestoredFollowupQueueRecovery,
}));

const { activateGatewayScheduledServices } = await import("./server-runtime-services.js");

describe("gateway followup-queue recovery lifecycle", () => {
  beforeEach(() => {
    hoisted.heartbeatRunner.stop.mockClear();
    hoisted.startHeartbeatRunner.mockClear();
    hoisted.scheduleRestoredFollowupQueueRecovery.mockClear();
    hoisted.stopFollowupQueueRecovery.mockClear();
  });

  it("does not schedule restored-queue recovery on a minimal gateway", () => {
    activateGatewayScheduledServices({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cronState: { cron: { start: vi.fn() }, cronEnabled: true } as never,
      cronReconciliation: { arm: vi.fn(), complete: vi.fn(), invalidate: vi.fn() } as never,
      logCron: { error: vi.fn() },
      log: {
        child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
        error: vi.fn(),
      },
    });

    expect(hoisted.scheduleRestoredFollowupQueueRecovery).not.toHaveBeenCalled();
  });

  it("disposes followup-queue recovery before the heartbeat runner stops", () => {
    const services = activateGatewayScheduledServices({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cronState: { cron: { start: vi.fn(async () => {}) }, cronEnabled: true } as never,
      cronReconciliation: {
        arm: vi.fn(() => ({ complete: vi.fn(async () => {}) })),
        complete: vi.fn(),
        invalidate: vi.fn(),
      } as never,
      startCron: false,
      logCron: { error: vi.fn() },
      log: {
        child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
        error: vi.fn(),
      },
    });

    expect(hoisted.scheduleRestoredFollowupQueueRecovery).toHaveBeenCalledOnce();
    expect(hoisted.stopFollowupQueueRecovery).not.toHaveBeenCalled();

    services.heartbeatRunner.stop();

    expect(hoisted.stopFollowupQueueRecovery).toHaveBeenCalledOnce();
    expect(hoisted.heartbeatRunner.stop).toHaveBeenCalledOnce();
    expect(hoisted.stopFollowupQueueRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.heartbeatRunner.stop.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
