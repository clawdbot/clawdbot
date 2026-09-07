import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createBoundedProviderBinaryStream } from "./provider-binary-stream.js";

describe("createBoundedProviderBinaryStream", () => {
  it("shares finalization when source cancellation reenters release", async () => {
    const reentered: Promise<void>[] = [];
    const cancel = vi.fn(() => {
      reentered.push(bounded.release());
    });
    const cleanup = vi.fn(async () => {});
    const source = new ReadableStream<Uint8Array>({ cancel });
    const bounded = createBoundedProviderBinaryStream(source, {
      maxBytes: 8,
      createOverflowError: () => new Error("overflow"),
      createReleaseError: () => new Error("released"),
      cleanup,
    });
    await bounded.release();
    await Promise.all(reentered);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it.each(["eof", "error"] as const)(
    "unlocks on %s and keeps request cleanup with explicit release",
    async (ending) => {
      const failure = new Error("read failed");
      const cancel = vi.fn();
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          if (ending === "eof") {
            controller.close();
          } else {
            controller.error(failure);
          }
        },
        cancel,
      });
      const cleanup = vi.fn(async () => {});
      const bounded = createBoundedProviderBinaryStream(source, {
        maxBytes: 8,
        createOverflowError: () => new Error("overflow"),
        createReleaseError: () => new Error("released"),
        cleanup,
      });
      const reader = bounded.stream.getReader();
      try {
        if (ending === "eof") {
          await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
        } else {
          await expect(reader.read()).rejects.toBe(failure);
        }
        expect(source.locked).toBe(false);
        expect(cleanup).not.toHaveBeenCalled();
        await bounded.release();
        await bounded.release();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        reader.releaseLock();
        await bounded.release();
      }
    },
  );

  it.each(
    (["cancel", "release"] as const).flatMap((operation) =>
      [false, true].flatMap((cancelRejects) =>
        [false, true].map((cleanupRejects) => ({ operation, cancelRejects, cleanupRejects })),
      ),
    ),
  )(
    "settles $operation after source and request cleanup (cancel rejects: $cancelRejects, cleanup rejects: $cleanupRejects)",
    async ({ operation, cancelRejects, cleanupRejects }) => {
      const canceled = createDeferredCore();
      const cleaned = createDeferredCore();
      const reason = new Error("stop playback");
      const cancelError = new Error("source cancellation failed");
      const cleanupError = new Error("request cleanup failed");
      const cancel = vi.fn(() => canceled.promise);
      const source = new ReadableStream<Uint8Array>({ cancel });
      const cleanup = vi.fn(async () => {
        expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
        expect(source.locked).toBe(false);
        await cleaned.promise;
      });
      const options = {
        maxBytes: 8,
        createOverflowError: () => new Error("overflow"),
        createReleaseError: () => reason,
        cleanup,
      };
      const bounded = createBoundedProviderBinaryStream(source, options);
      let settled = false;
      const result = (
        operation === "cancel" ? bounded.stream.cancel(reason) : bounded.release()
      ).then(
        () => {
          settled = true;
          return {};
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        await waitForImmediate();
        expect(settled).toBe(false);
        expect(cleanup).toHaveBeenCalledOnce();
        if (cancelRejects) {
          canceled.reject(cancelError);
        } else {
          canceled.resolve();
        }
        await waitForImmediate();
        expect(settled).toBe(false);
        if (cleanupRejects) {
          cleaned.reject(cleanupError);
        } else {
          cleaned.resolve();
        }
        const observed = await result;
        const expectedError = cleanupRejects
          ? cleanupError
          : operation === "cancel" && cancelRejects
            ? cancelError
            : undefined;
        if (expectedError) {
          expect("error" in observed && observed.error).toBe(expectedError);
        } else {
          expect(observed).toEqual({});
        }
        await bounded.release().catch(() => undefined);
        await bounded.release().catch(() => undefined);
        expect(cancel).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
      } finally {
        canceled.resolve();
        cleaned.resolve();
        await result;
        await bounded.release().catch(() => undefined);
      }
    },
  );

  it.each(
    (["cancel", "release"] as const).flatMap((first) =>
      [false, true].map((cleanupRejects) => ({ first, cleanupRejects })),
    ),
  )(
    "shares cleanup when $first starts first but waits for source cancellation (cleanup rejects: $cleanupRejects)",
    async ({ first, cleanupRejects }) => {
      const canceled = createDeferredCore();
      const reason = new Error("stop playback");
      const cancelError = new Error("source cancellation failed");
      const cleanupError = new Error("request cleanup failed");
      const cancel = vi.fn(() => canceled.promise);
      const source = new ReadableStream<Uint8Array>({ cancel });
      const cleanup = vi.fn(async () => {
        if (cleanupRejects) {
          throw cleanupError;
        }
      });
      const options = {
        maxBytes: 8,
        createOverflowError: () => new Error("overflow"),
        createReleaseError: () => reason,
        cleanup,
      };
      const bounded = createBoundedProviderBinaryStream(source, options);
      const earlyCancel = first === "cancel" ? bounded.stream.cancel(reason) : undefined;
      const pendingRelease = bounded.release();
      const pendingCancel = earlyCancel ?? bounded.stream.cancel(reason);
      let settled = false;
      const results = Promise.allSettled([pendingCancel, pendingRelease]).then((result) => {
        settled = true;
        return result;
      });
      try {
        await waitForImmediate();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        expect(source.locked).toBe(false);
        canceled.reject(cancelError);
        const [cancellation, release] = await results;
        expect(cancellation.status === "rejected" && cancellation.reason).toBe(
          cleanupRejects ? cleanupError : cancelError,
        );
        if (cleanupRejects) {
          expect(release.status === "rejected" && release.reason).toBe(cleanupError);
        } else {
          expect(release).toEqual({ status: "fulfilled", value: undefined });
        }
        expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
        expect(cleanup).toHaveBeenCalledOnce();
      } finally {
        canceled.resolve();
        await results;
        await bounded.release().catch(() => undefined);
      }
    },
  );

  it("delivers overflow before delayed cleanup and preserves its later release failure", async () => {
    const cleaned = createDeferredCore();
    const overflow = new Error("overflow");
    const cleanupError = new Error("request cleanup failed");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
      },
      cancel: async () => {
        throw new Error("best-effort source cancellation failed");
      },
    });
    const cleanup = vi.fn(() => cleaned.promise);
    const options = {
      maxBytes: 4,
      createOverflowError: () => overflow,
      createReleaseError: () => new Error("released"),
      cleanup,
    };
    const bounded = createBoundedProviderBinaryStream(source, options);
    const reader = bounded.stream.getReader();
    try {
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: Uint8Array.from([1, 2, 3, 4]),
      });
      await expect(reader.read()).rejects.toBe(overflow);
      expect(cleanup).toHaveBeenCalledOnce();
      let settled = false;
      const released = bounded.release().finally(() => {
        settled = true;
      });
      void released.catch(() => undefined);
      await waitForImmediate();
      expect(settled).toBe(false);
      cleaned.reject(cleanupError);
      await expect(released).rejects.toBe(cleanupError);
      expect(source.locked).toBe(false);
    } finally {
      cleaned.resolve();
      reader.releaseLock();
      await bounded.release().catch(() => undefined);
    }
  });

  it.each(["release", "overflow"] as const)(
    "settles %s by releasing a retained response clone through request cleanup",
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
      const cleanup = vi.fn(async () => {
        await capture.body?.cancel();
      });
      const bounded = createBoundedProviderBinaryStream(response.body!, {
        maxBytes: kind === "overflow" ? 4 : 8,
        createOverflowError: () => expected,
        createReleaseError: () => expected,
        cleanup,
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
        expect(cleanup).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
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
      cleanup: async () => {},
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
