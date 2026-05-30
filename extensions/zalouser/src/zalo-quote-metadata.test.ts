import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing as zaloTesting } from "./zalo-js.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Zalo quote metadata extraction (#86851)", () => {
  it("extracts quote id, owner, and body from zca-js message data", () => {
    const message = zaloTesting.toInboundMessage(
      {
        type: 0,
        data: {
          uidFrom: "123456789",
          idTo: "987654321",
          content: "ok",
          ts: 1_764_000_000_000,
          quote: {
            globalMsgId: 987654321234,
            ownerId: "555444333_2",
            msg: "Previous bot message content",
          },
        },
      } as unknown as Parameters<typeof zaloTesting.toInboundMessage>[0],
      "555444333",
    );

    expect(message?.quotedGlobalMsgId).toBe("987654321234");
    expect(message?.quotedOwnerId).toBe("555444333");
    expect(message?.quotedBody).toBe("Previous bot message content");
    expect(message?.implicitMention).toBe(true);
  });

  it("omits quote metadata when the zca-js quote object is absent", () => {
    const message = zaloTesting.toInboundMessage({
      type: 0,
      data: {
        uidFrom: "123456789",
        idTo: "987654321",
        content: "plain message",
        ts: 1_764_000_000_000,
      },
    } as unknown as Parameters<typeof zaloTesting.toInboundMessage>[0]);

    expect(message?.quotedGlobalMsgId).toBeUndefined();
    expect(message?.quotedOwnerId).toBeUndefined();
    expect(message?.quotedBody).toBeUndefined();
  });
});

describe("Zalo inbound timestamp normalization", () => {
  function inboundTimestamp(ts: unknown): number | undefined {
    return zaloTesting.toInboundMessage({
      type: 0,
      data: {
        uidFrom: "123456789",
        idTo: "987654321",
        content: "plain message",
        ts,
      },
    } as unknown as Parameters<typeof zaloTesting.toInboundMessage>[0])?.timestampMs;
  }

  it("normalizes second and millisecond timestamps", () => {
    expect(inboundTimestamp(1_764_000_000)).toBe(1_764_000_000_000);
    expect(inboundTimestamp("1764000000.5")).toBe(1_764_000_000_500);
    expect(inboundTimestamp(1_764_000_000_000)).toBe(1_764_000_000_000);
  });

  it("falls back for partial or unsafe timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    expect(inboundTimestamp("1764000000abc")).toBe(1_700_000_000_000);
    expect(inboundTimestamp("9007199254740993")).toBe(1_700_000_000_000);
  });
});
