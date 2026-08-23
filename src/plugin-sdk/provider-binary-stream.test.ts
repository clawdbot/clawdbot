import { describe, expect, it, vi } from "vitest";
import { createBoundedProviderBinaryStream } from "./provider-binary-stream.js";

describe("createBoundedProviderBinaryStream", () => {
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
