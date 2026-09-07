import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPermitPool } from "./permit-pool.js";

describe("permit pool", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("admits FIFO without releasing another holder on a duplicate release", async () => {
    const pool = createPermitPool(2);
    const first = await pool.acquire();
    const second = await pool.acquire();
    const admitted: string[] = [];
    const queued = ["a", "b", "c"].map((name) =>
      pool.acquire().then((release) => {
        admitted.push(name);
        return release;
      }),
    );

    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
    first?.();
    first?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toEqual(["a"]);
    second?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toEqual(["a", "b"]);
    (await queued[0])?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toEqual(["a", "b", "c"]);
    (await queued[1])?.();
    (await queued[2])?.();
  });

  it("removes cancelled and expired waiters without revoking acquired permits", async () => {
    const pool = createPermitPool(1);
    const owner = new AbortController();
    const release = await pool.acquire({ signal: owner.signal, deadlineAtMs: Date.now() + 10 });
    const cancel = new AbortController();
    const cancelled = pool.acquire({ signal: cancel.signal });
    const expired = pool.acquire({ deadlineAtMs: Date.now() + 10 });
    let admitted = false;
    const next = pool.acquire().then((nextRelease) => {
      admitted = true;
      return nextRelease;
    });

    cancel.abort();
    owner.abort();
    await vi.advanceTimersByTimeAsync(10);
    await expect(cancelled).resolves.toBeNull();
    await expect(expired).resolves.toBeNull();
    expect(admitted).toBe(false);
    release?.();
    const nextRelease = await next;
    expect(nextRelease).toBeTypeOf("function");
    nextRelease?.();
  });

  it("rechecks deadlines on release even before an expiry timer runs", async () => {
    const pool = createPermitPool(1);
    const release = await pool.acquire();
    const expired = pool.acquire({ deadlineAtMs: Date.now() + 10 });
    const next = pool.acquire();
    vi.setSystemTime(Date.now() + 10);
    release?.();
    await expect(expired).resolves.toBeNull();
    const nextRelease = await next;
    expect(nextRelease).toBeTypeOf("function");
    nextRelease?.();

    const aborted = new AbortController();
    aborted.abort();
    await expect(pool.acquire({ signal: aborted.signal })).resolves.toBeNull();
    await expect(pool.acquire({ deadlineAtMs: Date.now() })).resolves.toBeNull();
  });
});
