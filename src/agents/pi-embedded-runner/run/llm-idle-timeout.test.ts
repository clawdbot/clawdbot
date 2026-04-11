import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  DEFAULT_LLM_IDLE_TIMEOUT_MS,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";

describe("resolveLlmIdleTimeoutMs", () => {
  it("returns default when config is undefined", () => {
    expect(resolveLlmIdleTimeoutMs()).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns default when llm config is missing", () => {
    const cfg = { agents: {} } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns default when idleTimeoutSeconds is not set", () => {
    const cfg = { agents: { defaults: { llm: {} } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns 0 when idleTimeoutSeconds is 0 (disabled)", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 0 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(0);
  });

  it("returns configured value in milliseconds", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 30 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(30_000);
  });

  it("caps at max safe timeout", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 10_000_000 } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(2_147_000_000);
  });

  it("ignores negative values", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: -10 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("ignores non-finite values", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: Infinity } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("falls back to agents.defaults.timeoutSeconds when llm.idleTimeoutSeconds is not set", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 300 } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(300_000);
  });

  it("uses an explicit run timeout override when llm.idleTimeoutSeconds is not set", () => {
    expect(resolveLlmIdleTimeoutMs({ runTimeoutMs: 900_000 })).toBe(900_000);
  });

  it("disables the idle watchdog when an explicit run timeout disables timeouts", () => {
    expect(resolveLlmIdleTimeoutMs({ runTimeoutMs: 2_147_000_000 })).toBe(0);
  });

  it("prefers llm.idleTimeoutSeconds over agents.defaults.timeoutSeconds", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 300, llm: { idleTimeoutSeconds: 120 } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(120_000);
  });

  it("prefers llm.idleTimeoutSeconds over an explicit run timeout override", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 120 } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, runTimeoutMs: 900_000 })).toBe(120_000);
  });

  it("keeps idleTimeoutSeconds=0 disabled even when timeoutSeconds is set", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 300, llm: { idleTimeoutSeconds: 0 } } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(0);
  });

  it("disables the default idle timeout for cron when no timeout is configured", () => {
    expect(resolveLlmIdleTimeoutMs({ trigger: "cron" })).toBe(0);

    const cfg = { agents: { defaults: { llm: {} } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(0);
  });

  it("uses agents.defaults.timeoutSeconds for cron before disabling the default idle timeout", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 300 } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(300_000);
  });

  it("keeps an explicit cron idle timeout when configured", () => {
    const cfg = { agents: { defaults: { llm: { idleTimeoutSeconds: 45 } } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(45_000);
  });
});

describe("streamWithIdleTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to create a mock async iterable
  function createMockAsyncIterable<T>(chunks: T[]): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (index < chunks.length) {
              return { done: false, value: chunks[index++] };
            }
            return { done: true, value: undefined };
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  it("wraps stream function", () => {
    const mockStream = createMockAsyncIterable([]);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);
    expect(typeof wrapped).toBe("function");
  });

  it("passes through model, context, and options", async () => {
    const mockStream = createMockAsyncIterable([]);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);

    const model = { api: "openai" } as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    void wrapped(model, context, options);

    expect(baseFn).toHaveBeenCalledWith(model, context, options);
  });

  it("throws on idle timeout", async () => {
    vi.useFakeTimers();
    // Create a stream that never yields
    const slowStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            // Never resolves - simulates hung LLM
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        };
      },
    };

    const baseFn = vi.fn().mockReturnValue(slowStream);
    const wrapped = streamWithIdleTimeout(baseFn, 50); // 50ms timeout

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    const next = expect(iterator.next()).rejects.toThrow(/LLM idle timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await next;
  });

  it("resets timer on each chunk", async () => {
    const chunks = [{ text: "a" }, { text: "b" }, { text: "c" }];
    const mockStream = createMockAsyncIterable(chunks);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const results: unknown[] = [];

    for await (const chunk of stream) {
      results.push(chunk);
    }

    expect(results).toHaveLength(3);
    expect(results).toEqual(chunks);
  });

  it("handles stream with delays between chunks", async () => {
    vi.useFakeTimers();
    // Create a stream with small delays
    const delayedStream: AsyncIterable<{ text: string }> = {
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next() {
            if (count < 3) {
              await new Promise((r) => setTimeout(r, 10)); // 10ms delay
              return { done: false, value: { text: String(count++) } };
            }
            return { done: true, value: undefined };
          },
        };
      },
    };

    const baseFn = vi.fn().mockReturnValue(delayedStream);
    const wrapped = streamWithIdleTimeout(baseFn, 100); // 100ms timeout - should be enough

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<{ text: string }>;
    const results: { text: string }[] = [];

    const collect = (async () => {
      for await (const chunk of stream) {
        results.push(chunk);
      }
    })();

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10);
    }
    await collect;

    expect(results).toHaveLength(3);
  });

  it("calls timeout hook on idle timeout", async () => {
    vi.useFakeTimers();
    // Create a stream that never yields
    const slowStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            // Never resolves - simulates hung LLM
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        };
      },
    };

    const baseFn = vi.fn().mockReturnValue(slowStream);
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout); // 50ms timeout

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    const next = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    const error = await next;

    // Verify the error message is preserved
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/LLM idle timeout/);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    const [timeoutError] = onIdleTimeout.mock.calls[0] ?? [];
    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toMatch(/LLM idle timeout/);
  });
});
