import { describe, expect, it, vi } from "vitest";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

describe("readResponseBytesWithinLimit", () => {
  it("rejects Content-Length above the budget without reading the body", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }), {
      headers: { "Content-Length": "17" },
    });

    expect(await readResponseBytesWithinLimit(response, 16)).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
  });

  it("cancels an unknown-length stream when cumulative chunks exceed the budget", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          controller.enqueue(new Uint8Array(8));
        },
        cancel,
      }),
    );

    expect(await readResponseBytesWithinLimit(response, 16)).toBeNull();
    expect(reads).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects and cancels one oversized chunk without retaining it", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(17));
        },
        cancel,
      }),
    );

    expect(await readResponseBytesWithinLimit(response, 16)).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("combines a body only after every chunk fits", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(1, 2));
          controller.enqueue(Uint8Array.of(3, 4));
          controller.close();
        },
      }),
    );

    const bytes = await readResponseBytesWithinLimit(response, 4);
    expect(bytes && [...new Uint8Array(bytes)]).toEqual([1, 2, 3, 4]);
  });
});
