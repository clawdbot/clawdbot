import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import { createTelegramChunkDeliveryTracker } from "./chunk-delivery.js";

const telegramError = (errorCode: number, message: string) =>
  Object.assign(new Error(message), { error_code: errorCode });

describe("Telegram chunk delivery", () => {
  it.each([
    [telegramError(400, "content rejected"), true],
    [Object.assign(new Error("dns failed"), { code: "ENOTFOUND" }), true],
    [telegramError(400, "message thread not found"), false],
    [telegramError(401, "unauthorized"), false],
    [telegramError(429, "rate limited"), false],
    [telegramError(500, "server error"), false],
    [new Error("ambiguous transport failure"), false],
  ])("classifies %s as skippable=%s", async (error, expected) => {
    const tracker = createTelegramChunkDeliveryTracker({
      invalidate: vi.fn(),
      onRejected: vi.fn(),
      partialDeliveryResult: () => ({ visibleReplySent: true }),
    });
    const attempt = tracker.attempt(
      async () => {
        throw error;
      },
      async () => {},
    );

    if (expected) {
      await expect(attempt).resolves.toBe(false);
    } else {
      await expect(attempt).rejects.toBe(error);
    }
  });

  it("drains skippable failures then reports accepted partial delivery", async () => {
    const invalidate = vi.fn();
    const onRejected = vi.fn();
    const record = vi.fn(async (_value: number) => {});
    const tracker = createTelegramChunkDeliveryTracker({
      invalidate,
      onRejected,
      partialDeliveryResult: () => ({ messageIds: ["1", "3"], visibleReplySent: true }),
    });

    await tracker.attempt(async () => 1, record);
    await tracker.attempt(async () => {
      throw telegramError(400, "content rejected");
    }, record);
    await tracker.attempt(async () => 3, record);

    let observed: unknown;
    try {
      tracker.finish();
    } catch (error) {
      observed = error;
    }
    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(onRejected).toHaveBeenCalledOnce();
    expect(record.mock.calls.map(([value]) => value)).toEqual([1, 3]);
  });

  it("stops after accepted-send bookkeeping fails", async () => {
    const tracker = createTelegramChunkDeliveryTracker({
      invalidate: vi.fn(),
      onRejected: vi.fn(),
      partialDeliveryResult: () => ({ visibleReplySent: true }),
    });

    let observed: unknown;
    try {
      await tracker.attempt(
        async () => 1,
        async () => {
          throw new Error("observer failed");
        },
      );
    } catch (error) {
      observed = error;
    }
    expect(isChannelPartialDeliveryError(observed)).toBe(true);
  });
});
