// Delivery queue health tests cover independent terminal, inbound, and pressure reads.
import { beforeEach, describe, expect, it, vi } from "vitest";

const summarizeOutbound = vi.fn();
const maintenanceHealth = vi.fn();
const countIngressFailed = vi.fn();
const countIngressPressure = vi.fn();

vi.mock("../../infra/delivery-queue-failure-summary.js", () => ({
  summarizeDeliveryFailureQueues: () => summarizeOutbound(),
}));

vi.mock("../../infra/delivery-queue-failure-maintenance.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/delivery-queue-failure-maintenance.js")>();
  return {
    ...actual,
    getDeliveryFailureMaintenanceHealth: () => maintenanceHealth(),
  };
});

vi.mock("../../channels/message/ingress-queue-health.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../channels/message/ingress-queue-health.js")>();
  return {
    ...actual,
    countFailedChannelIngressQueueEntries: () => countIngressFailed(),
    countChannelIngressQueuePressure: () => countIngressPressure(),
  };
});

const { buildDeliveryQueueHealthSummary } = await import("./delivery-queue.js");
const outboundSummary = [
  {
    queueName: "outbound",
    count: 2,
    oldestFailedAt: 1_000,
    full: 2,
    compacted: 0,
    safe: 2,
    ambiguous: 0,
    ownerManaged: 0,
    ownerCleanupPending: 0,
    fenceNone: 2,
    fencePermanent: 0,
    fenceProducerBounded: 0,
    legacyUnknown: 0,
    payloadBearing: 2,
    oldestPayloadFailedAt: 1_000,
  },
];
const outboundHealth = outboundSummary;
const ingressFailed = [
  { channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 2_000 },
];
const ingressPressure = [
  {
    channelId: "telegram",
    accountId: "ops",
    laneCount: 1,
    pendingCount: 56,
    claimedCount: 0,
    blockedCount: 55,
    oldestReceivedAt: 1_000,
  },
];

describe("buildDeliveryQueueHealthSummary", () => {
  beforeEach(() => {
    summarizeOutbound.mockReset().mockReturnValue([]);
    maintenanceHealth.mockReset().mockReturnValue({ runAt: 0, errors: 0 });
    countIngressFailed.mockReset().mockReturnValue([]);
    countIngressPressure.mockReset().mockReturnValue([]);
  });

  it.each([
    {
      name: "terminal failures when the ingress dead-letter read fails",
      arrange: () => {
        summarizeOutbound.mockReturnValue(outboundSummary);
        countIngressFailed.mockImplementation(() => {
          throw new Error("ingress database unavailable");
        });
      },
      expected: { failed: outboundHealth },
    },
    {
      name: "ingress failures when the terminal summary read fails",
      arrange: () => {
        summarizeOutbound.mockImplementation(() => {
          throw new Error("outbound database unavailable");
        });
        countIngressFailed.mockReturnValue(ingressFailed);
      },
      expected: { failed: [], ingressFailed },
    },
    {
      name: "dead letters when the ingress pressure read fails",
      arrange: () => {
        countIngressFailed.mockReturnValue(ingressFailed);
        countIngressPressure.mockImplementation(() => {
          throw new Error("ingress pressure read unavailable");
        });
      },
      expected: { failed: [], ingressFailed },
    },
    {
      name: "ingress pressure when the dead-letter read fails",
      arrange: () => {
        countIngressFailed.mockImplementation(() => {
          throw new Error("ingress failed read unavailable");
        });
        countIngressPressure.mockReturnValue(ingressPressure);
      },
      expected: { failed: [], ingressPressure },
    },
  ])("preserves $name", ({ arrange, expected }) => {
    arrange();
    expect(buildDeliveryQueueHealthSummary()).toEqual(expected);
  });

  it("surfaces terminal maintenance errors without queue rows", () => {
    maintenanceHealth.mockReturnValue({ runAt: 3_000, errors: 1 });

    expect(buildDeliveryQueueHealthSummary()).toEqual({
      failed: [],
      maintenance: { lastRunAt: 3_000, errors: 1 },
    });
  });

  it("uses cached ingress pressure without rerunning its reader", () => {
    expect(buildDeliveryQueueHealthSummary(ingressPressure)).toEqual({
      failed: [],
      ingressPressure,
    });
    expect(countIngressPressure).not.toHaveBeenCalled();
  });
});
