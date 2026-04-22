import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coreDrainPendingDeliveries: vi.fn(async () => {}),
  deliverOutboundPayloads: vi.fn(async () => []),
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  drainPendingDeliveries: mocks.coreDrainPendingDeliveries,
}));

vi.mock("../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

type InfraRuntimeModule = typeof import("./infra-runtime.js");

let drainPendingDeliveries: InfraRuntimeModule["drainPendingDeliveries"];

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeAll(async () => {
  ({ drainPendingDeliveries } = await import("./infra-runtime.js"));
});

beforeEach(() => {
  mocks.coreDrainPendingDeliveries.mockClear();
  mocks.deliverOutboundPayloads.mockClear();
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});

describe("plugin-sdk drainPendingDeliveries", () => {
  it("injects the lazy outbound deliver runtime when no deliver fn is provided", async () => {
    await drainPendingDeliveries({
      drainKey: "demo:test",
      logLabel: "Demo reconnect drain",
      cfg: {},
      log,
      selectEntry: () => ({ match: false }),
    });

    expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: mocks.deliverOutboundPayloads,
      }),
    );
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

    expect(mocks.coreDrainPendingDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver,
      }),
    );
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
