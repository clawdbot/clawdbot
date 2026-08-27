import { describe, expect, it, vi } from "vitest";
import { wrapGuardedBodyStream } from "./guarded-body-stream.js";

describe("wrapGuardedBodyStream", () => {
  it("releases the source reader lock after downstream cancellation", async () => {
    const cancel = vi.fn();
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });

    expect(source.locked).toBe(true);
    await wrapped.cancel("consumer stopped");

    expect(cancel).toHaveBeenCalledExactlyOnceWith("consumer stopped");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("releases guarded resources without waiting for an unread response clone", async () => {
    const response = new Response(new ReadableStream<Uint8Array>());
    const unreadClone = response.clone();
    const cleanup = vi.fn();
    const wrapped = wrapGuardedBodyStream({ body: response.body!, cleanup });
    const cancellation = wrapped.cancel("consumer stopped").then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce(), { timeout: 250 });
      expect(response.body!.locked).toBe(false);
    } finally {
      void unreadClone.body?.cancel().catch(() => undefined);
      await expect(cancellation).resolves.toEqual({ status: "resolved" });
    }
  });

  it("propagates downstream cancellation failure after releasing resources", async () => {
    const expected = new Error("source cancellation failed");
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      async cancel() {
        throw expected;
      },
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });

    await expect(wrapped.cancel("consumer stopped")).rejects.toBe(expected);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("releases the source reader lock after normal completion", async () => {
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("done"));
        controller.close();
      },
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });
    const reader = wrapped.getReader();

    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe("done");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("releases the source reader lock while preserving a read failure", async () => {
    const expected = new Error("source read failed");
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(expected);
      },
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });
    const reader = wrapped.getReader();

    await expect(reader.read()).rejects.toBe(expected);
    reader.releaseLock();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });
});
