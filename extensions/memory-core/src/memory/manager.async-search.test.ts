import { describe, expect, it, vi } from "vitest";
import { awaitPendingManagerWork, startAsyncSearchSync } from "./manager-async-state.js";

describe("memory search async sync", () => {
  it("does not await sync when searching", async () => {
    let releaseSync = () => {};
    const pending = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const syncMock = vi.fn(async () => {
      return pending;
    });
    const onError = vi.fn();

    startAsyncSearchSync({
      enabled: true,
      dirty: true,
      sessionsDirty: false,
      sync: syncMock,
      onError,
    });

    expect(syncMock).toHaveBeenCalledTimes(1);
    releaseSync();
    await pending;
    expect(onError).not.toHaveBeenCalled();
  });

  it("waits for in-flight search sync during close", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });

    let closed = false;
    const closePromise = awaitPendingManagerWork({ pendingSync }).then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    releaseSync();
    await closePromise;
  });

  it("skips background search sync when search-triggered sync is disabled", () => {
    const syncMock = vi.fn(async () => {});
    startAsyncSearchSync({
      enabled: false,
      dirty: true,
      sessionsDirty: false,
      sync: syncMock,
      onError: vi.fn(),
    });
    expect(syncMock).not.toHaveBeenCalled();
  });
});
