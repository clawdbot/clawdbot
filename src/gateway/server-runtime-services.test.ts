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
    recoverPendingDeliveries: vi.fn(async () => undefined),
    deliverOutboundPayloads: vi.fn(),
  };
});

vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: hoisted.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  recoverPendingDeliveries: hoisted.recoverPendingDeliveries,
}));

vi.mock("./channel-health-monitor.js", () => ({
  startChannelHealthMonitor: hoisted.startChannelHealthMonitor,
}));

vi.mock("./model-pricing-cache.js", () => ({
  startGatewayModelPricingRefresh: hoisted.startGatewayModelPricingRefresh,
}));

const { activateGatewayScheduledServices, startGatewayRuntimeServices } =
  await import("./server-runtime-services.js");

describe("server-runtime-services", () => {
  beforeEach(() => {
    hoisted.heartbeatRunner.stop.mockClear();
    hoisted.heartbeatRunner.updateConfig.mockClear();
    hoisted.startHeartbeatRunner.mockClear();
    hoisted.startChannelHealthMonitor.mockClear();
    hoisted.startGatewayModelPricingRefresh.mockClear();
    hoisted.recoverPendingDeliveries.mockClear();
    hoisted.deliverOutboundPayloads.mockClear();
  });

  it("keeps scheduled services inert during initial runtime setup", () => {
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
    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();

    services.heartbeatRunner.stop();
    expect(hoisted.heartbeatRunner.stop).not.toHaveBeenCalled();
  });

  it("activates heartbeat, cron, and delivery recovery after sidecars are ready", async () => {
    const cron = { start: vi.fn(async () => undefined) };
    const log = createLog();

    const services = activateGatewayScheduledServices({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      cron,
      logCron: { error: vi.fn() },
      log,
    });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(cron.start).toHaveBeenCalledTimes(1);
    expect(services.heartbeatRunner).toBe(hoisted.heartbeatRunner);
    await vi.waitFor(() => {
      expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({
          deliver: hoisted.deliverOutboundPayloads,
          cfg: {},
        }),
      );
    });
  });

  it("keeps scheduled services disabled for minimal test gateways", () => {
    const cron = { start: vi.fn(async () => undefined) };

    const services = activateGatewayScheduledServices({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      cron,
      logCron: { error: vi.fn() },
      log: createLog(),
    });

    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
    expect(cron.start).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();

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
