import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeliverDebouncer, DeliverDebouncer } from "./deliver-debounce.js";
import type { DeliverPayload, DeliverInfo } from "./deliver-debounce.js";

function createMockExecutor() {
  return vi.fn<(payload: DeliverPayload, info: DeliverInfo) => Promise<void>>(async () => {});
}

describe("engine/group/deliver-debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers multiple text deliveries and merges them", async () => {
    const executor = createMockExecutor();
    const d = new DeliverDebouncer({ windowMs: 100, maxWaitMs: 10_000 }, executor);

    await d.deliver({ text: "a" }, { kind: "block" });
    await d.deliver({ text: "b" }, { kind: "block" });
    await d.deliver({ text: "c" }, { kind: "block" });

    expect(executor).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(executor).toHaveBeenCalledTimes(1);
    const call = executor.mock.calls[0];
    expect(call[0].text).toContain("a");
    expect(call[0].text).toContain("b");
    expect(call[0].text).toContain("c");
  });

  it("flushes immediately when payload carries media", async () => {
    const executor = createMockExecutor();
    const d = new DeliverDebouncer({ windowMs: 200 }, executor);

    await d.deliver({ text: "text" }, { kind: "block" });
    await d.deliver({ mediaUrl: "http://x/a.png" }, { kind: "block" });

    // One for the flushed text, one for the media.
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[0][0].text).toBe("text");
    expect(executor.mock.calls[1][0].mediaUrl).toBe("http://x/a.png");
  });

  it("passes through empty-text payloads directly", async () => {
    const executor = createMockExecutor();
    const d = new DeliverDebouncer({ windowMs: 200 }, executor);

    await d.deliver({ text: "  " }, { kind: "tool" });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0].text).toBe("  ");
  });

  it("forces flush after maxWaitMs even if text keeps arriving", async () => {
    const executor = createMockExecutor();
    const d = new DeliverDebouncer({ windowMs: 1_000, maxWaitMs: 3_000 }, executor);

    await d.deliver({ text: "a" }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(900); // still below window
    await d.deliver({ text: "b" }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(900);
    await d.deliver({ text: "c" }, { kind: "block" });
    // maxWait timer was armed at t=0, so it should fire at t=3000.
    await vi.advanceTimersByTimeAsync(1_300);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0].text).toMatch(/a.+b.+c/s);
  });

  it("dispose flushes any remaining buffer", async () => {
    const executor = createMockExecutor();
    const d = new DeliverDebouncer({ windowMs: 10_000 }, executor);
    await d.deliver({ text: "x" }, { kind: "block" });
    expect(executor).not.toHaveBeenCalled();
    await d.dispose();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0].text).toBe("x");
  });

  it("ignores deliver calls after dispose", async () => {
    const executor = createMockExecutor();
    const d = new DeliverDebouncer({ windowMs: 1_000 }, executor);
    await d.dispose();
    await d.deliver({ text: "x" }, { kind: "block" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("createDeliverDebouncer returns null when disabled", () => {
    const executor = createMockExecutor();
    expect(createDeliverDebouncer({ enabled: false }, executor)).toBeNull();
  });

  it("createDeliverDebouncer returns instance by default", () => {
    const executor = createMockExecutor();
    const d = createDeliverDebouncer(undefined, executor);
    expect(d).toBeInstanceOf(DeliverDebouncer);
  });

  it("preserves non-text fields from the latest buffered payload", async () => {
    const executor = createMockExecutor();
    const d = new DeliverDebouncer({ windowMs: 100 }, executor);
    await d.deliver({ text: "a" }, { kind: "block" });
    // Simulate a second deliver that also has a custom field — mediaUrls
    // empty (not media-bearing) but merged later.
    await d.deliver({ text: "b", mediaUrls: [] }, { kind: "block" });
    await vi.advanceTimersByTimeAsync(100);
    expect(executor).toHaveBeenCalledTimes(1);
    // mediaUrls empty array should still be forwarded.
    expect(executor.mock.calls[0][0].mediaUrls).toEqual([]);
  });

  it("hasPending / pendingCount reflect buffered state", async () => {
    const executor = createMockExecutor();
    const d = new DeliverDebouncer({ windowMs: 10_000 }, executor);
    expect(d.hasPending).toBe(false);
    expect(d.pendingCount).toBe(0);
    await d.deliver({ text: "a" }, { kind: "block" });
    expect(d.hasPending).toBe(true);
    expect(d.pendingCount).toBe(1);
    await d.dispose();
    expect(d.hasPending).toBe(false);
  });
});
