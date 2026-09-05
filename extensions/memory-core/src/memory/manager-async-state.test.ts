// Memory Core tests cover asynchronous manager state helpers.
import { describe, expect, it, vi } from "vitest";
import { startAsyncSearchSync } from "./manager-async-state.js";

describe("memory manager async state", () => {
  it("skips background search sync when search-triggered sync is disabled", async () => {
    const syncMock = vi.fn(async () => {});
    await startAsyncSearchSync({
      enabled: false,
      memoryFullRetryDirty: true,
      sessionsFullRetryDirty: false,
      sync: syncMock,
      onError: vi.fn(),
    });
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("reports and settles full session retry failures", async () => {
    const syncError = new Error("sync failed");
    const onError = vi.fn();
    const syncMock = vi.fn(async () => {
      throw syncError;
    });

    await expect(
      startAsyncSearchSync({
        enabled: true,
        memoryFullRetryDirty: false,
        sessionsFullRetryDirty: true,
        sync: syncMock,
        onError,
      }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(syncError));
    expect(syncMock).toHaveBeenCalledExactlyOnceWith({ reason: "search" });
  });

  it("does not start search maintenance without a full-retry flag", async () => {
    const syncMock = vi.fn(async () => {});

    await startAsyncSearchSync({
      enabled: true,
      memoryFullRetryDirty: false,
      sessionsFullRetryDirty: false,
      sync: syncMock,
      onError: vi.fn(),
    });

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("waits for full memory retry sync", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const syncMock = vi.fn(async () => await pendingSync);
    let settled = false;

    const searchSync = Promise.resolve(
      startAsyncSearchSync({
        enabled: true,
        memoryFullRetryDirty: true,
        sessionsFullRetryDirty: false,
        sync: syncMock,
        onError: vi.fn(),
      }),
    ).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(syncMock).toHaveBeenCalledWith({ reason: "search" }));
    expect(settled).toBe(false);
    releaseSync();
    await searchSync;
  });
});
