import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "../../../../test/helpers/run-node-script.js";
import { EventStream, getEventStreamCompletion } from "./event-stream.js";

function createNumberStream(): EventStream<number, number> {
  return new EventStream(
    (event) => event === -1,
    (event) => event,
  );
}

describe("EventStream", () => {
  it("releases consumed events while retaining unread events and the final result", async ({
    signal,
  }) => {
    const result = await runNodeScript(
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./event-stream.retention.test-support.ts", import.meta.url)),
      ],
      { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
      15_000,
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        signal,
        maxBuffer: 64 * 1024,
        requireProcessTreeExit: process.platform !== "win32",
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { completed: false, consumedRetained: false, finalRetained: false },
      { completed: true, consumedRetained: false, finalRetained: true },
    ]);
  }, 30_000);

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

    const prefix: IteratorResult<number>[] = [];
    for (let value = 0; value < 1024; value += 1) {
      prefix.push(await iterator.next());
    }
    expect(prefix).toEqual(Array.from({ length: 1024 }, (_, value) => ({ value, done: false })));
    const queueState = stream as unknown as { queue: number[]; queueHead: number };
    expect(queueState.queueHead).toBe(0);
    expect(queueState.queue).toHaveLength(1024);

    for (let value = 2048; value < 2052; value += 1) {
      stream.push(value);
    }
    stream.end();
    const remaining: IteratorResult<number>[] = [];
    for (let value = 1024; value < 2052; value += 1) {
      remaining.push(await iterator.next());
    }
    expect(remaining).toEqual(
      Array.from({ length: 1028 }, (_, index) => ({ value: index + 1024, done: false })),
    );
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("resolves result() from a terminal event and from an explicit end(result)", async () => {
    const terminal = createNumberStream();
    terminal.push(-1);
    terminal.end();
    await expect(terminal.result()).resolves.toBe(-1);
    await expect(getEventStreamCompletion(terminal)).resolves.toBe(-1);

    const explicit = createNumberStream();
    explicit.push(7);
    explicit.end(42);
    await expect(explicit.result()).resolves.toBe(42);
    await expect(getEventStreamCompletion(explicit)).resolves.toBe(42);
  });

  it("rejects result() when the stream ends without a terminal event or explicit result", async () => {
    const stream = createNumberStream();
    stream.push(1);
    stream.end();
    // result() awaiters previously hung forever on this producer bug; the
    // contract now surfaces it loudly.
    await expect(stream.result()).rejects.toThrow(
      "event stream ended without a terminal event or final result",
    );
    await expect(getEventStreamCompletion(stream)).rejects.toThrow(
      "event stream ended without a terminal event or final result",
    );
    // Iterate-only consumption of the same stream still completes normally.
    const events: number[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events).toEqual([1]);
  });

  it("keeps iterate-only consumers free of unhandled rejections on bare end()", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const stream = createNumberStream();
      stream.push(1);
      stream.end();
      const iterator = stream[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ value: 1, done: false });
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
      // Give the microtask queue a chance to surface any unhandled rejection.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
