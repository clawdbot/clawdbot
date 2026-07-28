import type { PluginStateLeaseContext } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QmdMemoryManager } from "./qmd-manager.js";

type QmdRetryHarness = {
  runQmdUpdateOnce: (reason: string, lease: PluginStateLeaseContext) => Promise<void>;
  runQmdUpdateWithRetry: (reason: string, lease: PluginStateLeaseContext) => Promise<void>;
};

function createQmdRetryHarness(
  runQmdUpdateOnce: QmdRetryHarness["runQmdUpdateOnce"],
): QmdRetryHarness {
  // The real inherited retry path needs only its update operation and lease;
  // creating a full manager would start an unrelated external qmd process.
  const manager = Object.create(QmdMemoryManager.prototype) as QmdRetryHarness;
  manager.runQmdUpdateOnce = runQmdUpdateOnce;
  return manager;
}

function createQmdRetryLease(signal: AbortSignal): PluginStateLeaseContext {
  return { signal, assertOwned: vi.fn() };
}

describe("QMD update retry policy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries boot-time SQLite lock failures on the canonical exponential schedule", async () => {
    vi.useFakeTimers();
    const runQmdUpdateOnce = vi
      .fn<QmdRetryHarness["runQmdUpdateOnce"]>()
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"))
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"))
      .mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    const lease = createQmdRetryLease(controller.signal);
    const manager = createQmdRetryHarness(runQmdUpdateOnce);

    const pending = manager.runQmdUpdateWithRetry("boot", lease);
    await vi.advanceTimersByTimeAsync(0);
    expect(runQmdUpdateOnce).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(499);
    expect(runQmdUpdateOnce).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(runQmdUpdateOnce).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(runQmdUpdateOnce).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeUndefined();
    expect(runQmdUpdateOnce).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the lease abort reason and clears a pending retry timer", async () => {
    vi.useFakeTimers();
    const runQmdUpdateOnce = vi
      .fn<QmdRetryHarness["runQmdUpdateOnce"]>()
      .mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
    const controller = new AbortController();
    const leaseLost = new Error("qmd write lease was lost");
    const manager = createQmdRetryHarness(runQmdUpdateOnce);

    const pending = manager.runQmdUpdateWithRetry(
      "boot:startup",
      createQmdRetryLease(controller.signal),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort(leaseLost);

    await expect(pending).rejects.toBe(leaseLost);
    expect(runQmdUpdateOnce).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves lease cancellation when it races with a retryable update failure", async () => {
    const controller = new AbortController();
    const leaseLost = new Error("qmd write lease was lost");
    const runQmdUpdateOnce = vi.fn<QmdRetryHarness["runQmdUpdateOnce"]>(async () => {
      controller.abort(leaseLost);
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const manager = createQmdRetryHarness(runQmdUpdateOnce);

    await expect(
      manager.runQmdUpdateWithRetry("boot", createQmdRetryLease(controller.signal)),
    ).rejects.toBe(leaseLost);

    expect(runQmdUpdateOnce).toHaveBeenCalledOnce();
  });

  it("does not replay failed manual updates or permanent boot failures", async () => {
    const scenarios = [
      { reason: "manual", error: new Error("SQLITE_BUSY: database is locked") },
      { reason: "boot", error: new Error("qmd collection is invalid") },
    ];

    for (const { reason, error } of scenarios) {
      const runQmdUpdateOnce = vi
        .fn<QmdRetryHarness["runQmdUpdateOnce"]>()
        .mockRejectedValue(error);
      const manager = createQmdRetryHarness(runQmdUpdateOnce);

      await expect(
        manager.runQmdUpdateWithRetry(reason, createQmdRetryLease(new AbortController().signal)),
      ).rejects.toBe(error);
      expect(runQmdUpdateOnce).toHaveBeenCalledOnce();
    }
  });
});
