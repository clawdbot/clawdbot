import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  createFirstStreamEventAbortController,
  withFirstStreamEventTimeout,
} from "./stream-first-event-timeout.js";

function createNeverYieldingStream(onReturn?: () => void): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return new Promise<IteratorResult<unknown>>(() => {});
        },
        async return() {
          onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe("withFirstStreamEventTimeout", () => {
  it("fails when the first event never arrives", async () => {
    vi.useFakeTimers();
    try {
      const stream = withFirstStreamEventTimeout(createNeverYieldingStream(), {
        provider: "local",
        api: "openai-completions",
        model: "test-model",
        timeoutMs: 5,
        stage: "completions",
      });
      const iterator = stream[Symbol.asyncIterator]();
      const next = expect(iterator.next()).rejects.toThrow(
        /completions HTTP stream opened but did not deliver a first SSE event within 5ms after streaming headers \(first-event timeout\)/,
      );

      await vi.advanceTimersByTimeAsync(5);
      await next;
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls iterator return on first-event timeout", async () => {
    vi.useFakeTimers();
    try {
      const onReturn = vi.fn();
      const stream = withFirstStreamEventTimeout(createNeverYieldingStream(onReturn), {
        timeoutMs: 5,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const next = iterator.next().catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(5);
      await next;

      expect(onReturn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls iterator return when the consumer closes after the first event", async () => {
    const onReturn = vi.fn();
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: "first" };
          },
          async return() {
            onReturn();
            return { done: true, value: undefined };
          },
        };
      },
    };
    const stream = withFirstStreamEventTimeout(source, { timeoutMs: 5 });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
    await iterator.return?.();

    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("aborts the underlying request on first-event timeout", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn();
      const onTimeout = vi.fn();
      const stream = withFirstStreamEventTimeout(createNeverYieldingStream(), {
        timeoutMs: 5,
        abort,
        onTimeout,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const next = iterator.next().catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(5);
      const error = await next;

      expect(error).toBeInstanceOf(Error);
      expect(onTimeout).toHaveBeenCalledWith(error);
      expect(abort).toHaveBeenCalledWith(error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps oversized first-event timeouts before scheduling", async () => {
    vi.useFakeTimers();
    try {
      const stream = withFirstStreamEventTimeout(createNeverYieldingStream(), {
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const next = expect(iterator.next()).rejects.toThrow(
        new RegExp(`within ${MAX_TIMER_TIMEOUT_MS}ms`),
      );

      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
      await next;
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates parent aborts through derived first-event signals", () => {
    const parent = new AbortController();
    const firstEventAbort = createFirstStreamEventAbortController(parent.signal);

    parent.abort("run-timeout");

    expect(firstEventAbort.signal.aborted).toBe(true);
    expect(firstEventAbort.signal.reason).toBe("run-timeout");
    firstEventAbort.dispose();
  });

  it("passes through events after the first event without adding inter-event timing", async () => {
    async function* delayedSecondEvent() {
      yield "first";
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      yield "second";
    }

    vi.useFakeTimers();
    try {
      const stream = withFirstStreamEventTimeout(delayedSecondEvent(), { timeoutMs: 5 });
      const iterator = stream[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
      const second = iterator.next();
      await vi.advanceTimersByTimeAsync(50);
      await expect(second).resolves.toEqual({ done: false, value: "second" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the original stream when disabled", () => {
    const stream = createNeverYieldingStream();
    expect(withFirstStreamEventTimeout(stream, { timeoutMs: 0 })).toBe(stream);
    expect(withFirstStreamEventTimeout(stream, { timeoutMs: Number.NaN })).toBe(stream);
  });
});
