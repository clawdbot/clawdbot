// Covers abort signal wait helpers.
import { describe, expect, it } from "vitest";
import {
  createAbortError,
  isAbortError,
  mergeAbortSignals,
  waitForAbortSignal,
} from "./abort-signal.js";

describe("abort errors", () => {
  it("creates a named error with an optional cause", () => {
    const cause = { source: "caller" };
    const error = createAbortError("stopped", { cause });

    expect(error).toMatchObject({ name: "AbortError", message: "stopped", cause });
  });

  it("detects standard and legacy Node abort errors", () => {
    expect(isAbortError(createAbortError("aborted"))).toBe(true);
    expect(isAbortError({ name: "AbortError", message: "test" })).toBe(true);
    expect(isAbortError(new Error("This operation was aborted"))).toBe(true);
  });

  it.each([
    null,
    undefined,
    "string error",
    42,
    new Error("Operation aborted"),
    new Error("aborted"),
    new Error("Request was aborted"),
  ])("rejects non-abort input %#", (value) => {
    expect(isAbortError(value)).toBe(false);
  });
});

describe("mergeAbortSignals", () => {
  it("returns no signal or the single input without listeners", () => {
    const controller = new AbortController();
    expect(mergeAbortSignals([]).signal).toBeUndefined();
    expect(mergeAbortSignals([undefined, controller.signal]).signal).toBe(controller.signal);
  });

  it("uses input order when multiple inputs are already aborted", () => {
    const first = new AbortController();
    const second = new AbortController();
    first.abort("first");
    second.abort("second");

    const merged = mergeAbortSignals([first.signal, second.signal]);

    expect(merged.signal?.aborted).toBe(true);
    expect(merged.signal?.reason).toBe("first");
  });

  it("preserves the first later abort reason and releases every listener", () => {
    const makeSignal = () => {
      const listeners = new Set<() => void>();
      const signal = {
        aborted: false,
        reason: undefined as unknown,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      } as unknown as AbortSignal;
      return {
        signal,
        listeners,
        abort: (reason: unknown) => {
          Object.assign(signal, { aborted: true, reason });
          // Snapshot before callbacks remove themselves from the listener set.
          for (const listener of Array.from(listeners)) {
            listener();
          }
        },
      };
    };
    const first = makeSignal();
    const second = makeSignal();
    const merged = mergeAbortSignals([first.signal, second.signal]);
    const reason = new Error("second stopped");

    second.abort(reason);

    expect(merged.signal?.reason).toBe(reason);
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(0);
  });

  it("releases listeners when disposed before an abort", () => {
    const first = new AbortController();
    const second = new AbortController();
    const removed: AbortSignal[] = [];
    for (const signal of [first.signal, second.signal]) {
      const remove = signal.removeEventListener.bind(signal);
      signal.removeEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        removed.push(signal);
        remove(type, listener);
      }) as AbortSignal["removeEventListener"];
    }

    const merged = mergeAbortSignals([first.signal, second.signal]);
    merged.dispose();
    merged.dispose();

    expect(removed).toEqual([first.signal, second.signal]);
    expect(merged.signal?.aborted).toBe(false);
  });
});

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
