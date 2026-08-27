import { describe, expect, it, vi } from "vitest";
import { createBoundedProviderBinaryStream } from "./provider-binary-stream.js";

describe("createBoundedProviderBinaryStream", () => {
  it.each(["release", "overflow"] as const)(
    "settles %s before a retained response clone is released",
    async (kind) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
          },
          cancel,
        }),
      );
      const capture = response.clone();
      const expected = new Error(kind);
      const bounded = createBoundedProviderBinaryStream(response.body!, {
        maxBytes: kind === "overflow" ? 4 : 8,
        createOverflowError: () => expected,
        createReleaseError: () => expected,
      });
      const reader = bounded.stream.getReader();
      const operation = (async () => {
        await expect(reader.read()).resolves.toEqual({
          done: false,
          value: Uint8Array.from(kind === "overflow" ? [1, 2, 3, 4] : [1, 2, 3, 4, 5]),
        });
        if (kind === "overflow") {
          await expect(reader.read()).rejects.toBe(expected);
        }
        await bounded.release();
        await bounded.release();
      })().then(
        () => ({}),
        (error: unknown) => ({ error }),
      );
      try {
        const result = await Promise.race([
          operation,
          new Promise<undefined>((resolve) => {
            setImmediate(() => resolve(undefined));
          }),
        ]);
        expect(result).toEqual({});
        expect(response.body?.locked).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        await capture.body?.cancel();
        await operation;
        reader.releaseLock();
      }
      expect(cancel).toHaveBeenCalledExactlyOnceWith([expected, undefined]);
    },
  );

  it("delivers the fitting prefix, then cancels and releases on overflow", async () => {
    const cancel = vi.fn(async () => {});
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4, 5]));
      },
      cancel,
    });
    const overflowError = new Error("overflow");
    const bounded = createBoundedProviderBinaryStream(source, {
      maxBytes: 4,
      createOverflowError: () => overflowError,
      createReleaseError: () => new Error("released"),
    });
    const reader = bounded.stream.getReader();

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: Uint8Array.from([1, 2]),
    });
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: Uint8Array.from([3, 4]),
    });
    await expect(reader.read()).rejects.toBe(overflowError);

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(overflowError);
    expect(source.locked).toBe(false);
    await bounded.release();
    await bounded.release();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
