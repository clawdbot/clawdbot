// Covers abort signal wait helpers.
import { describe, expect, it } from "vitest";
import { waitForAbortSignal } from "./abort-signal.js";

describe("waitForAbortSignal", () => {
  it("resolves immediately when signal is missing", async () => {
    await expect(waitForAbortSignal(undefined)).resolves.toBeUndefined();
  });

  it("resolves immediately when signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(waitForAbortSignal(abort.signal)).resolves.toBeUndefined();
  });

  it("waits until abort fires", async () => {
    const abort = new AbortController();
    let resolved = false;

    const task = waitForAbortSignal(abort.signal).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(resolved).toBe(true);
  });

  it("registers and removes the abort listener exactly once", async () => {
    let handler: (() => void) | undefined;
    const addEventListener = (
      _type: string,
      listener: () => void,
      options?: AddEventListenerOptions,
    ) => {
      handler = listener;
      expect(options).toEqual({ once: true });
    };
    const removeEventListener = (_type: string, listener: () => void) => {
      expect(listener).toBe(handler);
      removed += 1;
    };
    let removed = 0;

    const task = waitForAbortSignal({
      aborted: false,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal);

    expect(handler).toBeTypeOf("function");
    handler?.();
    await expect(task).resolves.toBeUndefined();
    expect(removed).toBe(1);
  });
});
