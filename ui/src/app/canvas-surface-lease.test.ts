// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS } from "../../../src/gateway/plugin-node-capability.js";
import { createCanvasSurfaceLease } from "./canvas-surface-lease.ts";

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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
  const lease = createCanvasSurfaceLease({
    request,
    onChange: (url) => changes.push(url),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { changes, clock, lease };
}

describe("createCanvasSurfaceLease", () => {
  it("seeds from hello, renews before the default TTL, and honors the refreshed expiry", async () => {
    const request = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
        expiresAtMs: 500_000,
      })
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/three" },
      });
    const { changes, clock, lease } = createLeaseHarness(request);
    const helloUrl = "https://canvas.test/__openclaw__/cap/one";

    lease.start(helloUrl);
    expect(changes).toEqual([helloUrl]);
    expect(clock.nextDelayMs).toBe(DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS / 2);

    await clock.advanceBy(DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS / 2 - 1);
    expect(request).not.toHaveBeenCalled();
    await clock.advanceBy(1);

    expect(request).toHaveBeenCalledWith("plugin.surface.refresh", {
      surface: "canvas",
      observedUrl: helloUrl,
    });
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/two");
    expect(clock.nextDelayMs).toBe(85_000);

    await clock.advanceBy(85_000);
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/three");
    expect(clock.nextDelayMs).toBe(DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS / 2);
  });

  it("keeps overlapping renewals single-flight", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const { clock, lease } = createLeaseHarness(request);
    lease.start("https://canvas.test/__openclaw__/cap/one");

    const callback = clock.takeNextCallback();
    expect(callback).toBeDefined();
    callback?.();
    callback?.();
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(1);

    pending.resolve({
      surface: "canvas",
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
    });
    await flushPromises();
    expect(clock.pendingCount).toBe(1);
  });

  it("backs off and stops after three consecutive failures until a later start", async () => {
    const request = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("third"))
      .mockResolvedValueOnce({
        surface: "canvas",
        pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/fresh" },
      });
    const { changes, clock, lease } = createLeaseHarness(request);
    const originalUrl = "https://canvas.test/__openclaw__/cap/one";
    lease.start(originalUrl);

    await clock.advanceBy(DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS / 2);
    expect(clock.nextDelayMs).toBe(1_000);
    await clock.advanceBy(1_000);
    expect(clock.nextDelayMs).toBe(2_000);
    await clock.advanceBy(2_000);

    expect(request).toHaveBeenCalledTimes(3);
    expect(clock.pendingCount).toBe(0);
    expect(changes).toEqual([originalUrl]);

    lease.start("https://canvas.test/__openclaw__/cap/reconnected");
    await clock.advanceBy(DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS / 2);
    expect(request).toHaveBeenCalledTimes(4);
    expect(changes.at(-1)).toBe("https://canvas.test/__openclaw__/cap/fresh");
  });

  it("stop clears timers, ignores an in-flight result, and publishes null once", async () => {
    const pending = deferred<unknown>();
    const { changes, clock, lease } = createLeaseHarness(() => pending.promise);
    lease.start("https://canvas.test/__openclaw__/cap/one");
    clock.takeNextCallback()?.();

    lease.stop();
    lease.stop();
    expect(clock.pendingCount).toBe(0);
    expect(changes).toEqual(["https://canvas.test/__openclaw__/cap/one", null]);

    pending.resolve({
      surface: "canvas",
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/two" },
    });
    await flushPromises();
    expect(changes).toEqual(["https://canvas.test/__openclaw__/cap/one", null]);
  });
});
