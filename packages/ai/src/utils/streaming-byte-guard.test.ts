import { describe, expect, it } from "vitest";
import { createSseByteGuard } from "./streaming-byte-guard.js";

async function settleWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("createSseByteGuard cancellation", () => {
  it("reports overflow without waiting for upstream cancellation", async () => {
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
      },
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const guard = createSseByteGuard(body.getReader(), { maxBytes: 1 });

    await expect(settleWithin(guard.read(), "overflow read")).rejects.toThrow(
      "SSE stream exceeds 1 bytes (received 2)",
    );
    expect(cancelStarted).toBe(true);
    expect(guard.overflowed()).toBe(true);
  });

  it("finishes explicit cancellation after handing cleanup upstream", async () => {
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const guard = createSseByteGuard(body.getReader(), { maxBytes: 1 });

    await expect(settleWithin(guard.cancel("done"), "explicit cancel")).resolves.toBeUndefined();
    expect(cancelStarted).toBe(true);
    expect(guard.cancelled()).toBe(true);
  });
});
