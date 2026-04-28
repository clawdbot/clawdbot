import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  return {
    heartbeatRunner,
    startHeartbeatRunner: vi.fn(() => heartbeatRunner),
    startChannelHealthMonitor: vi.fn(() => ({ stop: vi.fn() })),
    startGatewayModelPricingRefresh: vi.fn(() => vi.fn()),
    loadModelPricingCacheModule: vi.fn(),
    isVitestRuntimeEnv: vi.fn(() => false),
    recoverPendingDeliveries: vi.fn(async () => undefined),
    recoverPendingRestartContinuationDeliveries: vi.fn(async () => undefined),
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
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  recoverPendingDeliveries: hoisted.recoverPendingDeliveries,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  recoverPendingRestartContinuationDeliveries: hoisted.recoverPendingRestartContinuationDeliveries,
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

const { activateGatewayScheduledServices, startGatewayRuntimeServices } =
  await import("./server-runtime-services.js");

describe("server-runtime-services", () => {
  beforeEach(() => {
    vi.useRealTimers();
    hoisted.heartbeatRunner.stop.mockClear();
    hoisted.heartbeatRunner.updateConfig.mockClear();
    hoisted.startHeartbeatRunner.mockClear();
    hoisted.startChannelHealthMonitor.mockClear();
    hoisted.startGatewayModelPricingRefresh.mockClear();
    hoisted.loadModelPricingCacheModule.mockClear();
    hoisted.isVitestRuntimeEnv.mockReset().mockReturnValue(false);
    hoisted.recoverPendingDeliveries.mockClear();
    hoisted.recoverPendingRestartContinuationDeliveries.mockClear();
    hoisted.deliverOutboundPayloads.mockClear();
  });

  it("skips model pricing bootstrap import when pricing is disabled", async () => {
    startGatewayRuntimeServices({
      minimalTestGateway: false,
      cfgAtStart: { models: { pricing: { enabled: false } } } as never,
      channelManager: {
        getRuntimeSnapshot: vi.fn(),
        isHealthMonitorEnabled: vi.fn(),
        isManuallyStopped: vi.fn(),
      } as never,
      log: createLog(),
    });

    await vi.dynamicImportSettled();

    expect(hoisted.loadModelPricingCacheModule).not.toHaveBeenCalled();
    expect(hoisted.startGatewayModelPricingRefresh).not.toHaveBeenCalled();
  });

  it("keeps scheduled services inert during initial runtime setup", async () => {
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
    await vi.dynamicImportSettled();
    expect(hoisted.startGatewayModelPricingRefresh).toHaveBeenCalledWith({ config: {} });
    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();

    services.heartbeatRunner.stop();
    expect(hoisted.heartbeatRunner.stop).not.toHaveBeenCalled();
  });

  it("passes startup plugin lookup metadata to the initial pricing refresh", async () => {
    const pluginLookUpTable = {
      index: { plugins: [] },
      manifestRegistry: { plugins: [], diagnostics: [] },
    };

    startGatewayRuntimeServices({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      channelManager: {
        getRuntimeSnapshot: vi.fn(),
        isHealthMonitorEnabled: vi.fn(),
        isManuallyStopped: vi.fn(),
      } as never,
      log: createLog(),
      pluginLookUpTable: pluginLookUpTable as never,
    });

    await vi.dynamicImportSettled();
    expect(hoisted.startGatewayModelPricingRefresh).toHaveBeenCalledWith({
      config: {},
      pluginLookUpTable,
    });
  });

  it("does not start model pricing refresh after early stop", async () => {
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

    services.stopModelPricingRefresh();
    await vi.dynamicImportSettled();

    expect(hoisted.startGatewayModelPricingRefresh).not.toHaveBeenCalled();
  });

  it("activates heartbeat, cron, and delivery recovery after sidecars are ready", async () => {
    vi.useFakeTimers();
    const cron = { start: vi.fn(async () => undefined) };
    const log = createLog();

    const services = activateGatewayScheduledServices({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cron,
      logCron: { error: vi.fn() },
      log,
    });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(cron.start).toHaveBeenCalledTimes(1);
    expect(services.heartbeatRunner).toBe(hoisted.heartbeatRunner);
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: hoisted.deliverOutboundPayloads,
        cfg: {},
      }),
    );
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        deps: {},
        maxEnqueuedAt: 123,
      }),
    );
  });

  it("keeps scheduled services disabled for minimal test gateways", () => {
    const cron = { start: vi.fn(async () => undefined) };

    const services = activateGatewayScheduledServices({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cron,
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
    error: vi.fn(),
  };
}
