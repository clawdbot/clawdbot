// Delivery queue health tests cover independent inbound and outbound diagnostic reads.
import { beforeEach, describe, expect, it, vi } from "vitest";

const countOutbound = vi.fn();
const countIngress = vi.fn();

vi.mock("../infra/delivery-queue-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/delivery-queue-sqlite.js")>();
  return {
    ...actual,
    countFailedDeliveryQueueEntries: () => countOutbound(),
  };
});

vi.mock("../channels/message/ingress-queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/message/ingress-queue.js")>();
  return {
    ...actual,
    countFailedChannelIngressQueueEntries: () => countIngress(),
  };
});

const { buildDeliveryQueueHealthSummary } = await import("./health.js");

describe("buildDeliveryQueueHealthSummary", () => {
  beforeEach(() => {
    countOutbound.mockReset().mockReturnValue([]);
    countIngress.mockReset().mockReturnValue([]);
  });

  it("preserves outbound failures when the ingress health read fails", () => {
    countOutbound.mockReturnValue([{ queueName: "outbound", count: 2, oldestFailedAt: 1_000 }]);
    countIngress.mockImplementation(() => {
      throw new Error("ingress database unavailable");
    });

    expect(buildDeliveryQueueHealthSummary()).toEqual({
      failed: [{ queueName: "outbound", count: 2, oldestFailedAt: 1_000 }],
    });
  });

  it("preserves ingress failures when the outbound health read fails", () => {
    countOutbound.mockImplementation(() => {
      throw new Error("outbound database unavailable");
    });
    countIngress.mockReturnValue([
      { channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 2_000 },
    ]);

    expect(buildDeliveryQueueHealthSummary()).toEqual({
      failed: [],
      ingressFailed: [{ channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 2_000 }],
    });
  });
});
