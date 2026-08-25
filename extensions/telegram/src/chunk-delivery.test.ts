import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTelegramChunkDeliveryTracker } from "./chunk-delivery.js";

const telegramError = (errorCode: number, message: string) =>
  Object.assign(new Error(message), { error_code: errorCode });

describe("Telegram chunk delivery", () => {
  it.each([
    [telegramError(400, "content rejected"), true],
    [Object.assign(new Error("dns failed"), { code: "ENOTFOUND" }), true],
    [
      new PlatformMessageNotDispatchedError("request not started", {
        cause: new Error("transport unavailable"),
      }),
      true,
    ],
    [
      new PlatformMessageNotDispatchedError("payload rejected", {
        cause: new Error("invalid payload"),
        retryable: false,
      }),
      false,
    ],
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
      await expect(attempt).resolves.toBe("rejected");
    } else {
      await expect(attempt).rejects.toBe(error);
    }
  });

  it("throws the original error when every chunk is silently skipped", async () => {
    const invalidate = vi.fn();
    const onRejected = vi.fn();
    const onSilentSkip = vi.fn();
    const emptyError = telegramError(400, "text must be non-empty");
    const tracker = createTelegramChunkDeliveryTracker({
      invalidate,
      onRejected,
      isSilentSkip: (error) => error === emptyError,
      onSilentSkip,
      partialDeliveryResult: () => ({ visibleReplySent: true }),
    });

    await expect(
      tracker.attempt(
        async () => {
          throw emptyError;
        },
        async () => {},
      ),
    ).resolves.toBe("silent-skip");
    expect(() => tracker.finish()).toThrow(emptyError);
    expect(onSilentSkip).toHaveBeenCalledWith(emptyError);
    expect(invalidate).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("accepts a visible chunk after a silent skip", async () => {
    const emptyError = telegramError(400, "text must be non-empty");
    const record = vi.fn(async (_value: number) => {});
    const tracker = createTelegramChunkDeliveryTracker({
      invalidate: vi.fn(),
      onRejected: vi.fn(),
      isSilentSkip: (error) => error === emptyError,
      partialDeliveryResult: () => ({ visibleReplySent: true }),
    });

    await tracker.attempt(async () => {
      throw emptyError;
    }, record);
    await expect(tracker.attempt(async () => 7, record)).resolves.toBe("accepted");
    expect(() => tracker.finish()).not.toThrow();
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(7);
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
