// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createCanvasSurfaceLease } from "./canvas-surface-lease.runtime.ts";

type ScheduledTimer = {
  callback: () => void;
  dueAtMs: number;
};

class FakeClock {
  nowMs = 100_000;
  private nextId = 1;
  private readonly timers = new Map<number, ScheduledTimer>();

  readonly now = () => this.nowMs;

  readonly setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, dueAtMs: this.nowMs + delayMs });
    return id;
  };

  readonly clearTimer = (id: number) => {
    this.timers.delete(id);
  };

  get pendingCount() {
    return this.timers.size;
  }

  get nextDelayMs() {
    const dueAtMs = Math.min(...Array.from(this.timers.values(), (timer) => timer.dueAtMs));
    return Number.isFinite(dueAtMs) ? dueAtMs - this.nowMs : undefined;
  }

  takeNextCallback(): (() => void) | undefined {
    const next = [...this.timers.entries()].toSorted(
      ([leftId, left], [rightId, right]) => left.dueAtMs - right.dueAtMs || leftId - rightId,
    )[0];
    if (!next) {
      return undefined;
    }
    this.timers.delete(next[0]);
    this.nowMs = next[1].dueAtMs;
    return next[1].callback;
  }

  async advanceBy(delayMs: number): Promise<void> {
    const targetMs = this.nowMs + delayMs;
    while (true) {
      const next = [...this.timers.entries()].toSorted(
        ([leftId, left], [rightId, right]) => left.dueAtMs - right.dueAtMs || leftId - rightId,
      )[0];
      if (!next || next[1].dueAtMs > targetMs) {
        break;
      }
      this.timers.delete(next[0]);
      this.nowMs = next[1].dueAtMs;
      next[1].callback();
      await flushPromises();
    }
    this.nowMs = targetMs;
    await flushPromises();
  }
}

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createLeaseHarness(request: (method: string, params: unknown) => Promise<unknown>) {
  const clock = new FakeClock();
  const changes: Array<string | null> = [];
  const connectionChanges: number[] = [];
  const lease = createCanvasSurfaceLease({
    request,
    onChange: (url) => changes.push(url),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onConnectionChange: () => connectionChanges.push(clock.nowMs),
  });
  return { changes, clock, connectionChanges, lease };
}

describe("createCanvasSurfaceLease", () => {
  it("seeds from hello, renews immediately, and honors the refreshed expiry", async () => {
    const request = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
        expiresAtMs: 200_000,
      })
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/three" },
      });
    const { changes, clock, lease } = createLeaseHarness(request);
    const helloUrl = "https://canvas.test/__openclaw__/cap/one";

    lease.start(helloUrl);
    expect(changes).toEqual([helloUrl]);
    expect(request).not.toHaveBeenCalled();
    await flushPromises();

    expect(request).toHaveBeenCalledWith("plugin.surface.refresh", {
      surface: "canvas",
      observedUrl: helloUrl,
    });
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/two");
    expect(clock.nextDelayMs).toBe(85_000);

    await clock.advanceBy(85_000);
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/three");
    expect(clock.nextDelayMs).toBe(60_000);
  });

  it("keeps overlapping renewals single-flight", async () => {
    const pending = deferred<unknown>();
    const request = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
        expiresAtMs: 116_000,
      })
      .mockImplementation(() => pending.promise);
    const { clock, lease } = createLeaseHarness(request);
    lease.start("https://canvas.test/__openclaw__/cap/one");
    await flushPromises();

    const callback = clock.takeNextCallback();
    expect(callback).toBeDefined();
    callback?.();
    callback?.();
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);

    pending.resolve({
      surface: "canvas",
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
    });
    await flushPromises();
    expect(clock.pendingCount).toBe(1);
  });

  it("keeps retrying past three failures, caps its backoff, and recovers", async () => {
    let failuresRemaining = 10;
    const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("refresh failed");
      }
      return {
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/fresh" },
      };
    });
    const { changes, clock, lease } = createLeaseHarness(request);
    const originalUrl = "https://canvas.test/__openclaw__/cap/one";
    lease.start(originalUrl);

    await flushPromises();
    const backoffs = [
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000,
    ];
    for (const delayMs of backoffs) {
      expect(clock.nextDelayMs).toBe(delayMs);
      await clock.advanceBy(delayMs);
    }

    expect(request).toHaveBeenCalledTimes(11);
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/fresh");
    expect(clock.nextDelayMs).toBe(60_000);
  });

  it.each(["stops", "reconnects without a canvas"] as const)(
    "does not schedule a retired generation when publishing a refreshed URL %s",
    async (transition) => {
      const clock = new FakeClock();
      const changes: Array<string | null> = [];
      const request = vi.fn(async () => ({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/refreshed" },
        expiresAtMs: 120_000,
      }));
      const lease = createCanvasSurfaceLease({
        request,
        onChange: (url) => {
          changes.push(url);
          if (url === "https://canvas.test/__openclaw__/cap/refreshed") {
            if (transition === "stops") {
              lease.stop();
            } else {
              lease.start(undefined);
            }
          }
        },
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      });

      lease.start("https://canvas.test/__openclaw__/cap/original");
      await flushPromises();

      expect(request).toHaveBeenCalledOnce();
      expect(changes).toEqual([
        "https://canvas.test/__openclaw__/cap/original",
        "https://canvas.test/__openclaw__/cap/refreshed",
        null,
      ]);
      expect(clock.pendingCount).toBe(0);
    },
  );

  it("keeps the reconnect renewal owned when a retired timer callback arrives late", async () => {
    const request = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/first" },
        expiresAtMs: 120_000,
      })
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/reconnected" },
        expiresAtMs: 180_000,
      });
    const { clock, lease } = createLeaseHarness(request);

    lease.start("https://canvas.test/__openclaw__/cap/original");
    await flushPromises();
    const retiredCallback = clock.takeNextCallback();
    expect(retiredCallback).toBeDefined();

    lease.stop();
    lease.start("https://canvas.test/__openclaw__/cap/reconnect");
    await flushPromises();
    expect(clock.pendingCount).toBe(1);

    retiredCallback?.();
    expect(request).toHaveBeenCalledTimes(2);
    lease.stop();

    expect(clock.pendingCount).toBe(0);
  });

  it.each([Number.MAX_SAFE_INTEGER, 2 ** 32 + 115_000])(
    "clamps an advertised canvas expiry of %d to a browser-safe native timer",
    async (expiresAtMs) => {
      const request = vi.fn(async () => ({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/refreshed" },
        expiresAtMs,
      }));
      const { clock, lease } = createLeaseHarness(request);

      lease.start("https://canvas.test/__openclaw__/cap/original");
      await flushPromises();

      expect(clock.nextDelayMs).toBe(2_147_483_647);
      lease.stop();
    },
  );

  it("stop clears timers, ignores an in-flight result, and publishes null once", async () => {
    const pending = deferred<unknown>();
    const { changes, clock, connectionChanges, lease } = createLeaseHarness(() => pending.promise);
    lease.start("https://canvas.test/__openclaw__/cap/one");
    await flushPromises();

    lease.stop();
    lease.stop();
    expect(clock.pendingCount).toBe(0);
    expect(changes).toEqual(["https://canvas.test/__openclaw__/cap/one", null]);
    expect(connectionChanges).toHaveLength(2);

    pending.resolve({
      surface: "canvas",
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
    });
    await flushPromises();
    expect(changes).toEqual(["https://canvas.test/__openclaw__/cap/one", null]);
  });
});
