import { notifyLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "../../runtime/index.js";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";

// The idle watchdog polices provider silence, not consumer position: a
// consumer parked between next() calls must not leave a dead provider
// connection unpoliced, while provider activity and a settled producer keep
// a healthy or finished stream from being aborted.
describe("streamWithIdleTimeout parked consumer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a provider that goes silent while the consumer is parked between next() calls", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const baseFn: StreamFn = vi.fn((_model, _context, options) => {
      requestSignal = options?.signal;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "text_delta", contentIndex: 0, delta: "first" });
      return stream;
    });
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);
    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });

    // The consumer never calls next() again (parked in an event handler) while
    // the provider stays silent: the watchdog must still fire.
    await vi.advanceTimersByTimeAsync(49);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    await iterator.return?.();
  });

  it("keeps a parked consumer's stream alive while the provider reports activity", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const baseFn: StreamFn = vi.fn((_model, _context, options) => {
      requestSignal = options?.signal;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "text_delta", contentIndex: 0, delta: "first" });
      return stream;
    });
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);
    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });

    const heartbeat = setInterval(() => notifyLlmRequestActivity(requestSignal), 30);
    await vi.advanceTimersByTimeAsync(200);
    clearInterval(heartbeat);
    expect(onIdleTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    await iterator.return?.();
  });

  it("stops policing once the producer settles even if the consumer is parked", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const baseFn: StreamFn = vi.fn((_model, _context, options) => {
      requestSignal = options?.signal;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "text_delta", contentIndex: 0, delta: "first" });
      setTimeout(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first" }],
            api: "openai-responses",
            provider: "openai",
            model: "test",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
          },
        });
        stream.end();
      }, 10);
      return stream;
    });
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);
    const stream = wrapped(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      {} as Parameters<typeof baseFn>[2],
    ) as AssistantMessageEventStream;
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });

    // Producer finishes while the consumer has not drained the terminal event.
    await vi.advanceTimersByTimeAsync(500);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(false);
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: "done" } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
