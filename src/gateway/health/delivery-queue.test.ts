// Delivery queue health tests cover independent inbound and outbound diagnostic reads.
import { beforeEach, describe, expect, it, vi } from "vitest";

const countOutbound = vi.fn();
const countIngressFailed = vi.fn();
const countIngressPressure = vi.fn();

vi.mock("../../infra/delivery-queue-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/delivery-queue-sqlite.js")>();
  return {
    ...actual,
    countFailedDeliveryQueueEntries: () => countOutbound(),
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
const outboundFailed = [{ queueName: "outbound", count: 2, oldestFailedAt: 1_000 }];
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
    countOutbound.mockReset().mockReturnValue([]);
    countIngressFailed.mockReset().mockReturnValue([]);
    countIngressPressure.mockReset().mockReturnValue([]);
  });

  it.each([
    {
      name: "outbound failures when the ingress dead-letter read fails",
      arrange: () => {
        countOutbound.mockReturnValue(outboundFailed);
        countIngressFailed.mockImplementation(() => {
          throw new Error("ingress database unavailable");
        });
      },
      expected: { failed: outboundFailed },
    },
    {
      name: "ingress failures when the outbound read fails",
      arrange: () => {
        countOutbound.mockImplementation(() => {
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

  it("uses cached ingress pressure without rerunning its reader", () => {
    expect(buildDeliveryQueueHealthSummary(ingressPressure)).toEqual({
      failed: [],
      ingressPressure,
    });
    expect(countIngressPressure).not.toHaveBeenCalled();
  });
});
