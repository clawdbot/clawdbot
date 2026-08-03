import { describe, expect, it } from "vitest";
import { EventStream } from "./event-stream.js";

function createNumberStream(): EventStream<number, number> {
  return new EventStream(
    (event) => event === -1,
    (event) => event,
  );
}

describe("EventStream", () => {
  it("preserves interleaved queued and waiting push/pull order", async () => {
    const stream = createNumberStream();
    const iterator = stream[Symbol.asyncIterator]();

    stream.push(1);
    expect(await iterator.next()).toEqual({ value: 1, done: false });

    const waiting = iterator.next();
    stream.push(2);
    expect(await waiting).toEqual({ value: 2, done: false });

    stream.push(3);
    stream.end();
    expect(await iterator.next()).toEqual({ value: 3, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("compacts a consumed queue prefix at the cursor boundary without losing events", async () => {
    const stream = createNumberStream();
    const iterator = stream[Symbol.asyncIterator]();
    for (let value = 0; value < 2048; value += 1) {
      stream.push(value);
    }

    for (let value = 0; value < 1024; value += 1) {
      expect(await iterator.next()).toEqual({ value, done: false });
    }
    const queueState = stream as unknown as { queue: number[]; queueHead: number };
    expect(queueState.queueHead).toBe(0);
    expect(queueState.queue).toHaveLength(1024);

    for (let value = 2048; value < 2052; value += 1) {
      stream.push(value);
    }
    stream.end();
    for (let value = 1024; value < 2052; value += 1) {
      expect(await iterator.next()).toEqual({ value, done: false });
    }
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});
