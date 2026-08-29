// Line tests cover grouping the events LINE splits one multi-image send into.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLineImageSetBuffer } from "./inbound-image-set.js";

describe("createLineImageSetBuffer", () => {
  let bufferLineImageSetPart: ReturnType<typeof createLineImageSetBuffer<string>>;

  beforeEach(() => {
    vi.useFakeTimers();
    // A fresh buffer per test: pending sets are state, and sharing them would let
    // one test's half-arrived set leak into the next.
    bufferLineImageSetPart = createLineImageSetBuffer<string>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the whole set and delivers it in the order the sender picked", async () => {
    const key = "acct:set-order";
    const arrive = (messageId: string, index: number) =>
      bufferLineImageSetPart({ key, messageId, index, total: 3, part: `image-${index}` });

    // LINE delivered index 2 before index 1 in the reported capture. The first
    // part to arrive holds the set open; it is the one that resolves with it.
    const held = arrive("m2", 2);
    await expect(arrive("m1", 1)).resolves.toBeNull();
    await expect(arrive("m3", 3)).resolves.toBeNull();

    await expect(held).resolves.toEqual(["image-1", "image-2", "image-3"]);
  });

  it("delivers what arrived when LINE never reports a total", async () => {
    const held = bufferLineImageSetPart({
      key: "acct:no-total",
      messageId: "m1",
      part: "only",
      flushDelayMs: 1_000,
    });

    // Nothing completes the set, so only the wait expiring can deliver it.
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(held).resolves.toEqual(["only"]);
  });

  it("replaces a redelivered part instead of adding a second image", async () => {
    const key = "acct:redelivery";
    const held = bufferLineImageSetPart({ key, messageId: "m1", index: 1, total: 2, part: "a" });
    await expect(
      bufferLineImageSetPart({ key, messageId: "m1", index: 1, total: 2, part: "a-again" }),
    ).resolves.toBeNull();
    await expect(
      bufferLineImageSetPart({ key, messageId: "m2", index: 2, total: 2, part: "b" }),
    ).resolves.toBeNull();

    await expect(held).resolves.toEqual(["a-again", "b"]);
  });

  it("keeps two sets in flight apart", async () => {
    const setA = bufferLineImageSetPart({
      key: "acct:set-a",
      messageId: "a1",
      index: 1,
      total: 2,
      part: "a1",
    });
    const setB = bufferLineImageSetPart({
      key: "acct:set-b",
      messageId: "b1",
      index: 1,
      total: 2,
      part: "b1",
      flushDelayMs: 5_000,
    });
    await expect(
      bufferLineImageSetPart({
        key: "acct:set-a",
        messageId: "a2",
        index: 2,
        total: 2,
        part: "a2",
      }),
    ).resolves.toBeNull();

    await expect(setA).resolves.toEqual(["a1", "a2"]);

    // Set B is untouched by set A completing, and still waiting on its own timer.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(setB).resolves.toEqual(["b1"]);
  });

  it("takes a total that only a later part reports", async () => {
    const key = "acct:late-total";
    const held = bufferLineImageSetPart({ key, messageId: "m1", index: 1, part: "one" });
    await expect(
      bufferLineImageSetPart({ key, messageId: "m2", index: 2, total: 2, part: "two" }),
    ).resolves.toBeNull();

    await expect(held).resolves.toEqual(["one", "two"]);
  });

  // The holder's dispatch is what keeps a live ingress adoption open for the
  // combined turn, so exactly one part may hold and the rest must not wait.
  it("holds the set on its first part only", async () => {
    const key = "acct:single-holder";
    const held = bufferLineImageSetPart({
      key,
      messageId: "m1",
      index: 1,
      total: 3,
      part: "one",
      flushDelayMs: 1_000,
    });
    let holderResolved = false;
    void held.then(() => {
      holderResolved = true;
    });

    await expect(
      bufferLineImageSetPart({ key, messageId: "m2", index: 2, total: 3, part: "two" }),
    ).resolves.toBeNull();
    expect(holderResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(held).resolves.toEqual(["one", "two"]);
  });
});
