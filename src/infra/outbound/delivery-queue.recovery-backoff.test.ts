import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { loadPendingDeliveries, enqueueDelivery } from "./delivery-queue-storage.js";
import {
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

describe("outbound delivery recovery retry backoff", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { retryCount: 1, backoffMs: 5_000 },
    { retryCount: 2, backoffMs: 25_000 },
    { retryCount: 3, backoffMs: 120_000 },
  ])("replays retry $retryCount after $backoffMs ms", async ({ retryCount, backoffMs }) => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-25T00:00:00.000Z");
    vi.setSystemTime(startedAt);

    const stateDir = tmpDir();
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "retry" }] },
      stateDir,
    );
    setQueuedEntryState(stateDir, id, {
      retryCount,
      lastAttemptAt: startedAt.getTime(),
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const recover = () =>
      recoverPendingDeliveries({
        deliver: asDeliverFn(deliver),
        log: createRecoveryLog(),
        cfg: {},
        stateDir,
        maxRecoveryMs: 60_000,
      });

    vi.setSystemTime(startedAt.getTime() + backoffMs - 1);
    await expect(recover()).resolves.toMatchObject({
      recovered: 0,
      deferredBackoff: 1,
    });
    expect(deliver).not.toHaveBeenCalled();

    vi.setSystemTime(startedAt.getTime() + backoffMs);
    await expect(recover()).resolves.toMatchObject({
      recovered: 1,
      deferredBackoff: 0,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    await expect(loadPendingDeliveries(stateDir)).resolves.toEqual([]);
  });
});
