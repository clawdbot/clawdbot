import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { EventHub } from "./event-hub.js";

describe("EventHub subscriber ownership", () => {
  it("releases retired iterator payloads without discarding a closed hub's unread event", async ({
    signal,
  }) => {
    const result = await runNodeScript(
      [
        "--expose-gc",
        "--import",
        "./scripts/tsx.mjs",
        fileURLToPath(new URL("./event-hub.retention.test-support.ts", import.meta.url)),
      ],
      { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
      15_000,
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        signal,
        maxBuffer: 64 * 1024,
        requireProcessTreeExit: process.platform !== "win32",
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      verdict: "passed",
      controlRetained: false,
      hubCloseDrained: true,
      cleanupErrors: [],
    });
  }, 30_000);

  it("keeps buffered bursts ordered when publishing resumes during a partial drain", async () => {
    const hub = new EventHub<number | undefined>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    const first = Array.from({ length: 4097 }, (_, index) => (index % 17 ? index : undefined));
    const second = Array.from({ length: 2051 }, (_, index) => index + 4097);
    for (const event of first) {
      hub.publish(event);
    }

    const seen: Array<number | undefined> = [];
    for (let index = 0; index < 2500; index++) {
      const event = await iterator.next();
      expect(event.done).toBe(false);
      seen.push(event.value);
    }
    for (const event of second) {
      hub.publish(event);
    }
    hub.close();
    while (true) {
      const event = await iterator.next();
      if (event.done) {
        break;
      }
      seen.push(event.value);
    }

    expect(seen).toEqual([...first, ...second]);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("drains undefined payloads before propagating an explicit undefined close error", async () => {
    const hub = new EventHub<number | undefined>();
    const iterator = hub.stream()[Symbol.asyncIterator]();
    hub.publish(0);
    hub.publish(undefined);
    hub.close(undefined);

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 0 });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: undefined });
    await expect(iterator.next()).rejects.toBeUndefined();
  });

  it("preserves nested publish order when a subscriber filter emits another event", async () => {
    const hub = new EventHub<string>();
    const filteredStream = hub.stream((event) => {
      if (event === "outer") {
        hub.publish("inner");
      }
      return true;
    });
    const filtered = filteredStream[Symbol.asyncIterator]();
    const healthy = hub.stream()[Symbol.asyncIterator]();
    hub.publish("outer");
    hub.close();

    for (const iterator of [filtered, healthy]) {
      await expect(iterator.next()).resolves.toEqual({ done: false, value: "inner" });
      await expect(iterator.next()).resolves.toEqual({ done: false, value: "outer" });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    }
  });

  it("isolates a failing filter from healthy event streams", async () => {
    const hub = new EventHub<string>();
    const failedStream = hub.stream(() => {
      throw new Error("subscriber filter failed");
    });
    const failed = failedStream[Symbol.asyncIterator]();
    const healthy = hub.stream()[Symbol.asyncIterator]();
    const failedRead = failed.next();
    const healthyRead = healthy.next();

    hub.publish("first");
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
