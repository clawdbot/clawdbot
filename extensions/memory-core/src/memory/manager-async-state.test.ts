// Memory Core tests cover asynchronous manager state helpers.
import { describe, expect, it, vi } from "vitest";
import { awaitPendingManagerWork, startAsyncSearchSync } from "./manager-async-state.js";

describe("memory manager async state", () => {
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

  it("reports pending sync failures during close", async () => {
    const onError = vi.fn();
    const syncError = new Error("sync failed");

    await awaitPendingManagerWork({
      pendingSync: Promise.reject(syncError),
      onError,
    });

    expect(onError).toHaveBeenCalledWith(syncError);
  });

  it("reports pending provider initialization failures during close", async () => {
    const onError = vi.fn();
    const providerError = new Error("provider init failed");

    await awaitPendingManagerWork({
      pendingProviderInit: Promise.reject(providerError),
      onError,
    });

    expect(onError).toHaveBeenCalledWith(providerError);
  });

  it("does not report errors for completed pending close work", async () => {
    const onError = vi.fn();

    await awaitPendingManagerWork({
      pendingSync: Promise.resolve(),
      pendingProviderInit: Promise.resolve(),
      onError,
    });

    expect(onError).not.toHaveBeenCalled();
  });

  it("skips background search sync when search-triggered sync is disabled", async () => {
    const syncMock = vi.fn(async () => {});
    await startAsyncSearchSync({
      enabled: false,
      dirty: true,
      sessionsDirty: false,
      sync: syncMock,
      onError: vi.fn(),
    });
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("reports background search sync failures", async () => {
    const syncError = new Error("sync failed");
    const onError = vi.fn();

    await startAsyncSearchSync({
      enabled: true,
      dirty: false,
      sessionsDirty: true,
      sync: vi.fn(async () => {
        throw syncError;
      }),
      onError,
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(syncError));
  });

  it("waits for ordinary dirty sync", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const syncMock = vi.fn(async () => await pendingSync);
    let settled = false;

    const searchSync = startAsyncSearchSync({
      enabled: true,
      dirty: true,
      sessionsDirty: false,
      sync: syncMock,
      onError: vi.fn(),
    }).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(syncMock).toHaveBeenCalledWith({ reason: "search" }));
    expect(settled).toBe(false);
    releaseSync();
    await searchSync;
  });
});
