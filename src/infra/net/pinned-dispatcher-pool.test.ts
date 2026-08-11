import type { Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasProviderTransportDispatcherPool } from "../../agents/provider-runtime-lifecycle.js";
import {
  closeProviderTransportDispatcherPool,
  getProviderTransportDispatcherPool,
} from "../../agents/provider-transport-dispatcher-pool.js";
import { createDeferred } from "../../shared/deferred.js";
import { PinnedDispatcherPool } from "./pinned-dispatcher-pool.js";

function createDispatcher() {
  const close = vi.fn(async () => undefined);
  return {
    close,
    dispatcher: { close } as unknown as Dispatcher,
  };
}

describe("PinnedDispatcherPool", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeProviderTransportDispatcherPool();
  });

  it("records dispatcher-pool activity only for an allocated generation", async () => {
    expect(hasProviderTransportDispatcherPool()).toBe(false);
    getProviderTransportDispatcherPool();
    expect(hasProviderTransportDispatcherPool()).toBe(true);
    await closeProviderTransportDispatcherPool();
    expect(hasProviderTransportDispatcherPool()).toBe(false);
  });

  it("reuses an exact live key and closes it only at lifecycle shutdown", async () => {
    const pool = new PinnedDispatcherPool({ maxEntries: 2, idleTtlMs: 60_000 });
    const created = createDispatcher();
    const create = vi.fn(() => created.dispatcher);

    const first = pool.acquire({
      key: "origin-a/pin-a",
      groupKey: "origin-a",
      createDispatcher: create,
    });
    expect(first?.reused).toBe(false);
    await first?.release();
    const second = pool.acquire({
      key: "origin-a/pin-a",
      groupKey: "origin-a",
      createDispatcher: create,
    });

    expect(second?.dispatcher).toBe(first?.dispatcher);
    expect(second?.reused).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(created.close).not.toHaveBeenCalled();

    await second?.release();
    await pool.closeAll();
    expect(created.close).toHaveBeenCalledOnce();
  });

  it("retires a changed pin without closing its active lease and owns it through shutdown", async () => {
    const pool = new PinnedDispatcherPool({ maxEntries: 2, idleTtlMs: 60_000 });
    const oldDispatcher = createDispatcher();
    const nextDispatcher = createDispatcher();
    const oldLease = pool.acquire({
      key: "origin-a/pin-a",
      groupKey: "origin-a",
      createDispatcher: () => oldDispatcher.dispatcher,
    });
    const nextLease = pool.acquire({
      key: "origin-a/pin-b",
      groupKey: "origin-a",
      createDispatcher: () => nextDispatcher.dispatcher,
    });

    expect(nextLease?.dispatcher).toBe(nextDispatcher.dispatcher);
    expect(oldDispatcher.close).not.toHaveBeenCalled();
    await pool.closeAll();
    expect(oldDispatcher.close).toHaveBeenCalledOnce();
    expect(nextDispatcher.close).toHaveBeenCalledOnce();

    await oldLease?.release();
    await nextLease?.release();
    expect(oldDispatcher.close).toHaveBeenCalledOnce();
    expect(nextDispatcher.close).toHaveBeenCalledOnce();
  });

  it("falls back to caller-owned dispatchers when capacity is fully leased", async () => {
    const pool = new PinnedDispatcherPool({ maxEntries: 1, idleTtlMs: 60_000 });
    const firstDispatcher = createDispatcher();
    const first = pool.acquire({
      key: "origin-a/pin-a",
      groupKey: "origin-a",
      createDispatcher: () => firstDispatcher.dispatcher,
    });
    const secondFactory = vi.fn(() => createDispatcher().dispatcher);

    const second = pool.acquire({
      key: "origin-b/pin-b",
      groupKey: "origin-b",
      createDispatcher: secondFactory,
    });

    expect(second).toBeUndefined();
    expect(secondFactory).not.toHaveBeenCalled();
    expect(firstDispatcher.close).not.toHaveBeenCalled();
    await first?.release();
    await pool.closeAll();
  });

  it("expires idle entries with an unreferenced sweep", async () => {
    vi.useFakeTimers();
    const pool = new PinnedDispatcherPool({ maxEntries: 1, idleTtlMs: 50 });
    const created = createDispatcher();
    const lease = pool.acquire({
      key: "origin-a/pin-a",
      groupKey: "origin-a",
      createDispatcher: () => created.dispatcher,
    });
    await lease?.release();

    await vi.advanceTimersByTimeAsync(49);
    expect(created.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(created.close).toHaveBeenCalledOnce();

    await pool.closeAll();
  });

  it("fences a closed generation from later acquisition", async () => {
    const pool = new PinnedDispatcherPool({ maxEntries: 1, idleTtlMs: 60_000 });
    await pool.closeAll();

    const create = vi.fn(() => createDispatcher().dispatcher);
    expect(
      pool.acquire({ key: "origin-a/pin-a", groupKey: "origin-a", createDispatcher: create }),
    ).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not publish a replacement generation while shutdown is closing", async () => {
    const close = createDeferred();
    const pool = getProviderTransportDispatcherPool();
    const lease = pool.acquire({
      key: "origin-a/pin-a",
      groupKey: "origin-a",
      createDispatcher: () => ({ close: vi.fn(() => close.promise) }) as unknown as Dispatcher,
    });

    const closing = closeProviderTransportDispatcherPool();
    try {
      expect(getProviderTransportDispatcherPool()).toBe(pool);
      expect(
        pool.acquire({
          key: "origin-b/pin-b",
          groupKey: "origin-b",
          createDispatcher: () => createDispatcher().dispatcher,
        }),
      ).toBeUndefined();
    } finally {
      close.resolve();
      await closing;
    }
    expect(getProviderTransportDispatcherPool()).not.toBe(pool);
    await lease?.release();
  });
});
