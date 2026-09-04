// Memory Core tests cover asynchronous manager state helpers.
import { describe, expect, it, vi } from "vitest";
import { startAsyncSearchSync } from "./manager-async-state.js";

describe("memory manager async state", () => {
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

  it("reports and settles background search sync failures", async () => {
    const syncError = new Error("sync failed");
    const onError = vi.fn();

    await expect(
      startAsyncSearchSync({
        enabled: true,
        dirty: false,
        sessionsDirty: true,
        sync: vi.fn(async () => {
          throw syncError;
        }),
        onError,
      }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(syncError));
  });

  it("waits for ordinary dirty sync", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const syncMock = vi.fn(async () => await pendingSync);
    let settled = false;

    const searchSync = Promise.resolve(
      startAsyncSearchSync({
        enabled: true,
        dirty: true,
        sessionsDirty: false,
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
