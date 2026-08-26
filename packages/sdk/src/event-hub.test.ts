import { describe, expect, it } from "vitest";
import { EventHub } from "./event-hub.js";

describe("EventHub subscriber ownership", () => {
  it("isolates a failing filter from healthy event streams", async () => {
    const hub = new EventHub<string>();
    const failedStream = hub.stream(() => {
      throw new Error("subscriber filter failed");
    });
    const failed = failedStream[Symbol.asyncIterator]();
    const healthy = hub.stream()[Symbol.asyncIterator]();
    const failedRead = failed.next();
    const healthyRead = healthy.next();

    expect(() => hub.publish("first")).not.toThrow();
    await expect(failedRead).rejects.toThrow("subscriber filter failed");
    await expect(healthyRead).resolves.toEqual({ done: false, value: "first" });

    const nextHealthyRead = healthy.next();
    hub.publish("second");
    await expect(nextHealthyRead).resolves.toEqual({ done: false, value: "second" });
  });

  it("settles concurrent reads in event order", async () => {
    const hub = new EventHub<string>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();

    hub.publish("first");
    hub.publish("second");

    await expect(Promise.all([first, second])).resolves.toEqual([
      { done: false, value: "first" },
      { done: false, value: "second" },
    ]);
  });

  it("reserves a published event for the reader it wakes", async () => {
    const hub = new EventHub<string>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    const first = iterator.next();

    hub.publish("first");
    const second = iterator.next();
    hub.publish("second");

    await expect(Promise.all([first, second])).resolves.toEqual([
      { done: false, value: "first" },
      { done: false, value: "second" },
    ]);
  });

  it("settles every pending read when its iterator closes", async () => {
    const hub = new EventHub<string>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { done: true, value: undefined },
      { done: true, value: undefined },
    ]);
  });

  it("rejects every pending read when the hub closes with an error", async () => {
    const hub = new EventHub<string>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();

    hub.close(new Error("gateway event stream closed"));

    await expect(first).rejects.toThrow("gateway event stream closed");
    await expect(second).rejects.toThrow("gateway event stream closed");
  });

  it("does not yield buffered events after its iterator closes", async () => {
    const hub = new EventHub<string>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    hub.publish("stale");

    await iterator.return?.();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
