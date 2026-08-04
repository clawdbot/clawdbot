import { afterEach, describe, expect, it, vi } from "vitest";
import { startDeliveryProducerLease } from "./delivery-queue-lease.js";

describe("delivery producer lease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews immediately and keeps the exact owner alive until stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const renew = vi.fn(async () => Date.now() + 30_000);

    const lease = await startDeliveryProducerLease({ id: "stable-1", renew });
    expect(renew).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(35_000);
    expect(renew).toHaveBeenCalledTimes(4);
    expect(lease.signal.aborted).toBe(false);

    lease.stop();
    lease.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledTimes(4);
  });

  it("aborts with the stable claim error when renewal definitively loses ownership", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const renew = vi
      .fn<() => Promise<number | undefined>>()
      .mockResolvedValueOnce(Date.now() + 30_000)
      .mockResolvedValueOnce(undefined);

    const lease = await startDeliveryProducerLease({ id: "stable-lost", renew });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({
      name: "StableDeliveryProducerLeaseLostError",
      message: "Stable delivery platform claim was lost: stable-lost",
    });
  });

  it("retries transient renewal failures while the last confirmed lease remains valid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const renew = vi
      .fn<() => Promise<number | undefined>>()
      .mockResolvedValueOnce(Date.now() + 30_000)
      .mockRejectedValueOnce(new Error("database busy"))
      .mockImplementation(async () => Date.now() + 30_000);

    const lease = await startDeliveryProducerLease({ id: "stable-retry", renew });
    await vi.advanceTimersByTimeAsync(35_000);

    expect(renew).toHaveBeenCalledTimes(4);
    expect(lease.signal.aborted).toBe(false);
    lease.stop();
  });

  it("aborts when transient renewal failures outlive the last confirmed lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const renew = vi
      .fn<() => Promise<number | undefined>>()
      .mockResolvedValueOnce(Date.now() + 30_000)
      .mockRejectedValue(new Error("database unavailable"));

    const lease = await startDeliveryProducerLease({ id: "stable-expired", renew });
    await vi.advanceTimersByTimeAsync(30_001);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({
      name: "StableDeliveryProducerLeaseLostError",
      message: "Stable delivery platform claim was lost: stable-expired",
    });
  });

  it("refuses to start without a confirmed unexpired owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    await expect(
      startDeliveryProducerLease({
        id: "stable-missing",
        renew: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: "StableDeliveryProducerLeaseLostError",
      message: "Stable delivery platform claim was lost: stable-missing",
    });
    await expect(
      startDeliveryProducerLease({
        id: "stable-storage-error",
        renew: async () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toMatchObject({
      name: "StableDeliveryProducerLeaseLostError",
      message: "Stable delivery platform claim was lost: stable-storage-error",
    });
  });
});
