import { describe, expect, it, vi } from "vitest";
import { runQaSuiteRoundTripProbe } from "./suite-round-trip.js";

describe("QA suite round-trip probe", () => {
  it("collects requested samples and chains native replies", async () => {
    const messages: Array<{ direction: "outbound"; id: string }> = [];
    const sendInbound = vi.fn().mockResolvedValue({ id: "inbound" });
    const waitForOutbound = vi.fn().mockImplementation(async () => {
      const reply = { id: `out-${messages.length + 1}` };
      messages.push({ direction: "outbound", id: reply.id });
      return reply;
    });

    const result = await runQaSuiteRoundTripProbe({
      probe: {
        scenarioId: "channel-canary",
        count: 2,
        maxFailures: 2,
        timeoutMs: 1_000,
        markerPrefix: "QA-RTT",
        input: {
          conversation: { id: "room", kind: "group" },
          senderId: "driver",
        },
        textPrefix: "Reply exactly: ",
        chainReplies: true,
      },
      transport: {
        state: {
          getSnapshot: () => ({ messages }),
        },
        sendInbound,
        waitForOutbound,
      } as never,
    });

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.timing.samples).toBe(2);
    expect(sendInbound.mock.calls[1]?.[0]).toMatchObject({ replyToId: "out-1" });
  });

  it("stops when the failure budget is exhausted", async () => {
    const result = await runQaSuiteRoundTripProbe({
      probe: {
        scenarioId: "channel-canary",
        count: 3,
        maxFailures: 1,
        timeoutMs: 10,
        markerPrefix: "QA-RTT",
        input: {
          conversation: { id: "room", kind: "group" },
          senderId: "driver",
        },
        textPrefix: "Reply exactly: ",
      },
      transport: {
        state: { getSnapshot: () => ({ messages: [] }) },
        sendInbound: vi.fn(),
        waitForOutbound: vi.fn().mockRejectedValue(new Error("timeout")),
      } as never,
    });

    expect(result).toMatchObject({ passed: 0, failed: 1 });
  });
});
