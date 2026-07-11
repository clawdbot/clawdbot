/**
 * Tests delivery queue runtime ordering and retry behavior.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";

const mocks = vi.hoisted(() => ({
  coreDrainPendingDeliveries: vi.fn(async () => {}),
  deliverOutboundPayloads: vi.fn(async () => []),
  deliverRuntimeModuleLoads: 0,
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  drainPendingDeliveries: mocks.coreDrainPendingDeliveries,
}));

vi.mock("../infra/outbound/deliver-runtime.js", () => {
  mocks.deliverRuntimeModuleLoads += 1;
  return {
    deliverOutboundPayloads: mocks.deliverOutboundPayloads,
    deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
  };
});

type DeliveryQueueRuntimeModule = typeof import("./delivery-queue-runtime.js");

let drainPendingDeliveries: DeliveryQueueRuntimeModule["drainPendingDeliveries"];

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeAll(async () => {
  ({ drainPendingDeliveries } = await import("./delivery-queue-runtime.js"));
});

beforeEach(() => {
  resetGatewayWorkAdmission();
  mocks.coreDrainPendingDeliveries.mockReset().mockResolvedValue(undefined);
  mocks.deliverOutboundPayloads.mockReset().mockResolvedValue([]);
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});

afterEach(resetGatewayWorkAdmission);

describe("plugin-sdk delivery queue drainPendingDeliveries", () => {
  it("defers lazy runtime resolution and core draining while suspension is prepared", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    const pending = drainPendingDeliveries({
      drainKey: "demo:test",
      logLabel: "Demo reconnect drain",
      cfg: {},
      log,
      selectEntry: () => ({ match: false }),
    });
    await Promise.resolve();

    expect(mocks.deliverRuntimeModuleLoads).toBe(0);
    expect(mocks.coreDrainPendingDeliveries).not.toHaveBeenCalled();

    expect(suspension?.release()).toBe(true);
    await pending;

    expect(mocks.deliverRuntimeModuleLoads).toBe(1);
    expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("counts a reconnect drain independently from its admitted parent", async () => {
    let finishDrain = () => {};
    const drainStarted = new Promise<void>((resolveStarted) => {
      mocks.coreDrainPendingDeliveries.mockImplementationOnce(
        () =>
          new Promise<void>((resolveDrain) => {
            finishDrain = resolveDrain;
            resolveStarted();
          }),
      );
    });
    const deliver = vi.fn(async () => []);

    await runWithGatewayRootWorkAdmission(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      const pending = drainPendingDeliveries({
        drainKey: "demo:test",
        logLabel: "Demo reconnect drain",
        cfg: {},
        log,
        deliver,
        selectEntry: () => ({ match: false }),
      });
      await drainStarted;

      expect(getActiveGatewayRootWorkCount()).toBe(2);
      finishDrain();
      await pending;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    });

    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("releases its independent root when the core drain rejects", async () => {
    mocks.coreDrainPendingDeliveries.mockImplementationOnce(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      throw new Error("drain failed");
    });

    await expect(
      drainPendingDeliveries({
        drainKey: "demo:test",
        logLabel: "Demo reconnect drain",
        cfg: {},
        log,
        deliver: vi.fn(async () => []),
        selectEntry: () => ({ match: false }),
      }),
    ).rejects.toThrow("drain failed");

    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("injects the lazy outbound deliver runtime when no deliver fn is provided", async () => {
    await drainPendingDeliveries({
      drainKey: "demo:test",
      logLabel: "Demo reconnect drain",
      cfg: {},
      log,
      selectEntry: () => ({ match: false }),
    });

    expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledTimes(1);
    const [[{ deliver: lazyDeliver }]] = mocks.coreDrainPendingDeliveries.mock
      .calls as unknown as Array<[{ deliver?: unknown }]>;
    expect(lazyDeliver).toBe(mocks.deliverOutboundPayloads);
  });

  it("preserves an explicit deliver fn without loading the lazy runtime", async () => {
    const deliver = vi.fn(async () => []);

    await drainPendingDeliveries({
      drainKey: "demo:test",
      logLabel: "Demo reconnect drain",
      cfg: {},
      log,
      deliver,
      selectEntry: () => ({ match: false }),
    });

    expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledTimes(1);
    const [[{ deliver: explicitDeliver }]] = mocks.coreDrainPendingDeliveries.mock
      .calls as unknown as Array<[{ deliver?: unknown }]>;
    expect(explicitDeliver).toBe(deliver);
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
