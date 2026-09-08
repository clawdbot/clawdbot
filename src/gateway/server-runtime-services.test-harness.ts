import { vi } from "vitest";
import type { scheduleGatewayPostReadyMaintenance } from "./server-runtime-services.js";

type StartSessionDeliveryRuntime =
  typeof import("../infra/session-delivery-queue-runtime.js").startSessionDeliveryRuntime;
type StartHeartbeatRunner = typeof import("../infra/heartbeat-runner.js").startHeartbeatRunner;
type DrainPendingDeliveries =
  typeof import("../infra/outbound/delivery-queue-recovery.js").drainPendingDeliveriesCore;
type RecoverPendingDeliveries =
  typeof import("../infra/outbound/delivery-queue-recovery.js").recoverPendingDeliveries;
type MigrateLegacyPendingOutboundDeliveries =
  typeof import("../infra/outbound/delivery-queue-migration.js").migrateLegacyPendingOutboundDeliveries;

const runtimeServiceMocks = vi.hoisted(() => {
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  const stopSessionUpstreamMonitor = vi.fn();
  const stopSessionDeliveryRuntime = vi.fn(async () => {});
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
  startHeartbeatRunner: runtimeServiceMocks.startHeartbeatRunner,
  runHeartbeatOnce: runtimeServiceMocks.runHeartbeatOnce,
}));

vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: runtimeServiceMocks.startSessionUpstreamMonitor,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: runtimeServiceMocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: runtimeServiceMocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue-recovery.js", () => ({
  recoverPendingDeliveries: runtimeServiceMocks.recoverPendingDeliveries,
  drainPendingDeliveriesCore: runtimeServiceMocks.drainPendingDeliveries,
}));

vi.mock("../infra/outbound/delivery-queue-migration.js", () => ({
  migrateLegacyPendingOutboundDeliveries:
    runtimeServiceMocks.migrateLegacyPendingOutboundDeliveries,
}));

vi.mock("./conversation-route-ownership.js", () => ({
  assertQueuedConversationDeliveryAttemptAuthorized:
    runtimeServiceMocks.assertQueuedConversationDeliveryAttemptAuthorized,
}));

vi.mock("../infra/session-delivery-queue-runtime.js", () => ({
  startSessionDeliveryRuntime: runtimeServiceMocks.startSessionDeliveryRuntime,
  schedulePendingSessionDeliveries: runtimeServiceMocks.schedulePendingSessionDeliveries,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  deliverQueuedSessionDelivery: runtimeServiceMocks.deliverQueuedSessionDelivery,
  recoverPendingRestartContinuationDeliveries:
    runtimeServiceMocks.recoverPendingRestartContinuationDeliveries,
  settleQueuedSessionDelivery: runtimeServiceMocks.settleQueuedSessionDelivery,
}));

vi.mock("./channel-health-monitor.js", () => ({
  startChannelHealthMonitor: runtimeServiceMocks.startChannelHealthMonitor,
}));

// Vitest moves the declaration before imports; it rejects an exported hoisted declaration.
export { runtimeServiceMocks };

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

export function createLog() {
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

export const createTestCron = () => ({ start: vi.fn<() => Promise<void>>(async () => {}) });

export function createTestCronState(
  cron: { start: () => Promise<void> } = createTestCron(),
  cronEnabled = true,
) {
  return {
    cron,
    storePath: "/tmp/cron.json",
    cronEnabled,
  } as never;
}

export function createTestCronReconciliation(complete: () => Promise<void> = async () => {}) {
  const completeMock = vi.fn<() => Promise<void>>(complete);
  return {
    arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete: completeMock })),
    complete: completeMock,
    invalidate: vi.fn(),
  };
}

export function createPostReadyMaintenanceScheduleParams(
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

export function createMaintenanceHandles() {
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

export function resetRuntimeServiceMocks() {
  runtimeServiceMocks.heartbeatRunner.stop.mockClear();
  runtimeServiceMocks.heartbeatRunner.updateConfig.mockClear();
  runtimeServiceMocks.startHeartbeatRunner.mockClear();
  runtimeServiceMocks.runHeartbeatOnce.mockClear();
  runtimeServiceMocks.startChannelHealthMonitor.mockClear();
  runtimeServiceMocks.startSessionUpstreamMonitor.mockClear();
  runtimeServiceMocks.stopSessionUpstreamMonitor.mockClear();
  runtimeServiceMocks.stopSessionDeliveryRuntime.mockClear();
  runtimeServiceMocks.startSessionDeliveryRuntime.mockClear();
  runtimeServiceMocks.schedulePendingSessionDeliveries.mockClear();
  runtimeServiceMocks.recoverPendingDeliveries.mockReset();
  runtimeServiceMocks.recoverPendingDeliveries.mockResolvedValue({
    recovered: 0,
    failed: 0,
    skippedMaxRetries: 0,
    deferredBackoff: 0,
  });
  runtimeServiceMocks.migrateLegacyPendingOutboundDeliveries.mockReset();
  runtimeServiceMocks.migrateLegacyPendingOutboundDeliveries.mockResolvedValue({
    moved: 0,
    skipped: 0,
    remaining: 0,
  });
  runtimeServiceMocks.drainPendingDeliveries.mockReset();
  runtimeServiceMocks.drainPendingDeliveries.mockResolvedValue(undefined);
  runtimeServiceMocks.recoverPendingRestartContinuationDeliveries.mockClear();
  runtimeServiceMocks.deliverQueuedSessionDelivery.mockClear();
  runtimeServiceMocks.settleQueuedSessionDelivery.mockClear();
  runtimeServiceMocks.deliverOutboundPayloads.mockClear();
  runtimeServiceMocks.assertQueuedConversationDeliveryAttemptAuthorized.mockReset();
}
