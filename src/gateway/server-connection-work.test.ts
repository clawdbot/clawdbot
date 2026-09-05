import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { GatewayConnectionWork } from "./server-connection-work.js";

describe("Gateway connection work", () => {
  it("starts received work synchronously and joins connection cleanup after transport close", async () => {
    const work = new GatewayConnectionWork();
    const requestGate = createDeferredCore();
    const cleanupGate = createDeferredCore();
    const events: string[] = [];
    const request = work.track(async () => {
      events.push("request");
      await requestGate.promise;
      events.push("request settled");
    });
    expect(events).toEqual(["request"]);
    const releaseConnection = work.registerConnection(() => {
      events.push("transport closed");
      void work.track(() => cleanupGate.promise).finally(releaseConnection);
    });
    let drained = false;
    work.beginClose();
    expect(work.signal.aborted).toBe(true);
    expect(events).toEqual(["request"]);
    const closing = Promise.all([work.drain(), work.drain()]).then(() => {
      drained = true;
    });
    try {
      requestGate.resolve();
      await request;
      await nextTurn();
      expect(events).toEqual(["request", "transport closed", "request settled"]);
      expect(drained).toBe(false);
    } finally {
      requestGate.resolve();
      cleanupGate.resolve();
      await closing;
    }
    expect(drained).toBe(true);
    const late = vi.fn();
    await expect(work.track(late)).rejects.toThrow("Async work scope is closed");
    expect(late).not.toHaveBeenCalled();
  });

  it("retains a failed cleanup outcome instead of reporting a clean drain", async () => {
    const work = new GatewayConnectionWork();
    const failure = new Error("connection cleanup failed");
    await expect(
      work.trackCleanup(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    work.beginClose();
    await expect(work.drain()).rejects.toMatchObject({ cause: failure });
    await expect(work.drain()).rejects.toMatchObject({ cause: failure });
  });

  it("allows clean shutdown after a handled request failure settles", async () => {
    const work = new GatewayConnectionWork();
    const failure = new Error("handled request failed");
    await expect(
      work.track(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    work.beginClose();
    await expect(work.drain()).resolves.toBeUndefined();
  });

  it("does not drain another Gateway generation's work", async () => {
    const first = new GatewayConnectionWork();
    const second = new GatewayConnectionWork();
    const gate = createDeferredCore();
    let settled = false;
    const pending = first.track(async () => {
      await gate.promise;
      settled = true;
    });
    try {
      second.beginClose();
      await second.drain();
      expect(settled).toBe(false);
    } finally {
      gate.resolve();
      first.beginClose();
      await first.drain();
      await pending;
    }
  });
});
