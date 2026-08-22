import { vi } from "vitest";

type ActivateGatewayScheduledServices =
  typeof import("./server-runtime-services.js").activateGatewayScheduledServices;
type ScheduleGatewayPostReadyMaintenance =
  typeof import("./server-runtime-services.js").scheduleGatewayPostReadyMaintenance;

export function createRuntimeServiceTestHelpers(params: {
  activateGatewayScheduledServices: ActivateGatewayScheduledServices;
  scheduleGatewayPostReadyMaintenance: ScheduleGatewayPostReadyMaintenance;
}) {
  const waitForFast = <T>(
    callback: () => T | Promise<T>,
    options: { timeout?: number; interval?: number } = {},
  ) => vi.waitFor(callback, { interval: 1, ...options });
  const createLog = () => ({
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    warn: vi.fn(),
    error: vi.fn(),
  });
  const createTestCron = () => ({ start: vi.fn<() => Promise<void>>(async () => {}) });
  const createTestCronState = (
    cron: { start: () => Promise<void> } = createTestCron(),
    cronEnabled = true,
  ) =>
    ({
      cron,
      storePath: "/tmp/cron.json",
      cronEnabled,
    }) as never;
  const createTestCronReconciliation = (complete: () => Promise<void> = async () => {}) => {
    const completeMock = vi.fn<() => Promise<void>>(complete);
    return {
      arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete: completeMock })),
      complete: completeMock,
      invalidate: vi.fn(),
    };
  };
  const activateScheduledServicesForTest = (
    overrides: Omit<Partial<Parameters<ActivateGatewayScheduledServices>[0]>, "cronState"> = {},
  ) => {
    const cron = createTestCron();
    const cronState = createTestCronState(cron);
    const cronStart = cron.start;
    const log = overrides.log ?? createLog();
    const cfgAtStart = overrides.cfgAtStart ?? ({} as never);
    const services = params.activateGatewayScheduledServices({
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
  };
  const createPostReadyMaintenanceScheduleParams = (
    overrides: Partial<Parameters<ScheduleGatewayPostReadyMaintenance>[0]> = {},
  ): Parameters<ScheduleGatewayPostReadyMaintenance>[0] => ({
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
  });
  const createMaintenanceHandles = () => ({
    tickInterval: setInterval(() => undefined, 60_000),
    healthInterval: setInterval(() => undefined, 60_000),
    dedupeCleanup: setInterval(() => undefined, 60_000),
    startMediaCleanup: vi.fn(async () => undefined),
    stopMediaCleanup: vi.fn(async () => "drained" as const),
    worktreeCleanup: setInterval(() => undefined, 60_000),
    delegateArtifactCleanup: setInterval(() => undefined, 60_000),
    skillCuratorCleanup: vi.fn(),
  });
  return {
    activateScheduledServicesForTest,
    createLog,
    createMaintenanceHandles,
    createPostReadyMaintenanceScheduleParams,
    createTestCron,
    createTestCronReconciliation,
    createTestCronState,
    waitForFast,
  };
}
