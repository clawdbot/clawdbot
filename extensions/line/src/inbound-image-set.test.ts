// Line tests cover grouping the events LINE splits one multi-image send into.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLineImageSetBuffer } from "./inbound-image-set.js";

describe("createLineImageSetBuffer", () => {
  let bufferLineImageSetPart: ReturnType<typeof createLineImageSetBuffer<string>>;
  let onDetachedFlushError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    // A fresh buffer per test: pending sets are state, and sharing them would let
    // one test's half-arrived set leak into the next.
    bufferLineImageSetPart = createLineImageSetBuffer<string>();
    onDetachedFlushError = vi.fn<(error: unknown) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the whole set and delivers it in the order the sender picked", async () => {
    const flush = vi.fn(async () => {});
    const key = "acct:set-order";
    const arrive = (messageId: string, index: number) =>
      bufferLineImageSetPart({
        key,
        messageId,
        index,
        total: 3,
        part: `image-${index}`,
        flush,
        onDetachedFlushError,
      });

    // LINE delivered index 2 before index 1 in the reported capture.
    await expect(arrive("m2", 2)).resolves.toBe(false);
    await expect(arrive("m1", 1)).resolves.toBe(false);
    expect(flush).not.toHaveBeenCalled();

    await expect(arrive("m3", 3)).resolves.toBe(true);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(
      ["image-1", "image-2", "image-3"],
      // The completing part is still inside its own request, so only the two that
      // already returned are owed a settlement.
      ["image-1", "image-2"],
    );
  });

  it("delivers what arrived when LINE never reports a total", async () => {
    const flush = vi.fn(async () => {});
    await expect(
      bufferLineImageSetPart({
        key: "acct:no-total",
        messageId: "m1",
        part: "only",
        flush,
        onDetachedFlushError,
        flushDelayMs: 1_000,
      }),
    ).resolves.toBe(false);

    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flush).toHaveBeenCalledWith(["only"], ["only"]);
  });

  it("replaces a redelivered part instead of adding a second image", async () => {
    const flush = vi.fn(async () => {});
    const key = "acct:redelivery";
    await bufferLineImageSetPart({
      key,
      messageId: "m1",
      index: 1,
      total: 2,
      part: "a",
      flush,
      onDetachedFlushError,
    });
    await bufferLineImageSetPart({
      key,
      messageId: "m1",
      index: 1,
      total: 2,
      part: "a-again",
      flush,
      onDetachedFlushError,
    });
    expect(flush).not.toHaveBeenCalled();

    await bufferLineImageSetPart({
      key,
      messageId: "m2",
      index: 2,
      total: 2,
      part: "b",
      flush,
      onDetachedFlushError,
    });

    expect(flush).toHaveBeenCalledWith(["a-again", "b"], ["a-again"]);
  });

  it("keeps two sets in flight apart", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    await bufferLineImageSetPart({
      key: "acct:set-a",
      messageId: "a1",
      index: 1,
      total: 2,
      part: "a1",
      flush: first,
      onDetachedFlushError,
    });
    await bufferLineImageSetPart({
      key: "acct:set-b",
      messageId: "b1",
      index: 1,
      total: 2,
      part: "b1",
      flush: second,
      onDetachedFlushError,
    });
    await bufferLineImageSetPart({
      key: "acct:set-a",
      messageId: "a2",
      index: 2,
      total: 2,
      part: "a2",
      flush: first,
      onDetachedFlushError,
    });

    expect(first).toHaveBeenCalledWith(["a1", "a2"], ["a1"]);
    expect(second).not.toHaveBeenCalled();
  });

  // A flush that rejects could not settle the claims it was handed, so the
  // rejection has to reach someone rather than become an unhandled one.
  it("reports a delayed flush that fails instead of swallowing the rejection", async () => {
    const failure = new Error("context build failed");
    const flush = vi.fn(async () => {
      throw failure;
    });

    await bufferLineImageSetPart({
      key: "acct:detached-failure",
      messageId: "m1",
      part: "only",
      flush,
      onDetachedFlushError,
      flushDelayMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(onDetachedFlushError).toHaveBeenCalledWith(failure);
  });

  it("takes a total that only a later part reports", async () => {
    const flush = vi.fn(async () => {});
    const key = "acct:late-total";
    await bufferLineImageSetPart({
      key,
      messageId: "m1",
      index: 1,
      part: "one",
      flush,
      onDetachedFlushError,
    });
    await expect(
      bufferLineImageSetPart({
        key,
        messageId: "m2",
        index: 2,
        total: 2,
        part: "two",
        flush,
        onDetachedFlushError,
      }),
    ).resolves.toBe(true);

    expect(flush).toHaveBeenCalledWith(["one", "two"], ["one"]);
  });
});
