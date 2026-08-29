// Line tests cover grouping the durable claims LINE splits one multi-image send into.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLineImageSetIngressBuffer } from "./inbound-image-set.js";

describe("createLineImageSetIngressBuffer", () => {
  let buffer: ReturnType<typeof createLineImageSetIngressBuffer<string, string>>;

  beforeEach(() => {
    vi.useFakeTimers();
    // A fresh buffer per test: pending sets are state, and sharing them would let
    // one test's half-arrived set leak into the next.
    buffer = createLineImageSetIngressBuffer<string, string>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const arrive = (params: {
    index: number;
    total?: number;
    laneKey?: string;
    setId?: string;
    flushDelayMs?: number;
  }) =>
    buffer.admit({
      laneKey: params.laneKey ?? "user:U1",
      setId: params.setId ?? "set-1",
      messageId: `m${params.index}`,
      index: params.index,
      event: `image-${params.index}`,
      lifecycle: `claim-${params.index}`,
      ...(params.total === undefined ? {} : { total: params.total }),
      ...(params.flushDelayMs === undefined ? {} : { flushDelayMs: params.flushDelayMs }),
    });

  it("hands the holder the whole set, in the order the sender picked", async () => {
    // LINE delivered index 2 before index 1 in the reported capture.
    const held = arrive({ index: 2, total: 3 });
    await expect(arrive({ index: 1, total: 3 })).resolves.toBeNull();
    await expect(arrive({ index: 3, total: 3 })).resolves.toBeNull();

    await expect(held).resolves.toMatchObject({
      events: ["image-1", "image-2", "image-3"],
      // Every part's claim travels with it, so one turn can own them all.
      lifecycles: ["claim-1", "claim-2", "claim-3"],
    });
  });

  it("delivers what arrived when LINE never reports a total", async () => {
    const held = arrive({ index: 1, flushDelayMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(held).resolves.toMatchObject({ events: ["image-1"] });
  });

  it("replaces a redelivered part instead of adding a second image", async () => {
    const held = arrive({ index: 1, total: 2 });
    await expect(
      buffer.admit({
        laneKey: "user:U1",
        setId: "set-1",
        messageId: "m1",
        index: 1,
        total: 2,
        event: "image-1-again",
        lifecycle: "claim-1-again",
      }),
    ).resolves.toBeNull();
    await expect(arrive({ index: 2, total: 2 })).resolves.toBeNull();

    await expect(held).resolves.toMatchObject({ events: ["image-1-again", "image-2"] });
  });

  it("keeps sets on different lanes apart", async () => {
    const senderA = arrive({ index: 1, total: 2, laneKey: "user:UA", setId: "set-a" });
    const senderB = arrive({
      index: 1,
      laneKey: "user:UB",
      setId: "set-b",
      flushDelayMs: 5_000,
    });
    await expect(
      arrive({ index: 2, total: 2, laneKey: "user:UA", setId: "set-a" }),
    ).resolves.toBeNull();

    await expect(senderA).resolves.toMatchObject({ events: ["image-1", "image-2"] });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(senderB).resolves.toMatchObject({ events: ["image-1"] });
  });

  it("takes a total that only a later part reports", async () => {
    const held = arrive({ index: 1 });
    await expect(arrive({ index: 2, total: 2 })).resolves.toBeNull();

    await expect(held).resolves.toMatchObject({ events: ["image-1", "image-2"] });
  });

  it("holds the set on its first part only", async () => {
    const held = arrive({ index: 1, total: 3, flushDelayMs: 1_000 });
    let holderResolved = false;
    void held.then(() => {
      holderResolved = true;
    });

    await expect(arrive({ index: 2, total: 3 })).resolves.toBeNull();
    expect(holderResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(held).resolves.toMatchObject({ events: ["image-1", "image-2"] });
  });

  // Between the holder taking its parts and finishing delivery, the entry is still
  // on the lane. A late part matching that set must not join it - those parts are
  // already the turn, so it would be dropped and its claim left unsettled.
  it("starts a new set for a part arriving after the holder took the last one", async () => {
    const held = arrive({ index: 1, total: 2, flushDelayMs: 1_000 });
    await expect(arrive({ index: 2, total: 2 })).resolves.toBeNull();
    const set = await held;
    if (!set) {
      throw new Error("the first part should hold the set");
    }
    expect(set.events).toEqual(["image-1", "image-2"]);

    // Same set id, arriving while the holder is still delivering.
    const late = arrive({ index: 3, flushDelayMs: 1_000 });
    let lateResolved = false;
    void late.then(() => {
      lateResolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateResolved).toBe(false);

    set.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    // It becomes its own delivery rather than vanishing into the sealed set.
    await expect(late).resolves.toMatchObject({
      events: ["image-3"],
      lifecycles: ["claim-3"],
    });
  });

  // The lane is released so the rest of a set can be claimed at all. Anything else
  // the sender sent afterwards has to wait, or it overtakes the images.
  it("keeps a later unrelated event behind an incomplete set", async () => {
    const held = arrive({ index: 1, total: 3, flushDelayMs: 1_000 });
    let laneFree = false;
    const later = buffer.enterLane("user:U1").then((release) => {
      laneFree = true;
      release();
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(laneFree).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    const set = await held;
    if (!set) {
      throw new Error("the first part should hold the set");
    }
    // Taking the set is not enough: the holder still has to deliver it.
    expect(laneFree).toBe(false);

    set.finish();
    await later;
    expect(laneFree).toBe(true);
  });

  it("lets an unrelated lane through while a set is still forming", async () => {
    const held = arrive({ index: 1, total: 3, flushDelayMs: 1_000 });

    const release = await buffer.enterLane("user:UOTHER");
    expect(buffer.isBusy("user:UOTHER")).toBe(true);
    release();
    expect(buffer.isBusy("user:UOTHER")).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    (await held)?.finish();
  });
});
